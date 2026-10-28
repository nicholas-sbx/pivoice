package audio

import (
	"errors"
	"fmt"
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

func (*PortAudio) Devices() []DeviceDesc {
	devs, err := portaudio.Devices()
	if err != nil {
		return nil
	}
	h, _ := portaudio.DefaultHostApi()
	var out []DeviceDesc
	for _, d := range devs {
		// Only the default host API's devices: the same card under every API is just noise.
		if h != nil && d.HostApi != h {
			continue
		}
		out = append(out, DeviceDesc{
			ID:      deviceID(d),
			Name:    d.Name,
			Input:   d.MaxInputChannels > 0,
			Output:  d.MaxOutputChannels > 0,
			Default: h != nil && (d == h.DefaultInputDevice || d == h.DefaultOutputDevice),
		})
	}
	return out
}

func find(id string, input bool) (*portaudio.DeviceInfo, error) {
	h, err := portaudio.DefaultHostApi()
	if err != nil {
		return nil, err
	}
	if id != "" {
		devs, _ := portaudio.Devices()
		for _, d := range devs {
			if deviceID(d) == id && ((input && d.MaxInputChannels > 0) || (!input && d.MaxOutputChannels > 0)) {
				return d, nil
			}
		}
		// The saved device is gone: the default one.
	}
	if input {
		return h.DefaultInputDevice, nil
	}
	return h.DefaultOutputDevice, nil
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
func (*PortAudio) Open(inputID, outputID string, cb Callback) (Stream, error) {
	in, _ := find(inputID, true)
	out, _ := find(outputID, false)
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
	st.info = Info{Input: name(in), Output: name(out), InputLatencyMs: ms(si.InputLatency), OutputLatencyMs: ms(si.OutputLatency)}
	if h, err := portaudio.DefaultHostApi(); err == nil {
		st.info.API = h.Name
	}
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
