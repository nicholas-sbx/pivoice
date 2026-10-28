package engine

import (
	"encoding/json"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

// A pretend page for one engine: it passes the engine's signals to the
// other engine, the way the room would, and keeps what else it's told.
type page struct {
	t      *testing.T
	e      *Engine
	name   string
	peer   *page
	mu     sync.Mutex
	levels map[string]float64
	states map[string][]string
}

func newPage(t *testing.T, name string) *page {
	p := &page{t: t, name: name, levels: map[string]float64{}, states: map[string][]string{}}
	p.e = New(Options{Backend: audio.Fake{}, Loopback: true})
	p.e.SetEmitter(p.on)
	cfg := proto.Config{LL: proto.DefaultLL, Spatial: "off"}
	p.e.Handle(proto.In{T: "config", Config: &cfg})
	p.e.Handle(proto.In{T: "audio", On: true})
	t.Cleanup(p.e.Reset)
	return p
}

func (p *page) on(msg any) {
	switch m := msg.(type) {
	case proto.SignalOut:
		raw, _ := json.Marshal(m.Signal)
		go p.peer.e.Handle(proto.In{T: "link", Op: "signal", Link: m.Link, Signal: raw})
	case proto.LinkState:
		p.mu.Lock()
		p.states[m.Link] = append(p.states[m.Link], m.State)
		p.mu.Unlock()
	case proto.Levels:
		p.mu.Lock()
		for id, v := range m.Remotes {
			p.levels[id] = max(p.levels[id], v)
		}
		p.mu.Unlock()
	}
}

func (p *page) loudest(id string) float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.levels[id]
}

