package captions

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

type gateCase struct {
	Name     string       `json:"name"`
	PreMs    float64      `json:"preMs"`
	PostMs   float64      `json:"postMs"`
	Levels   [][2]float64 `json:"levels"`
	Segments []segment    `json:"segments"`
}

type segment struct {
	Start int     `json:"start"`
	End   int     `json:"end"`
	First float32 `json:"first"`
	Last  float32 `json:"last"`
}

type logSink struct {
	block   *int
	segs    []segment
	samples [][]float32
}

func (s *logSink) Start() {
	s.segs = append(s.segs, segment{Start: *s.block, End: -1})
	s.samples = append(s.samples, nil)
}
func (s *logSink) Audio(p []float32) {
	s.samples[len(s.samples)-1] = append(s.samples[len(s.samples)-1], p...)
}
func (s *logSink) End() { s.segs[len(s.segs)-1].End = *s.block }

// The website's cases (tests/fixtures/caption-gate.json), so both gates open and close on the same blocks.
func TestGateCases(t *testing.T) {
	raw, err := os.ReadFile("../../../tests/fixtures/caption-gate.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Cases []gateCase }
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			g := NewGate(48000, c.PreMs, c.PostMs, 1000)
			block := 0
			sink := &logSink{block: &block}
			k := float32(0)
			buf := make([]float32, 128)
			for _, run := range c.Levels {
				for n := 0; n < int(run[0]); n, block = n+1, block+1 {
					for i := range buf {
						buf[i] = k
						k++
					}
					g.Push(buf, float32(run[1]), sink)
				}
			}
			if len(sink.segs) != len(c.Segments) {
				t.Fatalf("got %d segments, want %d", len(sink.segs), len(c.Segments))
			}
			for i, s := range sink.segs {
				p := sink.samples[i]
				s.First, s.Last = p[0], p[len(p)-1]
				if s != c.Segments[i] {
					t.Errorf("segment %d: got %+v, want %+v", i, s, c.Segments[i])
				}
				for j, v := range p {
					if v != p[0]+float32(j) {
						t.Fatalf("segment %d isn't one unbroken run at %d", i, j)
					}
				}
			}
		})
	}
}

type nopSink struct{ n int }

func (s *nopSink) Start()            {}
func (s *nopSink) Audio(p []float32) { s.n += len(p) }
func (s *nopSink) End()              {}

// On the sender's goroutine every block: nothing may allocate.
func TestGateAndDecimatorAllocateNothing(t *testing.T) {
	g := NewGate(48000, 200, 200, 1000)
	var d Decimator
	in := make([]float32, 128)
	out := make([]float32, 0, 64)
	sink := &nopSink{}
	level := float32(0)
	allocs := testing.AllocsPerRun(2000, func() {
		level = 0.5 - level
		g.Push(in, level, sink)
		out = d.Push(in, out[:0])
	})
	if allocs != 0 {
		t.Fatalf("%v allocations a block", allocs)
	}
}

// The same taps as decimate.ts (the same constants are in tests/captions.test.ts).
func TestDecimatorTaps(t *testing.T) {
	h := FilterTaps()
	for _, c := range []struct {
		i    int
		want float64
	}{{0, 3.2188470192927945e-05}, {20, 0.002275942434150705}, {47, 0.30418056037248564}, {94, 3.2188470192927945e-05}} {
		if math.Abs(h[c.i]-c.want) > 1e-15 {
			t.Errorf("tap %d = %v, want %v", c.i, h[c.i], c.want)
		}
	}
}

func gainDb(hz float64) float64 {
	var d Decimator
	in := make([]float32, 48000)
	for i := range in {
		in[i] = float32(math.Sin(2 * math.Pi * hz * float64(i) / 48000))
	}
	out := d.Push(in, nil)
	s := 0.0
	for _, v := range out[1000:] {
		s += float64(v) * float64(v)
	}
	return 10 * math.Log10(s/float64(len(out)-1000)/0.5)
}

func TestDecimatorResponse(t *testing.T) {
	if g := gainDb(1000); math.Abs(g) > 0.05 {
		t.Errorf("1 kHz: %.2f dB", g)
	}
	for _, hz := range []float64{8400, 12000} {
		if g := gainDb(hz); g > -60 {
			t.Errorf("%v Hz: %.1f dB, want under -60", hz, g)
		}
	}
}

func TestText(t *testing.T) {
	raw, err := os.ReadFile("../../../tests/fixtures/caption-text.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Clean  []struct{ In, Out string }
		Encode []struct {
			S, U int64
			T    string
			F    bool
			JSON string `json:"json"`
		}
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Clean {
		if got := Clean(c.In); got != c.Out {
			t.Errorf("Clean(%q) = %q, want %q", c.In, got, c.Out)
		}
	}
	for _, c := range f.Encode {
		if got := string(Encode(c.S, c.U, c.T, c.F)); got != c.JSON {
			t.Errorf("Encode = %s, want %s", got, c.JSON)
		}
	}
}
