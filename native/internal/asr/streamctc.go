package asr

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The streaming FastConformer (NVIDIA NeMo's cache-aware CTC model, as
// sherpa-onnx exports it), driven the way the website's
// src/captions/streaming-ctc.ts drives it, with the same results: audio
// becomes log-mel frames as it arrives (fbank.go), the model reads `window`
// frames at a time, moving on `shift`, and hands back its caches with each
// chunk's output, so nothing is read twice. Greedy CTC only ever adds to
// the words. Both are held to tests/fixtures/streaming-ctc.json.

// leadIn is silence before each segment, samples (streaming-ctc.ts has why).
const leadIn = 3200

// chunkModel is one chunk through the model (native.StreamCTC, or a pretend one in tests).
type chunkModel interface {
	// run x (bins × window, bin-major) through the model: log-probabilities, frames × vocab, into out.
	run(x []float32, out []float32) (frames int, err error)
	// reset the caches to empty.
	reset()
}

type streamCTC struct {
	model         chunkModel
	window, shift int
	bins          int
	pieces        []string
	blank         int
	fb            *fbank

	samples    []float32 // from sample sampleBase
	sampleBase int
	heard      int
	frames     []float32 // frame-major, from frame frameBase
	frameBase  int
	made       int
	next       int
	x, lp      []float32

	prev        int
	outFrame    int
	phrase      strings.Builder
	phraseStart int
	ended       string
	// maxFrames: past this many output frames (80 ms each), the next word starts a new phrase.
	maxFrames int
}

func newStreamCTC(m chunkModel, window, shift int, pieces []string, blank int) *streamCTC {
	const bins = 80
	return &streamCTC{
		model: m, window: window, shift: shift, bins: bins, pieces: pieces, blank: blank, fb: newFbank(bins),
		samples: make([]float32, 16000), frames: make([]float32, bins*window*4),
		x: make([]float32, bins*window), lp: make([]float32, 64*len(pieces)),
		prev: -1, maxFrames: math.MaxInt,
	}
}

func (s *streamCTC) setMaxPhraseSec(sec float64) {
	if sec <= 0 {
		s.maxFrames = math.MaxInt
		return
	}
	s.maxFrames = int(math.Ceil(sec * 12.5))
}

// text is the phrase so far.
func (s *streamCTC) text() string { return strings.TrimPrefix(s.phrase.String(), " ") }

// accept more audio (16 kHz, [-1, 1]); true when a long phrase ended at a word (take it with result).
func (s *streamCTC) accept(pcm []float32) (bool, error) {
	if s.heard == 0 && len(pcm) > 0 {
		s.appendSilence(leadIn)
	}
	s.append(pcm)
	if err := s.decodeReady(); err != nil {
		return false, err
	}
	return s.ended != "", nil
}

func (s *streamCTC) result() string {
	t := strings.TrimPrefix(s.ended, " ")
	s.ended = ""
	return t
}

// finish the segment: silence after it, enough for one chunk past the last
// with any of it in (the model says a word up to a chunk after it hears it).
// Its words; the caches empty after.
func (s *streamCTC) finish() (string, error) {
	var err error
	if s.heard > 0 {
		real := frameCount(s.heard)
		chunks := 0
		if real > s.window {
			chunks = (real - s.window + s.shift - 1) / s.shift
		}
		if last := (chunks + 1) * s.shift; s.next <= last {
			if pad := endSample(last+s.window-1) - s.heard; pad > 0 {
				s.appendSilence(pad)
			}
			err = s.decodeReady()
		}
	}
	text := strings.TrimPrefix(s.ended+s.phrase.String(), " ")
	s.reset()
	return text, err
}

func (s *streamCTC) reset() {
	s.model.reset()
	s.sampleBase, s.heard = 0, 0
	s.frameBase, s.made, s.next = 0, 0, 0
	s.prev = -1
	s.outFrame, s.phraseStart = 0, 0
	s.phrase.Reset()
	s.ended = ""
}

// room makes space for n more samples, keeping only what the next frame onward needs.
func (s *streamCTC) room(n int) []float32 {
	keepFrom := max(s.sampleBase, firstSample(s.made))
	kept := s.heard - keepFrom
	if keepFrom > s.sampleBase {
		copy(s.samples, s.samples[keepFrom-s.sampleBase:s.heard-s.sampleBase])
	}
	s.sampleBase = keepFrom
	if kept+n > len(s.samples) {
		bigger := make([]float32, max(2*len(s.samples), kept+n))
		copy(bigger, s.samples[:kept])
		s.samples = bigger
	}
	return s.samples[kept : kept+n]
}

func (s *streamCTC) append(pcm []float32) {
	copy(s.room(len(pcm)), pcm)
	s.heard += len(pcm)
	s.makeFrames()
}

func (s *streamCTC) appendSilence(n int) {
	clear(s.room(n))
	s.heard += n
	s.makeFrames()
}

// makeFrames computes every frame whose samples are all here.
func (s *streamCTC) makeFrames() {
	bins := s.bins
	for endSample(s.made) <= s.heard {
		row := s.made - s.frameBase
		if (row+1)*bins > len(s.frames) {
			if drop := s.next - s.frameBase; drop > 0 {
				copy(s.frames, s.frames[drop*bins:row*bins])
				s.frameBase = s.next
				row -= drop
			}
			if (row+1)*bins > len(s.frames) {
				bigger := make([]float32, 2*len(s.frames))
				copy(bigger, s.frames[:row*bins])
				s.frames = bigger
			}
		}
		s.fb.frameOf(s.samples, s.sampleBase, s.made, s.frames[row*bins:(row+1)*bins])
		s.made++
	}
}

func (s *streamCTC) decodeReady() error {
	bins, window := s.bins, s.window
	for s.next+window <= s.made {
		first := s.next - s.frameBase
		for t := 0; t < window; t++ {
			row := s.frames[(first+t)*bins : (first+t+1)*bins]
			for b, v := range row {
				s.x[b*window+t] = v
			}
		}
		frames, err := s.model.run(s.x, s.lp)
		if err != nil {
			return err
		}
		s.next += s.shift
		s.greedy(s.lp[:frames*len(s.pieces)], frames)
	}
	return nil
}

func (s *streamCTC) greedy(lp []float32, frames int) {
	vocab := len(s.pieces)
	for t := 0; t < frames; t, s.outFrame = t+1, s.outFrame+1 {
		best, top := 0, float32(math.Inf(-1))
		for k, v := range lp[t*vocab : (t+1)*vocab] {
			if v > top {
				best, top = k, v
			}
		}
		if best != s.blank && best != s.prev {
			if p := s.pieces[best]; p != "<unk>" {
				word := strings.HasPrefix(p, "▁")
				if word && s.phrase.Len() > 0 && s.ended == "" && s.outFrame-s.phraseStart >= s.maxFrames {
					s.ended = s.phrase.String()
					s.phrase.Reset()
					s.phraseStart = s.outFrame
				}
				if word {
					s.phrase.WriteByte(' ')
					p = p[len("▁"):]
				}
				s.phrase.WriteString(p)
			}
		}
		s.prev = best
	}
}

// readTokens is tokens.txt ("piece id" a line): the pieces, and which is the blank.
func readTokens(text string) ([]string, int, error) {
	var pieces []string
	blank := -1
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSuffix(line, "\r")
		sp := strings.LastIndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		id, err := strconv.Atoi(line[sp+1:])
		if err != nil || id < 0 || id > 1<<16 {
			continue
		}
		for len(pieces) <= id {
			pieces = append(pieces, "")
		}
		pieces[id] = line[:sp]
		if line[:sp] == "<blk>" || line[:sp] == "<blank>" {
			blank = id
		}
	}
	if len(pieces) == 0 {
		return nil, 0, errors.New("tokens.txt has no tokens")
	}
	if blank < 0 {
		blank = len(pieces) - 1
	}
	return pieces, blank, nil
}

