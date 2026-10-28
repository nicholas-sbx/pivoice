package audio

/*
#cgo pkg-config: portaudio-2.0
#include <stdint.h>
#include <string.h>
#include <portaudio.h>
#ifdef _WIN32
#include <pa_win_wasapi.h>
#endif

extern void pvCallback(uintptr_t id, float *in, float *out, unsigned long frames, double adc, double now, double dac, unsigned long flags);

// One block, straight to Go: no copies, nothing allocated.
static int pv_cb(const void *in, void *out, unsigned long frames, const PaStreamCallbackTimeInfo *ti, PaStreamCallbackFlags flags, void *user) {
	pvCallback((uintptr_t)user, (float *)in, (float *)out, frames,
		ti ? ti->inputBufferAdcTime : 0, ti ? ti->currentTime : 0, ti ? ti->outputBufferDacTime : 0, flags);
	return paContinue;
}

// wasapi: the devices are WASAPI ones, so ask for raw (no Windows effects
// on the mic: our own processing or none), pro-audio thread priority, and
// exclusive mode if wanted.
static PaError pv_open(PaStream **s, int in, int inCh, double inLat, int out, int outCh, double outLat,
		double rate, int wasapi, int exclusive, int raw, uintptr_t id) {
	PaStreamParameters ip, op;
	memset(&ip, 0, sizeof ip);
	memset(&op, 0, sizeof op);
#ifdef _WIN32
	PaWasapiStreamInfo wi, wo;
	memset(&wi, 0, sizeof wi);
	if (wasapi) {
		wi.size = sizeof wi;
		wi.hostApiType = paWASAPI;
		wi.version = 1;
		wi.flags = paWinWasapiThreadPriority | (exclusive ? paWinWasapiExclusive : 0);
		wi.threadPriority = eThreadPriorityProAudio;
		if (raw) wi.streamOption = eStreamOptionRaw;
	}
	wo = wi;
#endif
	if (in >= 0) {
		ip.device = in;
		ip.channelCount = inCh;
		ip.sampleFormat = paFloat32;
		ip.suggestedLatency = inLat;
#ifdef _WIN32
		if (wasapi) ip.hostApiSpecificStreamInfo = &wi;
#endif
	}
	if (out >= 0) {
		op.device = out;
		op.channelCount = outCh;
		op.sampleFormat = paFloat32;
		op.suggestedLatency = outLat;
#ifdef _WIN32
		if (wasapi) op.hostApiSpecificStreamInfo = &wo;
#endif
	}
	return Pa_OpenStream(s, in >= 0 ? &ip : NULL, out >= 0 ? &op : NULL, rate,
		paFramesPerBufferUnspecified, paNoFlag, pv_cb, (void *)id);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// PortAudio is the real sound card, through our own small binding: the
// callback hands Go PortAudio's buffers as they are (no reflection, no
// copies, nothing allocated per block, so the garbage collector has as
// little reason as possible to stop the audio thread), and on Windows it
// can pass WASAPI's own options, which the usual Go binding can't.
type PortAudio struct {
	// Windows: take the device for ourselves (WASAPI exclusive mode), for the smallest buffers it has.
	Exclusive atomic.Bool
}

// SetExclusive says whether to ask for exclusive mode from the next open, and whether that's a change.
func (p *PortAudio) SetExclusive(on bool) bool { return p.Exclusive.Swap(on) != on }

func NewPortAudio() (*PortAudio, error) {
	if err := paErr(C.Pa_Initialize()); err != nil {
		return nil, err
	}
	return &PortAudio{}, nil
}

func (*PortAudio) Close() { C.Pa_Terminate() }

func paErr(e C.PaError) error {
	if e == C.paNoError {
		return nil
	}
	return errors.New(C.GoString(C.Pa_GetErrorText(e)))
}

type paDevice struct {
	index  C.PaDeviceIndex
	name   string
	api    *paAPI
	maxIn  int
	maxOut int
	lowIn  float64
	lowOut float64
}

type paAPI struct {
	typ     C.PaHostApiTypeId
	name    string
	devices []*paDevice
	defIn   *paDevice
	defOut  *paDevice
}

func (d *paDevice) id() string { return d.api.name + ": " + d.name }

// apis lists the host APIs and their devices, as PortAudio has them now.
func apis() []*paAPI {
	var out []*paAPI
	n := int(C.Pa_GetHostApiCount())
	for i := 0; i < n; i++ {
		hi := C.Pa_GetHostApiInfo(C.PaHostApiIndex(i))
		if hi == nil {
			continue
		}
		a := &paAPI{typ: hi._type, name: C.GoString(hi.name)}
		for k := 0; k < int(hi.deviceCount); k++ {
			idx := C.Pa_HostApiDeviceIndexToDeviceIndex(C.PaHostApiIndex(i), C.int(k))
			di := C.Pa_GetDeviceInfo(idx)
			if di == nil {
				continue
			}
			d := &paDevice{
				index: idx, name: C.GoString(di.name), api: a,
				maxIn: int(di.maxInputChannels), maxOut: int(di.maxOutputChannels),
				lowIn: float64(di.defaultLowInputLatency), lowOut: float64(di.defaultLowOutputLatency),
			}
			a.devices = append(a.devices, d)
			if idx == hi.defaultInputDevice {
				a.defIn = d
			}
			if idx == hi.defaultOutputDevice {
				a.defOut = d
			}
		}
		out = append(out, a)
	}
	return out
}

// hostAPIs is where to look for devices, best first. On Windows that's not
// PortAudio's default: it picks MME, whose buffers alone are ~100 ms.
// WASAPI is the low-latency one; WDM-KS is the next best if WASAPI won't
// open (it doesn't resample, so a device that isn't at 48 kHz can refuse
// it), and MME is the last resort that opens anything. Everywhere else
// the default is the right one (ALSA, CoreAudio).
func hostAPIs() []*paAPI {
	all := apis()
	var out []*paAPI
	pick := func(t C.PaHostApiTypeId) {
		for _, a := range all {
			if a.typ == t && len(a.devices) > 0 {
				out = append(out, a)
			}
		}
	}
	if runtime.GOOS == "windows" {
		pick(C.paWASAPI)
		pick(C.paWDMKS)
		pick(C.paMME)
	}
	if def := C.Pa_GetDefaultHostApi(); def >= 0 {
		if hi := C.Pa_GetHostApiInfo(def); hi != nil {
			seen := false
			for _, a := range out {
				seen = seen || a.typ == hi._type
			}
			if !seen {
				pick(hi._type)
			}
		}
	}
	return out
}

func (*PortAudio) Devices() []DeviceDesc {
	list := hostAPIs()
	if len(list) == 0 {
		return nil
	}
	// Only the best host API's devices: the same card under every API is just noise.
	a := list[0]
	var out []DeviceDesc
	for _, d := range a.devices {
		out = append(out, DeviceDesc{ID: d.id(), Name: d.name, Input: d.maxIn > 0, Output: d.maxOut > 0, Default: d == a.defIn || d == a.defOut})
	}
	return out
}

// find the device with this ID under this host API, or its default one
// (when there's no ID, it's gone, or it belongs to another API).
func find(a *paAPI, id string, input bool) *paDevice {
	if id != "" {
		for _, d := range a.devices {
			if d.id() == id && ((input && d.maxIn > 0) || (!input && d.maxOut > 0)) {
				return d
			}
		}
	}
	if input {
		return a.defIn
	}
	return a.defOut
}

// ---- streams --------------------------------------------------------------

// Blocks bigger than this (samples) get silence rather than an allocation on the audio thread.
const maxBlock = 8192

type paStream struct {
	s     unsafe.Pointer // *C.PaStream
	id    int
	cb    Callback
	outCh int
	info  Info
	block atomic.Int32
	// Glitch counters (PortAudio's status flags), since the stream opened.
	inOver, outUnder atomic.Int64
	// The callback's own scratch, so nothing is allocated per block.
	stereo  []float32
	silence []float32
}

// The callback finds its stream by a small number rather than a Go
// pointer (C mustn't keep Go pointers): a fixed table, read without locks.
var (
	streamMu   sync.Mutex
	streamSlot [32]atomic.Pointer[paStream]
)

//export pvCallback
func pvCallback(id C.uintptr_t, in, out *C.float, frames C.ulong, adc, now, dac C.double, flags C.ulong) {
	st := streamSlot[int(id)%len(streamSlot)].Load()
	if st == nil {
		return
	}
	n := int(frames)
	st.block.Store(int32(n))
	if flags&C.paInputOverflow != 0 {
		st.inOver.Add(1)
	}
	if flags&C.paOutputUnderflow != 0 {
		st.outUnder.Add(1)
	}
	var outBuf []float32
	if out != nil {
		outBuf = unsafe.Slice((*float32)(unsafe.Pointer(out)), n*st.outCh)
	}
	if n > maxBlock {
		clear(outBuf)
		return
	}
	inBuf := st.silence[:n]
	if in != nil {
		inBuf = unsafe.Slice((*float32)(unsafe.Pointer(in)), n)
	}
	t := times(time.Now(), float64(adc), float64(now), float64(dac), st.info)
	if st.outCh == 2 {
		st.cb(inBuf, outBuf, t)
		return
	}
	s := st.stereo[:2*n]
	st.cb(inBuf, s, t)
	// A mono device: mix the stereo down (or nowhere, without speakers).
	for i := range outBuf {
		outBuf[i] = (s[2*i] + s[2*i+1]) / 2
	}
}

func (p *paStream) Info() Info {
	i := p.info
	i.Block = int(p.block.Load())
	i.InputOverflows = p.inOver.Load()
	i.OutputUnderflows = p.outUnder.Load()
	return i
}

func (p *paStream) Close() error {
	C.Pa_AbortStream(p.s)
	err := paErr(C.Pa_CloseStream(p.s))
	streamSlot[p.id].Store(nil)
	return err
}

// Open a duplex stream with each device's own lowest suggested latency,
// and whatever block size the device likes best (asking for a fixed one
// makes PortAudio buffer to match). Without a mic it opens output only,
// and without speakers input only. Tries each host API in turn (see
// hostAPIs), and on WASAPI the best mode first: exclusive if asked for,
// then shared and raw, then shared as Windows likes it.
func (p *PortAudio) Open(inputID, outputID string, cb Callback) (Stream, error) {
	type try struct {
		exclusive, raw bool
		mode           string
	}
	var errs []error
	for _, a := range hostAPIs() {
		tries := []try{{}}
		if a.typ == C.paWASAPI {
			tries = []try{{false, true, "shared, raw"}, {false, false, "shared"}}
			if p.Exclusive.Load() {
				tries = append([]try{{true, true, "exclusive"}}, tries...)
			}
		}
		for _, t := range tries {
			s, err := open(a, inputID, outputID, cb, t.exclusive, t.raw)
			if err == nil {
				s.info.Mode = t.mode
				return s, nil
			}
			what := a.name
			if t.mode != "" {
				what += " (" + t.mode + ")"
			}
			log.Printf("audio: %s: %v", what, err)
			errs = append(errs, fmt.Errorf("%s: %w", what, err))
		}
	}
	if len(errs) == 0 {
		return nil, errors.New("no audio devices")
	}
	return nil, errors.Join(errs...)
}

func open(a *paAPI, inputID, outputID string, cb Callback, exclusive, raw bool) (*paStream, error) {
	in := find(a, inputID, true)
	out := find(a, outputID, false)
	if in == nil && out == nil {
		return nil, errors.New("no audio devices")
	}
	streamMu.Lock()
	defer streamMu.Unlock()
	id := -1
	for i := range streamSlot {
		if streamSlot[i].Load() == nil {
			id = i
			break
		}
	}
	if id < 0 {
		return nil, errors.New("too many audio streams")
	}
	st := &paStream{id: id, cb: cb, stereo: make([]float32, 2*maxBlock), silence: make([]float32, maxBlock)}
	inIdx, outIdx := C.int(-1), C.int(-1)
	var inLat, outLat float64
	if in != nil {
		inIdx, inLat = C.int(in.index), in.lowIn
	}
	if out != nil {
		outIdx, outLat = C.int(out.index), out.lowOut
		st.outCh = min(2, out.maxOut)
	}
	// PaStream is a void typedef: cgo sees it as unsafe.Pointer.
	var s unsafe.Pointer
	// Registered before it opens: the callback can run the moment it starts.
	streamSlot[id].Store(st)
	e := C.pv_open(&s, inIdx, 1, C.double(inLat), outIdx, C.int(st.outCh), C.double(outLat), SampleRate,
		b2i(a.typ == C.paWASAPI), b2i(exclusive), b2i(raw), C.uintptr_t(id))
	if err := paErr(e); err != nil {
		streamSlot[id].Store(nil)
		return nil, fmt.Errorf("opening %s / %s: %w", name(in), name(out), err)
	}
	st.s = s
	st.info = Info{Input: name(in), Output: name(out), API: a.name}
	if si := C.Pa_GetStreamInfo(s); si != nil {
		st.info.InputLatencyMs = float64(si.inputLatency) * 1000
		st.info.OutputLatencyMs = float64(si.outputLatency) * 1000
	}
	if err := paErr(C.Pa_StartStream(s)); err != nil {
		C.Pa_CloseStream(s)
		streamSlot[id].Store(nil)
		return nil, err
	}
	return st, nil
}

func b2i(b bool) C.int {
	if b {
		return 1
	}
	return 0
}

// When this block meets the air. PortAudio's stream times where the host
// API has them; otherwise (some ALSA setups report zeros) the latencies
// the stream was opened with.
func times(now time.Time, adc, cur, dac float64, info Info) Times {
	wall := epochMs(now)
	if cur > 0 && adc > 0 && dac > 0 {
		return Times{InputMs: wall - (cur-adc)*1000, OutputMs: wall + (dac-cur)*1000}
	}
	return Times{InputMs: wall - info.InputLatencyMs, OutputMs: wall + info.OutputLatencyMs}
}

func name(d *paDevice) string {
	if d == nil {
		return ""
	}
	return d.name
}
