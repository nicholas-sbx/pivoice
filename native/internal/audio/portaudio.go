package audio

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"slices"
	"sync/atomic"
	"time"

	"github.com/gordonklaus/portaudio"
)

type PortAudio struct{}

func NewPortAudio() (*PortAudio, error) {
	if err := portaudio.Initialize(); err != nil {
		return nil, err
	}
	return &PortAudio{}, nil
}

func (*PortAudio) Close() { _ = portaudio.Terminate() }

func deviceID(d *portaudio.DeviceInfo) string { return d.HostApi.Name + ": " + d.Name }

// hostAPIs is where to look for devices, best first. On Windows that's not
// PortAudio's default: it picks MME, whose buffers alone are ~100 ms.
// WASAPI (shared mode) is the low-latency one; WDM-KS is the next best
// if WASAPI won't open (it can't resample, so a device that isn't running
// at 48 kHz refuses it), and MME is the last resort that opens anything.
// Everywhere else the default is the right one (ALSA, CoreAudio).
func hostAPIs() []*portaudio.HostApiInfo {
	var out []*portaudio.HostApiInfo
	if runtime.GOOS == "windows" {
		for _, t := range []portaudio.HostApiType{portaudio.WASAPI, portaudio.WDMkS, portaudio.MME} {
			if h, err := portaudio.HostApi(t); err == nil && h != nil && len(h.Devices) > 0 {
				out = append(out, h)
			}
		}
	}
	if h, err := portaudio.DefaultHostApi(); err == nil && h != nil && !slices.Contains(out, h) {
		out = append(out, h)
	}
	return out
}

func (*PortAudio) Devices() []DeviceDesc {
	apis := hostAPIs()
	if len(apis) == 0 {
		return nil
	}
	// Only the best host API's devices: the same card under every API is just noise.
	h := apis[0]
	var out []DeviceDesc
	for _, d := range h.Devices {
		out = append(out, DeviceDesc{
			ID:      deviceID(d),
			Name:    d.Name,
			Input:   d.MaxInputChannels > 0,
			Output:  d.MaxOutputChannels > 0,
			Default: d == h.DefaultInputDevice || d == h.DefaultOutputDevice,
		})
	}
	return out
}

// find the device with this ID under this host API, or its default one
// (when there's no ID, it's gone, or it belongs to another API).
func find(h *portaudio.HostApiInfo, id string, input bool) *portaudio.DeviceInfo {
	if id != "" {
		for _, d := range h.Devices {
			if deviceID(d) == id && ((input && d.MaxInputChannels > 0) || (!input && d.MaxOutputChannels > 0)) {
				return d
			}
		}
	}
	if input {
		return h.DefaultInputDevice
	}
	return h.DefaultOutputDevice
}

type paStream struct {
	s     *portaudio.Stream
	info  Info
	block atomic.Int32
}

func (p *paStream) Info() Info {
	i := p.info
	i.Block = int(p.block.Load())
	return i
}

func (p *paStream) Close() error {
	_ = p.s.Abort()
	return p.s.Close()
}

// Open a duplex stream with PortAudio's low-latency parameters: the
// device's own smallest suggested latency, and whatever block size it
// likes best (asking for a fixed one makes PortAudio buffer to match).
// Without a mic it opens output only, and without speakers input only.
// Tries each host API in turn (see hostAPIs) until one opens.
func (*PortAudio) Open(inputID, outputID string, cb Callback) (Stream, error) {
	var errs []error
	for _, h := range hostAPIs() {
		s, err := open(h, inputID, outputID, cb)
		if err == nil {
			return s, nil
		}
		log.Printf("audio: %s: %v", h.Name, err)
		errs = append(errs, fmt.Errorf("%s: %w", h.Name, err))
	}
	if len(errs) == 0 {
		return nil, errors.New("no audio devices")
	}
	return nil, errors.Join(errs...)
}

func open(h *portaudio.HostApiInfo, inputID, outputID string, cb Callback) (Stream, error) {
	in := find(h, inputID, true)
	out := find(h, outputID, false)
	if in == nil && out == nil {
		return nil, errors.New("no audio devices")
	}
	p := portaudio.LowLatencyParameters(in, out)
	p.SampleRate = SampleRate
	outCh := 0
	if out != nil {
		outCh = min(2, out.MaxOutputChannels)
		p.Output.Channels = outCh
	}
	if in != nil {
		p.Input.Channels = 1
	}
	st := &paStream{}
	stereo := make([]float32, 0, 8192)
	silence := make([]float32, 0, 4096)
	call := func(inBuf, outBuf []float32, ti portaudio.StreamCallbackTimeInfo, _ portaudio.StreamCallbackFlags) {
		now := time.Now()
		var frames int
		switch {
		case outCh > 0:
			frames = len(outBuf) / outCh
		default:
			frames = len(inBuf)
		}
		st.block.Store(int32(frames))
		if inBuf == nil {
			if cap(silence) < frames {
				silence = make([]float32, frames)
			}
			inBuf = silence[:frames]
		}
		t := times(now, ti, st.info)
		switch outCh {
		case 2:
			cb(inBuf, outBuf, t)
		case 1:
			// A mono device: mix the stereo down.
			if cap(stereo) < 2*frames {
				stereo = make([]float32, 2*frames)
			}
			s := stereo[:2*frames]
			cb(inBuf, s, t)
			for i := range outBuf {
				outBuf[i] = (s[2*i] + s[2*i+1]) / 2
			}
		default:
			if cap(stereo) < 2*frames {
				stereo = make([]float32, 2*frames)
			}
			cb(inBuf, stereo[:2*frames], t)
		}
	}
	var s *portaudio.Stream
	var err error
	switch {
	case in != nil && out != nil:
		s, err = portaudio.OpenStream(p, call)
	case in != nil:
		s, err = portaudio.OpenStream(p, func(inBuf []float32, ti portaudio.StreamCallbackTimeInfo, f portaudio.StreamCallbackFlags) {
			call(inBuf, nil, ti, f)
		})
	default:
		s, err = portaudio.OpenStream(p, func(outBuf []float32, ti portaudio.StreamCallbackTimeInfo, f portaudio.StreamCallbackFlags) {
			call(nil, outBuf, ti, f)
		})
	}
	if err != nil {
		return nil, fmt.Errorf("opening %s / %s: %w", name(in), name(out), err)
	}
	st.s = s
	si := s.Info()
	st.info = Info{Input: name(in), Output: name(out), API: h.Name, InputLatencyMs: ms(si.InputLatency), OutputLatencyMs: ms(si.OutputLatency)}
	if err := s.Start(); err != nil {
		_ = s.Close()
		return nil, err
	}
	return st, nil
}

// When this block meets the air. PortAudio's stream times where the host
// API has them; otherwise (some ALSA setups report zeros) the latencies
// the stream was opened with.
func times(now time.Time, ti portaudio.StreamCallbackTimeInfo, info Info) Times {
	wall := epochMs(now)
	if ti.CurrentTime > 0 && ti.InputBufferAdcTime > 0 && ti.OutputBufferDacTime > 0 {
		return Times{
			InputMs:  wall - ms(ti.CurrentTime-ti.InputBufferAdcTime),
			OutputMs: wall + ms(ti.OutputBufferDacTime-ti.CurrentTime),
		}
	}
	return Times{InputMs: wall - info.InputLatencyMs, OutputMs: wall + info.OutputLatencyMs}
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

func name(d *portaudio.DeviceInfo) string {
	if d == nil {
		return ""
	}
	return d.Name
}