// streamMeta is what a sherpa-onnx streaming NeMo CTC export says about itself (src/captions/onnx-meta.ts reads the same).
type streamMeta struct {
	window, shift int
	channel, time [4]int64
}

func readStreamMeta(model []byte) (streamMeta, error) {
	props, err := onnxMetadata(model)
	if err != nil {
		return streamMeta{}, err
	}
	num := func(k string) (int, error) {
		v, err := strconv.Atoi(props[k])
		if err != nil || v <= 0 || v > 1<<16 {
			return 0, fmt.Errorf("model: no %s", k)
		}
		return v, nil
	}
	if props["normalize_type"] != "" {
		return streamMeta{}, fmt.Errorf("model: features normalised (%s), which this doesn't do", props["normalize_type"])
	}
	var m streamMeta
	var dims [6]int
	keys := []string{"subsampling_factor", "window_size", "chunk_shift",
		"cache_last_channel_dim1", "cache_last_channel_dim2", "cache_last_channel_dim3",
		"cache_last_time_dim1", "cache_last_time_dim2", "cache_last_time_dim3"}
	vals := make([]int, len(keys))
	for i, k := range keys {
		if vals[i], err = num(k); err != nil {
			return m, err
		}
	}
	if vals[0] != 8 {
		return m, errors.New("model: not 8× subsampling")
	}
	m.window, m.shift = vals[1], vals[2]
	if m.shift > m.window {
		return m, errors.New("model: chunks with gaps between them")
	}
	copy(dims[:], vals[3:])
	m.channel = [4]int64{1, int64(dims[0]), int64(dims[1]), int64(dims[2])}
	m.time = [4]int64{1, int64(dims[3]), int64(dims[4]), int64(dims[5])}
	return m, nil
}

