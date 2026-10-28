// Package dsp is the app's own processing of the microphone: echo
// cancellation (SpeexDSP), noise suppression (RNNoise) and automatic gain
// (ours). Each is off unless asked for, and costs nothing while it is.
package dsp

/*
#cgo pkg-config: speexdsp
#include <speex/speex_echo.h>
#include <speex/speex_preprocess.h>

static void pv_echo_setup(SpeexEchoState *e, SpeexPreprocessState *p, int rate) {
	speex_echo_ctl(e, SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
	// The preprocessor only mops up the echo the filter leaves behind:
	// noise suppression and gain are RNNoise's and ours.
	int off = 0;
	speex_preprocess_ctl(p, SPEEX_PREPROCESS_SET_DENOISE, &off);
	speex_preprocess_ctl(p, SPEEX_PREPROCESS_SET_AGC, &off);
	speex_preprocess_ctl(p, SPEEX_PREPROCESS_SET_ECHO_STATE, e);
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

const SampleRate = 48000

// EchoFrame is the echo canceller's frame: one 128-sample block, so it
// adds no buffering when the sound card works in those (it usually does).
const EchoFrame = 128

// EchoTail is how long an echo the filter can model: 85 ms, enough for the
// sound card's own round trip plus a room's.
const EchoTail = 4096

// Echo is SpeexDSP's acoustic echo canceller (MDF) and its residual echo
// suppressor. It gets the mic and what went to the speakers in the same
// block, from the same duplex callback, so the two are already lined up.
type Echo struct {
	e   *C.SpeexEchoState
	p   *C.SpeexPreprocessState
	rec [EchoFrame]C.spx_int16_t
	ref [EchoFrame]C.spx_int16_t
	out [EchoFrame]C.spx_int16_t
}

func NewEcho() (*Echo, error) {
	e := C.speex_echo_state_init(EchoFrame, EchoTail)
	if e == nil {
		return nil, errors.New("speex: no echo canceller")
	}
	p := C.speex_preprocess_state_init(EchoFrame, SampleRate)
	if p == nil {
		C.speex_echo_state_destroy(e)
		return nil, errors.New("speex: no preprocessor")
	}
	C.pv_echo_setup(e, p, SampleRate)
	return &Echo{e: e, p: p}, nil
}

// Process one frame: mic and ref (what played) in, mic minus the echo out. All EchoFrame long.
func (x *Echo) Process(mic, ref, out []float32) {
	for i := range EchoFrame {
		x.rec[i] = toInt16(mic[i])
		x.ref[i] = toInt16(ref[i])
	}
	C.speex_echo_cancellation(x.e, &x.rec[0], &x.ref[0], &x.out[0])
	C.speex_preprocess_run(x.p, (*C.spx_int16_t)(unsafe.Pointer(&x.out[0])))
	for i := range EchoFrame {
		out[i] = float32(x.out[i]) / 32768
	}
}

func (x *Echo) Close() {
	if x.e != nil {
		C.speex_preprocess_state_destroy(x.p)
		C.speex_echo_state_destroy(x.e)
		x.e, x.p = nil, nil
	}
}

func toInt16(v float32) C.spx_int16_t {
	v *= 32768
	switch {
	case v > 32767:
		return 32767
	case v < -32768:
		return -32768
	}
	return C.spx_int16_t(v)
}
