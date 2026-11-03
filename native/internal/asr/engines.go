package asr

import (
	"fmt"
	"os"
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
		case "nemo-ctc-streaming":
			if err := native.LoadORT(libs); err != nil {
				return nil, err
			}
			return newStreamRec(in)
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

func (r *voskRec) accept(pcm []float32) (string, bool, error) {
	if cap(r.scaled) < len(pcm) {
		r.scaled = make([]float32, len(pcm))
	}
	s := r.scaled[:len(pcm)]
	for i, v := range pcm {
		s[i] = v * 32768
	}
	if r.v.Accept(s) {
		return voskWords(r.v.Result(), r.min), true, nil
	}
	return "", false, nil
}
func (r *voskRec) partial() string         { return voskPartial(r.v.Partial()) }
func (r *voskRec) finish() (string, error) { return voskWords(r.v.Final(), r.min), nil }
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

func (r *sherpaRec) accept(pcm []float32) (string, bool, error) {
	r.phrase = append(r.phrase, pcm...)
	return "", false, nil
}
func (r *sherpaRec) partial() string { return r.s.Decode(r.phrase) }
func (r *sherpaRec) finish() (string, error) {
	text := r.s.Decode(r.phrase)
	r.phrase = r.phrase[:0]
	return text, nil
}
func (r *sherpaRec) configure(helperConfig) {}
func (r *sherpaRec) close()                 { r.s.Close() }

// streamRec: the streaming FastConformer, ONNX Runtime driven directly
// (streamctc.go has why, and the rest of it).
type streamRec struct {
	m   *native.StreamCTC
	ctc *streamCTC
}

func newStreamRec(in helperInit) (recogniser, error) {
	// The files were checked against their pins a moment ago (start), and are read once here.
	model, err := os.ReadFile(filepath.Join(in.ModelDir, "model.int8.onnx"))
	if err != nil {
		return nil, err
	}
	tokens, err := os.ReadFile(filepath.Join(in.ModelDir, "tokens.txt"))
	if err != nil {
		return nil, err
	}
	meta, err := readStreamMeta(model)
	if err != nil {
		return nil, err
	}
	pieces, blank, err := readTokens(string(tokens))
	if err != nil {
		return nil, err
	}
	m, err := native.NewStreamCTC(model, in.Threads, 80, meta.window, len(pieces), meta.channel, meta.time)
	if err != nil {
		return nil, err
	}
	r := &streamRec{m: m}
	r.ctc = newStreamCTC(r, meta.window, meta.shift, pieces, blank)
	r.ctc.setMaxPhraseSec(in.MaxPhraseSec)
	return r, nil
}

func (r *streamRec) run(x, out []float32) (int, error) { return r.m.Run(x, out) }
func (r *streamRec) reset()                            { r.m.Reset() }

func (r *streamRec) accept(pcm []float32) (string, bool, error) {
	ended, err := r.ctc.accept(pcm)
	if err != nil || !ended {
		return "", false, err
	}
	return r.ctc.result(), true, nil
}
func (r *streamRec) partial() string          { return r.ctc.text() }
func (r *streamRec) finish() (string, error)  { return r.ctc.finish() }
func (r *streamRec) configure(c helperConfig) { r.ctc.setMaxPhraseSec(c.MaxPhraseSec) }
func (r *streamRec) close()                   { r.m.Close() }