// onnxMetadata reads an ONNX ModelProto's metadata_props (field 14, each key 1 and value 2), skipping everything else by its length.
func onnxMetadata(b []byte) (map[string]string, error) {
	cut := errors.New("model: cut short")
	i := 0
	varint := func() (uint64, error) {
		var v uint64
		for n := 0; n < 10; n++ {
			if i >= len(b) {
				return 0, cut
			}
			c := b[i]
			i++
			v |= uint64(c&0x7f) << (7 * n)
			if c < 0x80 {
				return v, nil
			}
		}
		return 0, errors.New("model: bad varint")
	}
	skip := func(wire uint64) error {
		switch wire {
		case 0:
			_, err := varint()
			return err
		case 1:
			i += 8
		case 2:
			n, err := varint()
			if err != nil {
				return err
			}
			if n > uint64(len(b)) {
				return cut
			}
			i += int(n)
		case 5:
			i += 4
		default:
			return fmt.Errorf("model: wire type %d", wire)
		}
		if i > len(b) {
			return cut
		}
		return nil
	}
	out := map[string]string{}
	for i < len(b) {
		tag, err := varint()
		if err != nil {
			return nil, err
		}
		if tag>>3 != 14 || tag&7 != 2 {
			if err := skip(tag & 7); err != nil {
				return nil, err
			}
			continue
		}
		n, err := varint()
		if err != nil {
			return nil, err
		}
		if n > uint64(len(b)-i) {
			return nil, cut
		}
		end := i + int(n)
		var key, value string
		for i < end {
			t, err := varint()
			if err != nil {
				return nil, err
			}
			if f := t >> 3; t&7 == 2 && (f == 1 || f == 2) {
				l, err := varint()
				if err != nil {
					return nil, err
				}
				if l > uint64(end-i) {
					return nil, cut
				}
				str := string(b[i : i+int(l)])
				i += int(l)
				if f == 1 {
					key = str
				} else {
					value = str
				}
			} else if err := skip(t & 7); err != nil {
				return nil, err
			}
		}
		i = end
		out[key] = value
	}
	return out, nil
}
