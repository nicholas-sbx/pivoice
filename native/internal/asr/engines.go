package asr

import (
	"fmt"
	"path/filepath"

	"github.com/nicholas-sbx/pivoice/native/internal/asr/native"
)

// The engines, as the helper runs them (native/ does the C).
func init() {
	newRecogniser = func(in helperInit) (recogniser, error) {
		libs := make([]string, len(in.Load))
		for i, name := range in.Load {
			libs[i] = filepath.Join(in.LibDir, name)
		}
		switch in.Engine {
		case "vosk":
			if err := native.LoadVosk(libs); err != nil {
				return nil, err
			}
			v, err := native.NewVosk(in.ModelDir, 16000, in.MinConfidence > 0)
			if err != nil {
				return nil, err
			}
			return &voskRec{v: v, min: in.MinConfidence}, nil
		case "nemo-ctc":
			if err := native.LoadSherpa(libs); err != nil {
				return nil, err
			}
			s, err := native.NewSherpaCTC(filepath.Join(in.ModelDir, "model.int8.onnx"), filepath.Join(in.ModelDir, "tokens.txt"), in.Threads)
			if err != nil {
				return nil, err
			}
			return &sherpaRec{s: s}, nil
		}
		return nil, fmt.Errorf("no engine %q", in.Engine)
	}
}

// voskRec: Vosk streams, so audio goes straight in (in 16-bit range, as Kaldi wants it).
type voskRec struct {
	v      *native.Vosk
	min    float64
	scaled []float32
}

func (r *voskRec) accept(pcm []float32) (string, bool) {
	if cap(r.scaled) < len(pcm) {
		r.scaled = make([]float32, len(pcm))
	}
	s := r.scaled[:len(pcm)]
	for i, v := range pcm {
		s[i] = v * 32768
	}
	if r.v.Accept(s) {
		return voskWords(r.v.Result(), r.min), true
	}
	return "", false
}
func (r *voskRec) partial() string { return voskPartial(r.v.Partial()) }
func (r *voskRec) finish() string  { return voskWords(r.v.Final(), r.min) }
func (r *voskRec) configure(c helperConfig) {
	if (c.MinConfidence > 0) != (r.min > 0) {
		r.v.SetWords(c.MinConfidence > 0)
	}
	r.min = c.MinConfidence
}
func (r *voskRec) close() { r.v.Close() }

// sherpaRec: Parakeet hears a phrase whole, so the phrase is kept here and read when asked.
type sherpaRec struct {
	s      *native.Sherpa
	phrase []float32
}

func (r *sherpaRec) accept(pcm []float32) (string, bool) {
	r.phrase = append(r.phrase, pcm...)
	return "", false
}
func (r *sherpaRec) partial() string { return r.s.Decode(r.phrase) }
func (r *sherpaRec) finish() string {
	text := r.s.Decode(r.phrase)
	r.phrase = r.phrase[:0]
	return text
}
func (r *sherpaRec) configure(helperConfig) {}
func (r *sherpaRec) close()                 { r.s.Close() }
