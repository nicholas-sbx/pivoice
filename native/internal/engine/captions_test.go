package engine

import (
	"math"
	"slices"
	"testing"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/captions"
	"github.com/nicholas-sbx/pivoice/native/internal/dsp"
)

// What live captions hear: with echo cancellation on, the echo canceller's
// output and nothing after it (no noise suppression, no gain), so someone
// on speakers isn't captioned saying everyone else's words; with it off, the
// mic block exactly as it came, whatever else is on.
func TestCaptionsHearEchoCancelledNotNoiseSuppressed(t *testing.T) {
	// A voice, and what the speakers play (another voice) leaking into the mic.
	block := func(i int) (mic, ref []float32) {
		mic = make([]float32, dsp.EchoFrame)
		ref = make([]float32, dsp.EchoFrame)
		for k := range mic {
			n := float64(i*dsp.EchoFrame + k)
			ref[k] = float32(0.3 * math.Sin(2*math.Pi*523*n/48000))
			mic[k] = float32(0.05*math.Sin(2*math.Pi*197*n/48000)) + 0.5*ref[k]
		}
		return
	}

	t.Run("echo cancellation on", func(t *testing.T) {
		// The full chain, as a call would have it, and the echo canceller alone, fed the same.
		s := &sender{}
		s.setChain(&dsp.Settings{Echo: true, Noise: true, Gain: true})
		if s.chain == nil {
			t.Fatal("no chain")
		}
		defer s.chain.Close()
		alone, err := dsp.NewChain(dsp.Settings{Echo: true})
		if err != nil {
			t.Fatal(err)
		}
		defer alone.Close()
		var heardAll, echoAll, outAll []float32
		for i := range 400 {
			mic, ref := block(i)
			out := s.chain.Process(mic, ref)
			heard := s.captionInput(mic)
			heardAll = append(heardAll, heard...)
			outAll = append(outAll, out...)
			echoAll = append(echoAll, alone.Process(mic, ref)...)
		}
		if len(heardAll) == 0 || !slices.Equal(heardAll, echoAll) {
			t.Fatalf("captions didn't hear exactly the echo canceller's output (%d samples, want %d)", len(heardAll), len(echoAll))
		}
		// And not what came out the end of the chain (gain changed that).
		n := min(len(outAll), len(heardAll))
		if slices.Equal(outAll[n-4800:n], heardAll[n-4800:n]) {
			t.Fatal("captions heard the chain's output, gain and all")
		}
		// It did cancel: by the end, the speakers' share of the mic is well down.
		mic, _ := block(399)
		if e, m := energy(heardAll[len(heardAll)-dsp.EchoFrame:]), energy(mic); e > m/4 {
			t.Fatalf("not echo cancelled: %.4g of %.4g", e, m)
		}
	})

	t.Run("echo cancellation off", func(t *testing.T) {
		s := &sender{}
		s.setChain(&dsp.Settings{Noise: true, Gain: true})
		if s.chain == nil {
			t.Fatal("no chain")
		}
		defer s.chain.Close()
		for i := range 50 {
			mic, ref := block(i)
			s.chain.Process(mic, ref)
			if heard := s.captionInput(mic); &heard[0] != &mic[0] || len(heard) != len(mic) {
				t.Fatal("captions didn't hear the raw block")
			}
		}
	})

	t.Run("no processing at all", func(t *testing.T) {
		s := &sender{}
		mic, _ := block(0)
		if heard := s.captionInput(mic); &heard[0] != &mic[0] {
			t.Fatal("captions didn't hear the raw block")
		}
	})
}

func energy(x []float32) float64 {
	s := 0.0
	for _, v := range x {
		s += float64(v) * float64(v)
	}
	return s
}

// The tap is on the sender's goroutine every block while captions listen,
// and the gate's goroutine runs every block too: neither allocates.
func TestCaptionTapAllocatesNothing(t *testing.T) {
	// Its goroutines not running: the test is them.
	e := &Engine{}
	c := makeCaptioner(e)
	e.captions = c
	s := &sender{e: e}
	s.setChain(&dsp.Settings{Echo: true, Gain: true})
	defer s.chain.Close()
	mic := make([]float32, 128)
	ref := make([]float32, 128)
	for i := range mic {
		mic[i] = float32(math.Sin(float64(i)))
	}
	// Drained as the gate goroutine would, without it (it isn't listening: nothing's ready).
	tap := func() {
		out := s.chain.Process(mic, ref)
		s.tapCaptions(mic, out)
		c.free <- <-c.full
	}
	for range 100 {
		tap()
	}
	if a := testing.AllocsPerRun(2000, tap); a > 0 {
		t.Fatalf("%v allocations a block tapping captions", a)
	}
	// The gate and decimator on the other side: the same, with a segment open the whole time.
	g := captions.NewGate(audio.SampleRate, 200, 200, 1000)
	loud := float32(0.5)
	gate := func() {
		g.Push(mic, loud, c)
		// What the recogniser would take: given straight back.
		for {
			select {
			case k := <-c.queue:
				c.chunks <- k
				continue
			default:
			}
			break
		}
	}
	for range 100 {
		gate()
	}
	if a := testing.AllocsPerRun(2000, gate); a > 0 {
		t.Fatalf("%v allocations a block in the gate goroutine", a)
	}
}

// Off (or muted) is off: the sender only looks at one flag.
func TestCaptionsOffByDefault(t *testing.T) {
	e := New(Options{Backend: audio.Fake{}})
	if e.captions.on.Load() {
		t.Fatal("captions listening with nothing configured")
	}
	e.captions.setAllowed(true)
	if e.captions.on.Load() {
		t.Fatal("captions listening before a recogniser is ready")
	}
}
