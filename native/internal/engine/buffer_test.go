package engine

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

func TestUnderrunWatch(t *testing.T) {
	t0 := time.Unix(1000, 0)
	at := func(s float64) time.Time { return t0.Add(time.Duration(s * float64(time.Second))) }
	w := underrunWatch{opened: t0, settle: 2 * time.Second}
	// Opening's own: not counted.
	if w.see(at(1), 3) {
		t.Fatal("counted underruns while the stream settled")
	}
	if w.see(at(3), 3) || w.see(at(4), 4) {
		t.Fatal("one underrun is not enough")
	}
	// The next is more than the window later: still only one at a time.
	if w.see(at(40), 5) {
		t.Fatal("two underruns 36 s apart counted together")
	}
	if !w.see(at(50), 6) {
		t.Fatal("two underruns within the window: no step")
	}
	// A burst at once.
	w = underrunWatch{opened: t0, settle: 2 * time.Second}
	if !w.see(at(5), 40) {
		t.Fatal("a burst of underruns: no step")
	}
}

// A sound card whose speakers run dry whenever the test says, and that
// remembers what buffer it was opened with.
type dryBackend struct {
	audio.Fake
	mu     sync.Mutex
	opened []float64
	under  atomic.Int64
}

type dryStream struct {
	audio.Stream
	b     *dryBackend
	extra float64
	base  int64
}

func (d *dryBackend) Open(o audio.Options, cb audio.Callback) (audio.Stream, error) {
	s, err := d.Fake.Open(o, cb)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.opened = append(d.opened, o.ExtraOutputMs)
	d.mu.Unlock()
	return &dryStream{Stream: s, b: d, extra: o.ExtraOutputMs, base: d.under.Load()}, nil
}

func (d *dryBackend) opens() []float64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]float64(nil), d.opened...)
}

func (s *dryStream) Info() audio.Info {
	i := s.Stream.Info()
	i.OutputUnderflows = s.b.under.Load() - s.base
	return i
}

func TestBufferStepsUpWhenTheSpeakersRunDry(t *testing.T) {
	b := &dryBackend{}
	e := New(Options{Backend: b})
	e.watch = watchTiming{settle: 0, every: 10 * time.Millisecond}
	t.Cleanup(e.Reset)
	cfg := proto.Config{LL: proto.DefaultLL, Spatial: "off", BufferAuto: true}
	e.Handle(proto.In{T: "config", Config: &cfg})
	e.Handle(proto.In{T: "audio", On: true})
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(2 * time.Second); !ok(); time.Sleep(5 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("%s: opened with %v", what, b.opens())
			}
		}
	}
	// Running dry, again and again: up a step at a time, to the top and no further.
	for step := 1; step < len(bufferSteps); step++ {
		b.under.Add(2)
		waitFor("a step up", func() bool { return len(b.opens()) == step+1 })
	}
	b.under.Add(5)
	time.Sleep(50 * time.Millisecond)
	if got := b.opens(); len(got) != len(bufferSteps) {
		t.Fatalf("opened with %v, want each of %v once", got, bufferSteps)
	} else {
		for i, ms := range bufferSteps {
			if got[i] != ms {
				t.Fatalf("opened with %v, want %v", got, bufferSteps)
			}
		}
	}
	// What counted before each reopen still counts.
	e.mu.Lock()
	g := e.glitchesLocked()
	e.mu.Unlock()
	if want := b.under.Load(); g.OutputUnderflows != want {
		t.Fatalf("%d underruns counted, want %d", g.OutputUnderflows, want)
	}

	// Chosen by hand: exactly that, and the app doesn't touch it.
	cfg.BufferAuto, cfg.BufferMs = false, 6
	e.Handle(proto.In{T: "config", Config: &cfg})
	waitFor("reopened at 6 ms", func() bool { o := b.opens(); return o[len(o)-1] == 6 })
	n := len(b.opens())
	b.under.Add(10)
	time.Sleep(50 * time.Millisecond)
	if len(b.opens()) != n {
		t.Fatalf("stepped up a buffer chosen by hand: %v", b.opens())
	}
	// Back to automatic: where it had got to, until the devices change.
	cfg.BufferAuto = true
	e.Handle(proto.In{T: "config", Config: &cfg})
	waitFor("back at the top", func() bool { o := b.opens(); return o[len(o)-1] == bufferSteps[len(bufferSteps)-1] })
	cfg.OutputID = "other"
	e.Handle(proto.In{T: "config", Config: &cfg})
	waitFor("other speakers from the smallest", func() bool { o := b.opens(); return o[len(o)-1] == 0 })
}

// A page from before the buffer settings, or a nonsense value, gets the smallest or the most there is.
func TestBufferSanitized(t *testing.T) {
	for _, c := range []struct{ in, want float64 }{{0, 0}, {-5, 0}, {6, 6}, {1e9, proto.MaxBufferMs}} {
		if got := (proto.Config{BufferMs: c.in}).Sanitize().BufferMs; got != c.want {
			t.Errorf("BufferMs %g: %g, want %g", c.in, got, c.want)
		}
	}
}
