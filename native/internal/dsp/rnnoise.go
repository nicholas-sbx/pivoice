//go:build !nornnoise

package dsp

/*
#cgo pkg-config: rnnoise
#include <rnnoise.h>
*/
import "C"

import "errors"

// NoiseFrame is RNNoise's frame: 10 ms. It's the one fixed cost of noise
// suppression: the frame has to fill before it's processed, and its
// analysis window overlaps the frame before (see README for the measured
// delay). Nothing is added on top: no lookahead, no retroactive gate.
const NoiseFrame = 480

const NoiseAvailable = true

// Denoise is RNNoise with its built-in model.
type Denoise struct {
	st      *C.DenoiseState
	in, out [NoiseFrame]C.float
}

func NewDenoise() (*Denoise, error) {
	st := C.rnnoise_create(nil)
	if st == nil {
		return nil, errors.New("rnnoise: couldn't start")
	}
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
