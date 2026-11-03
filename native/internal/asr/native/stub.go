//go:build !cgo

package native

import "errors"

// Without cgo there are no recognisers (the app is always built with it; this is for vet and cross-checks).

var errNoCgo = errors.New("built without cgo: no recognisers")

func LoadVosk([]string) error   { return errNoCgo }
func LoadSherpa([]string) error { return errNoCgo }

type Vosk struct{}

func NewVosk(string, float32, bool) (*Vosk, error) { return nil, errNoCgo }
func (*Vosk) SetWords(bool)                        {}
func (*Vosk) Accept([]float32) bool                { return false }
func (*Vosk) Result() string                       { return "" }
func (*Vosk) Partial() string                      { return "" }
func (*Vosk) Final() string                        { return "" }
func (*Vosk) Close()                               {}

func LoadORT([]string) error { return errNoCgo }

type StreamCTC struct{}

func NewStreamCTC([]byte, int, int, int, int, [4]int64, [4]int64) (*StreamCTC, error) {
	return nil, errNoCgo
}
func (*StreamCTC) Run([]float32, []float32) (int, error) { return 0, errNoCgo }
func (*StreamCTC) Reset()                                {}
func (*StreamCTC) Close()                                {}

type Sherpa struct{}

func NewSherpaCTC(string, string, int) (*Sherpa, error) { return nil, errNoCgo }
func (*Sherpa) Decode([]float32) string                 { return "" }
func (*Sherpa) Close()                                  {}
