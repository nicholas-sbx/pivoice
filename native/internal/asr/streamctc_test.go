package asr

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
)

// The website's cases (tests/fixtures/streaming-ctc.json): the same frames, the same chunks, the same silence after.
type streamFixture struct {
	Signal struct {
		Seed    uint32 `json:"seed"`
		Samples int    `json:"samples"`
	} `json:"signal"`
	Lead     int          `json:"lead"`
	Tail     int          `json:"tail"`
	Features [][3]float64 `json:"features"`
	Shapes   []struct {
		Model  string `json:"model"`
		Window int    `json:"window"`
		Shift  int    `json:"shift"`
		Cases  []struct {
			Name    string `json:"name"`
			Samples int    `json:"samples"`
			Chunks  []int  `json:"chunks"`
			Padded  int    `json:"padded"`
		} `json:"cases"`
	} `json:"shapes"`
}

// shape480 is the 480 ms export's chunks, which the words and phrases tests go by.
func (f streamFixture) shape480() (window, shift int) {
	for _, s := range f.Shapes {
		if s.Model == "480 ms" {
			return s.Window, s.Shift
		}
	}
	panic("no 480 ms shape")
}

func loadStreamFixture(t *testing.T) streamFixture {
	raw, err := os.ReadFile("../../../tests/fixtures/streaming-ctc.json")
	if err != nil {
		t.Fatal(err)
	}
	var f streamFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// testSignal is tests/streaming-ctc.test.ts's signal(): a tone, a chirp and a little noise.
func testSignal(seed uint32, n int) []float32 {
	out := make([]float32, n)
	s := seed
	for i := range out {
		s = s*1664525 + 1013904223
		t := float64(i) / 16000
		out[i] = float32(0.3*math.Sin(2*math.Pi*440*t) + 0.2*math.Sin(2*math.Pi*(300+3000*t)*t) + (float64(s>>8)/16777216-0.5)*0.02)
	}
	return out
}

var testPieces = []string{"<unk>", "▁hel", "lo", "▁there", "▁you", "<blk>"}

const testBlank = 5

// fakeChunks keeps every window it's given and emits one output frame per chunk from a script (blank once it runs out).
type fakeChunks struct {
	seen   [][]float32
	script []int
	resets int
}

func (f *fakeChunks) run(x, out []float32) (int, error) {
	f.seen = append(f.seen, append([]float32(nil), x...))
	tok := testBlank
	if len(f.seen) <= len(f.script) {
		tok = f.script[len(f.seen)-1]
	}
	for k := range testPieces {
		out[k] = -10
	}
	out[tok] = 0
	return 1, nil
}
func (f *fakeChunks) reset() { f.resets++ }

func feedAll(t *testing.T, s *streamCTC, x []float32) []string {
	var ended []string
	sizes := []int{320, 1000, 7, 4096}
	for at, k := 0, 0; at < len(x); k++ {
		n := min(sizes[k%len(sizes)], len(x)-at)
		done, err := s.accept(x[at : at+n])
		if err != nil {
			t.Fatal(err)
		}
		if done {
			ended = append(ended, s.result())
		}
		at += n
	}
	return ended
}

// wholeFrames are the frames of a whole signal computed in one go, frame-major.
func wholeFrames(x []float32) [][]float32 {
	fb := newFbank(80)
	n := frameCount(len(x))
	out := make([][]float32, 0, n)
	for f := 0; f < n && endSample(f) <= len(x); f++ {
		row := make([]float32, 80)
		fb.frameOf(x, 0, f, row)
		out = append(out, row)
	}
	return out
}

func TestStreamCTCChunks(t *testing.T) {
	fx := loadStreamFixture(t)
	if fx.Lead != leadIn || fx.Tail != tailFrames {
		t.Fatalf("silence before and after: %d samples and %d frames, the site's are %d and %d", leadIn, tailFrames, fx.Lead, fx.Tail)
	}
	for _, sh := range fx.Shapes {
		for _, c := range sh.Cases {
			t.Run(sh.Model+": "+c.Name, func(t *testing.T) {
				f := &fakeChunks{}
				s := newStreamCTC(f, sh.Window, sh.Shift, testPieces, testBlank)
				x := testSignal(fx.Signal.Seed, c.Samples)
				feedAll(t, s, x)
				if _, err := s.finish(); err != nil {
					t.Fatal(err)
				}
				if len(f.seen) != len(c.Chunks) {
					t.Fatalf("%d chunks, want %d", len(f.seen), len(c.Chunks))
				}
				padded := make([]float32, c.Padded)
				copy(padded[fx.Lead:], x)
				whole := wholeFrames(padded)
				for k, start := range c.Chunks {
					worst := 0.0
					for b := 0; b < 80; b++ {
						for tt := 0; tt < sh.Window; tt++ {
							worst = math.Max(worst, math.Abs(float64(f.seen[k][b*sh.Window+tt]-whole[start+tt][b])))
						}
					}
					if worst > 1e-5 {
						t.Errorf("chunk %d (frame %d) differs from the whole signal's frames by %g", k, start, worst)
					}
				}
				if got := endSample(c.Chunks[len(c.Chunks)-1] + sh.Window - 1); got != c.Padded {
					t.Errorf("padded to %d, want %d", got, c.Padded)
				}
			})
		}
	}
}

func TestStreamCTCFeaturesMatchTheSites(t *testing.T) {
	fx := loadStreamFixture(t)
	whole := wholeFrames(testSignal(fx.Signal.Seed, fx.Signal.Samples))
	// The site's last frame reflects past the end (it has the whole signal); here only frames with every sample are made.
	for _, v := range fx.Features {
		f, b := int(v[0]), int(v[1])
		if f >= len(whole) {
			continue
		}
		if d := math.Abs(float64(whole[f][b]) - v[2]); d > 1e-4 {
			t.Errorf("frame %d bin %d: %g, the site has %g", f, b, whole[f][b], v[2])
		}
	}
}

func TestStreamCTCWords(t *testing.T) {
	fx := loadStreamFixture(t)
	// Output frames: hel hel blk lo blk there <unk> you
	f := &fakeChunks{script: []int{1, 1, 5, 2, 5, 3, 0, 4}}
	window, shift := fx.shape480()
	s := newStreamCTC(f, window, shift, testPieces, testBlank)
	x := testSignal(1, 16000*6)
	prev := ""
	for at := 0; at < len(x); at += 1600 {
		if _, err := s.accept(x[at : at+1600]); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(s.text(), prev) {
			t.Fatalf("%q took back some of %q", s.text(), prev)
		}
		prev = s.text()
	}
	text, err := s.finish()
	if err != nil || text != "hello there you" {
		t.Fatalf("%q %v", text, err)
	}
	if f.resets != 1 || s.text() != "" {
		t.Fatalf("not ready for the next: %d resets, %q", f.resets, s.text())
	}
}

func TestStreamCTCLongPhrases(t *testing.T) {
	fx := loadStreamFixture(t)
	f := &fakeChunks{script: []int{1, 2, 3, 4, 3, 4, 3, 4, 3}}
	window, shift := fx.shape480()
	s := newStreamCTC(f, window, shift, testPieces, testBlank)
	s.maxFrames = 3
	ended := feedAll(t, s, testSignal(2, 16000*6))
	rest, err := s.finish()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(ended, "|") != "hello there|you there you" {
		t.Fatalf("ended %q", ended)
	}
	if all := strings.Join(append(ended, rest), " "); all != "hello there you there you there you there" {
		t.Fatalf("all %q", all)
	}
	if f.resets != 1 {
		t.Fatalf("started again %d times", f.resets)
	}
}

func TestStreamCTCShortAndEmpty(t *testing.T) {
	fx := loadStreamFixture(t)
	f := &fakeChunks{script: []int{1}}
	window, shift := fx.shape480()
	s := newStreamCTC(f, window, shift, testPieces, testBlank)
	if _, err := s.accept(testSignal(3, 800)); err != nil {
		t.Fatal(err)
	}
	if text, _ := s.finish(); text != "hel" || len(f.seen) != 2 {
		t.Fatalf("%q after %d chunks", text, len(f.seen))
	}
	if text, _ := s.finish(); text != "" || len(f.seen) != 2 {
		t.Fatalf("%q after %d chunks", text, len(f.seen))
	}
}

func TestReadTokens(t *testing.T) {
	pieces, blank, err := readTokens("<unk> 0\n▁hel 1\nlo 2\r\n<blk> 3\n")
	if err != nil || blank != 3 || len(pieces) != 4 || pieces[1] != "▁hel" || pieces[2] != "lo" {
		t.Fatalf("%q %d %v", pieces, blank, err)
	}
}

// A ModelProto with a graph to skip and some metadata_props.
func fakeOnnx(props map[string]string) []byte {
	var b []byte
	varint := func(v int) {
		for v >= 0x80 {
			b = append(b, byte(v&0x7f|0x80))
			v >>= 7
		}
		b = append(b, byte(v))
	}
	field := func(n int, body []byte) {
		varint(n<<3 | 2)
		varint(len(body))
		b = append(b, body...)
	}
	varint(1 << 3)
	varint(8)
	field(7, make([]byte, 300))
	for k, v := range props {
		var e []byte
		e = append(e, 1<<3|2, byte(len(k)))
		e = append(e, k...)
		e = append(e, 2<<3|2, byte(len(v)))
		e = append(e, v...)
		field(14, e)
	}
	return b
}

func TestStreamMeta(t *testing.T) {
	good := map[string]string{"window_size": "65", "chunk_shift": "56", "normalize_type": "", "subsampling_factor": "8",
		"cache_last_channel_dim1": "17", "cache_last_channel_dim2": "70", "cache_last_channel_dim3": "512",
		"cache_last_time_dim1": "17", "cache_last_time_dim2": "512", "cache_last_time_dim3": "8"}
	m, err := readStreamMeta(fakeOnnx(good))
	if err != nil || m.window != 65 || m.shift != 56 || m.channel != [4]int64{1, 17, 70, 512} || m.time != [4]int64{1, 17, 512, 8} {
		t.Fatalf("%+v %v", m, err)
	}
	bad := map[string]string{}
	for k, v := range good {
		bad[k] = v
	}
	bad["normalize_type"] = "per_feature"
	if _, err := readStreamMeta(fakeOnnx(bad)); err == nil {
		t.Error("took normalised features")
	}
	if _, err := onnxMetadata(fakeOnnx(good)[:200]); err == nil {
		t.Error("took a file cut short")
	}
}
