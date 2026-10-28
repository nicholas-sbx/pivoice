//go:build !nornnoise

package dsp

/*
#cgo pkg-config: rnnoise
#include <rnnoise.h>

// Ours (build/rnnoise-lookahead.patch).
void rnnoise_set_lookahead(DenoiseState *st, int on);
*/
import "C"

import "errors"

// NoiseFrame is RNNoise's frame: 10 ms. It's the one fixed cost of noise
// suppression: the frame has to fill before it's processed, and its
// analysis window overlaps the frame before, another 10 ms (NoiseDelay).
// RNNoise 0.2 also looks a frame ahead before deciding on one, 10 ms more;
// that's ours to switch off (it is by default), and we add nothing else:
// no retroactive gate.
const NoiseFrame = 480

const NoiseAvailable = true

// Denoise is RNNoise with its built-in model.
type Denoise struct {
	st      *C.DenoiseState
	in, out [NoiseFrame]C.float
}

func NewDenoise(lookahead bool) (*Denoise, error) {
	st := C.rnnoise_create(nil)
	if st == nil {
		return nil, errors.New("rnnoise: couldn't start")
	}
	on := C.int(0)
	if lookahead {
		on = 1
	}
	C.rnnoise_set_lookahead(st, on)
	return &Denoise{st: st}, nil
}

// Process one NoiseFrame in place, and say how likely it is that it's voice (0–1).
func (d *Denoise) Process(frame []float32) float32 {
	// RNNoise works on 16-bit-scale floats.
	for i := range NoiseFrame {
		d.in[i] = C.float(frame[i] * 32768)
	}
	vad := C.rnnoise_process_frame(d.st, &d.out[0], &d.in[0])
	for i := range NoiseFrame {
		frame[i] = float32(d.out[i]) / 32768
	}
	return float32(vad)
}

func (d *Denoise) Close() {
	if d.st != nil {
		C.rnnoise_destroy(d.st)
		d.st = nil
	}
}