func (p *page) has(link, state string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.states[link] {
		if s == state {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// Two people, one link of this kind between them: each should hear the other's beeps.
func call(t *testing.T, kind string) (a, b *page) {
	a, b = newPage(t, "a"), newPage(t, "b")
	a.peer, b.peer = b, a
	a.e.Handle(proto.In{T: "members", Members: []proto.Member{{ID: "b"}}})
	b.e.Handle(proto.In{T: "members", Members: []proto.Member{{ID: "a"}}})
	b.e.Handle(proto.In{T: "link", Op: "open", Link: "L", Peer: "a", Kind: kind})
	a.e.Handle(proto.In{T: "link", Op: "open", Link: "L", Peer: "b", Kind: kind, Offerer: true})
	return a, b
}

func TestLowLatencyLink(t *testing.T) {
	a, b := call(t, "ll")
	waitFor(t, "the channel to open", func() bool { return a.has("L", "ll-up") && b.has("L", "ll-up") })
	waitFor(t, "b to hear a", func() bool { return b.loudest("a") > 0.05 })
	waitFor(t, "a to hear b", func() bool { return a.loudest("b") > 0.05 })

	// The route card's numbers: raw PCM by default, ping from the engine's own pings, and a measured mouth to ear.
	waitFor(t, "stats", func() bool {
		st := b.e.stats().Peers["a"]
		return st.Engine == "ll" && st.Codec != nil && *st.Codec == "pcm" && st.RttMs != nil && st.MeasuredMs != nil
	})
	st := b.e.stats().Peers["a"]
	t.Logf("ll: measured %.1f ms, buffer %v, rtt %.2f ms, route %v", *st.MeasuredMs, deref(st.BufferMs), *st.RttMs, deref(st.Route))
	if *st.MeasuredMs > 40 {
		t.Errorf("mouth to ear %.1f ms over loopback with fake devices; expected well under 40", *st.MeasuredMs)
	}
}

func TestOpusOverLowLatencyLink(t *testing.T) {
	a, b := call(t, "ll")
	c := proto.Config{LL: proto.DefaultLL, Spatial: "off"}
	c.LL.Codec = "opus"
	c.LL.FrameMs = 2.5
	a.e.Handle(proto.In{T: "config", Config: &c})
	waitFor(t, "b to hear a in Opus", func() bool {
		st := b.e.stats().Peers["a"]
		return st.Codec != nil && *st.Codec == "opus" && b.loudest("a") > 0.05
	})
}

func TestCall(t *testing.T) {
	a, b := call(t, "voice")
	waitFor(t, "the call to connect", func() bool { return a.has("L", "connected") && b.has("L", "connected") })
	waitFor(t, "b to hear a over RTP", func() bool { return b.loudest("a") > 0.05 })
	waitFor(t, "a to hear b over RTP", func() bool { return a.loudest("b") > 0.05 })
	st := b.e.stats().Peers["a"]
	if st.Engine != "webrtc" {
		t.Fatalf("engine %q", st.Engine)
	}
}

func TestMutedSendsNothing(t *testing.T) {
	a, b := call(t, "ll")
	waitFor(t, "b to hear a", func() bool { return b.loudest("a") > 0.05 })
	a.e.Handle(proto.In{T: "self", Muted: true})
	time.Sleep(300 * time.Millisecond)
	b.e.stats() // reset the byte count
	time.Sleep(1200 * time.Millisecond)
	if k := b.e.stats().Peers["a"].Kbps; k == nil || *k > 1 {
		t.Fatalf("a is muted but b still gets %v kbps", deref(k))
	}
}

func TestMicTestLoop(t *testing.T) {
	p := newPage(t, "solo")
	p.e.Handle(proto.In{T: "test", Path: "ll"})
	waitFor(t, "the loop to measure itself", func() bool {
		ts := p.e.stats().Test
		return ts != nil && ts.Measured && ts.Ms != nil
	})
	t.Logf("mic test, low latency: %.1f ms (%s)", *p.e.stats().Test.Ms, p.e.stats().Test.Detail)
}

func deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// The audio thread's block (drain, jitter buffer, mix) with someone talking
// shouldn't allocate: an allocating audio thread gets drafted into the
// garbage collector's work, which is exactly when it can't afford to be late.
func TestMixerDoesNotAllocate(t *testing.T) {
	e := New(Options{Backend: audio.Fake{}})
	r := newRemote("someone")
	src := newSource()
	r.ll.Store(src)
	e.people["someone"] = r
	e.publishLocked()
	in := make([]float32, 128)
	out := make([]float32, 256)
	frames := make([][]float32, 4096)
	for i := range frames {
		frames[i] = make([]float32, 128)
	}
	k := 0
	block := func() {
		// What the network side does: a frame a block, straight on time.
		src.deliver(float64(k*128), frames[k%len(frames)])
		k++
		e.mixer.process(in, out, audio.Times{})
	}
	for range 2000 {
		block()
	}
	if a := testing.AllocsPerRun(2000, block); a > 0 {
		t.Fatalf("%.2f allocations per block on the audio thread", a)
	}
}

func TestWoodworth(t *testing.T) {
	if d := woodworth(0); d != 0 {
		t.Fatalf("straight ahead: %v samples", d)
	}
	// Straight to one side: 0.0875/343 × (π/2 + 1) s = 0.656 ms = 31.5 samples, on the far ear.
	if d := woodworth(-1); math.Abs(d-31.5) > 0.1 {
		t.Fatalf("hard left: %v samples", d)
	}
	if d := woodworth(1); math.Abs(d+31.5) > 0.1 {
		t.Fatalf("hard right: %v samples", d)
	}
}

// Someone on your right: the right ear hears a click when it happens, the left exactly the ITD later.
func TestITDDelaysOnlyTheFarEar(t *testing.T) {
	r := newRemote("x")
	const itd = -20.5 // on the right: the left ear is late
	r.itdNow = itd
	mix := make([]float32, 128)
	mix[0] = 1
	out := make([]float32, 256)
	r.mixITD(mix, out, 1, 1, itd)
	if out[1] != 1 {
		t.Fatalf("near (right) ear: %v at 0, want the click on time", out[1])
	}
	if out[2*20] != 0.5 || out[2*21] != 0.5 {
		t.Fatalf("far (left) ear: %v, %v at 20, 21, want the click split between them", out[2*20], out[2*21])
	}
	for i := range 128 {
		if i != 20 && i != 21 && out[2*i] != 0 {
			t.Fatalf("far ear has %v at %d", out[2*i], i)
		}
	}
	if a := testing.AllocsPerRun(100, func() { r.mixITD(mix, out, 1, 1, itd) }); a > 0 {
		t.Fatalf("%v allocations", a)
	}
}
