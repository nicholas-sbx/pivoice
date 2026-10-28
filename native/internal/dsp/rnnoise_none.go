//go:build nornnoise

package dsp

import "errors"

// Built without RNNoise (-tags nornnoise, when the library isn't there to
// link): noise suppression isn't offered.

const NoiseFrame = 480

const NoiseAvailable = false

type Denoise struct{}

func NewDenoise() (*Denoise, error) {
	return nil, errors.New("this build has no noise suppression (built without RNNoise)")
}

func (*Denoise) Process([]float32) float32 { return 1 }
func (*Denoise) Close()                    {}
