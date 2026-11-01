package engine

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
	"github.com/pion/webrtc/v4"
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

// Two people, one link between them: each should hear the other's beeps.
func call(t *testing.T) (a, b *page) {
	a, b = newPage(t, "a"), newPage(t, "b")
	a.peer, b.peer = b, a
	a.e.Handle(proto.In{T: "members", Members: []proto.Member{{ID: "b"}}})
	b.e.Handle(proto.In{T: "members", Members: []proto.Member{{ID: "a"}}})
	b.e.Handle(proto.In{T: "link", Op: "open", Link: "L", Peer: "a"})
	a.e.Handle(proto.In{T: "link", Op: "open", Link: "L", Peer: "b", Offerer: true})
	return a, b
}

func TestLowLatencyLink(t *testing.T) {
	a, b := call(t)
	waitFor(t, "the channel to open", func() bool { return a.has("L", "up") && b.has("L", "up") })
	waitFor(t, "b to hear a", func() bool { return b.loudest("a") > 0.05 })
	waitFor(t, "a to hear b", func() bool { return a.loudest("b") > 0.05 })

	// The route card's numbers: raw PCM's bitrate, ping from the engine's own pings, and a measured mouth to ear.
	waitFor(t, "stats", func() bool {
		st := b.e.stats().Peers["a"]
		return st.Kbps != nil && *st.Kbps > 100 && st.RttMs != nil && st.MeasuredMs != nil
	})
	st := b.e.stats().Peers["a"]
	t.Logf("ll: measured %.1f ms, buffer %v, rtt %.2f ms, route %v", *st.MeasuredMs, deref(st.BufferMs), *st.RttMs, deref(st.Route))
	if *st.MeasuredMs > 40 {
		t.Errorf("mouth to ear %.1f ms over loopback with fake devices; expected well under 40", *st.MeasuredMs)
	}
}

// What a link takes in: raw PCM, a few frames a packet, each starting
// where the last ended. Opus, packets of many frames, and frames piled on
// top of each other (to fill the jitter buffer) go nowhere.
func TestReceiveTakesOnlyWhatWeSend(t *testing.T) {
	pcm := func(n int) []byte { return ll.PCMToBytes(make([]float32, n)) }
	got := func(buf []byte) int {
		e := New(Options{Backend: audio.Fake{}})
		s := newSource()
		e.receiveLL(s, buf)
		return len(s.inbox)
	}
	cases := []struct {
		name string
		buf  []byte
		want int
	}{
		{"one frame", ll.EncodePacket([]ll.Frame{{TS: 0, Data: pcm(128)}}, 0, false, true), 1},
		{"a repeat and the new one", ll.EncodePacket([]ll.Frame{{TS: 0, Data: pcm(128)}, {TS: 128, Data: pcm(128)}}, 0, false, true), 2},
		{"opus", ll.EncodePacket([]ll.Frame{{TS: 0, Data: []byte{0xfc, 0xff, 0xfe}}}, 0, false, false), 0},
		{"too many frames", ll.EncodePacket([]ll.Frame{{TS: 0, Data: pcm(1)}, {TS: 1, Data: pcm(1)}, {TS: 2, Data: pcm(1)}, {TS: 3, Data: pcm(1)}}, 0, false, true), 0},
		{"a frame too long", ll.EncodePacket([]ll.Frame{{TS: 0, Data: pcm(8*pcmFrame + 1)}}, 0, false, true), 0},
		{"an empty frame", ll.EncodePacket([]ll.Frame{{TS: 0, Data: nil}}, 0, false, true), 0},
		{"overlapping frames", ll.EncodePacket([]ll.Frame{{TS: 0, Data: pcm(128)}, {TS: 1, Data: pcm(128)}, {TS: 2, Data: pcm(128)}}, 0, false, true), 1},
	}
	for _, c := range cases {
		if n := got(c.buf); n != c.want {
			t.Errorf("%s: %d frames delivered, want %d", c.name, n, c.want)
		}
	}
}

// A peer that offers audio tracks gets them turned down: the link knows no
// codecs, so nothing a peer sends is ever decoded but our own packets.
func TestNoMediaAccepted(t *testing.T) {
	p := newPage(t, "b")
	var answer string
	var mu sync.Mutex
	p.e.SetEmitter(func(msg any) {
		if m, ok := msg.(proto.SignalOut); ok {
			if sdp, ok := m.Signal.(map[string]any)["sdp"].(map[string]any); ok {
				mu.Lock()
				answer, _ = sdp["sdp"].(string)
				mu.Unlock()
			}
		}
	})
	p.e.Handle(proto.In{T: "link", Op: "open", Link: "L", Peer: "a"})
	offer := offerWithAudio(t)
	raw, _ := json.Marshal(map[string]any{"sdp": map[string]any{"type": "offer", "sdp": offer}})
	p.e.Handle(proto.In{T: "link", Op: "signal", Link: "L", Signal: raw})
	waitFor(t, "an answer", func() bool { mu.Lock(); defer mu.Unlock(); return answer != "" })
	t.Logf("answer m-lines: %q", mlines(answer))
	for _, line := range strings.Split(answer, "\r\n") {
		if strings.HasPrefix(line, "m=audio") && !strings.HasPrefix(line, "m=audio 0 ") {
			t.Fatalf("audio accepted: %q\n%s", line, answer)
		}
		if strings.HasPrefix(line, "a=rtpmap:") {
			t.Fatalf("a codec in the answer: %q", line)
		}
	}
}

// offerWithAudio is what a peer that wants to send us Opus would offer: two audio tracks and our data channel.
func offerWithAudio(t *testing.T) string {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(m)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	for i := range 2 {
		tr, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, fmt.Sprint("a", i), "s")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pc.AddTrack(tr); err != nil {
			t.Fatal(err)
		}
	}
	yes, id := true, uint16(llChannelID)
	if _, err := pc.CreateDataChannel("pv-audio", &webrtc.DataChannelInit{Negotiated: &yes, ID: &id}); err != nil {
		t.Fatal(err)
	}
	o, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	return o.SDP
}

func TestMutedSendsNothing(t *testing.T) {
	a, b := call(t)
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

// With the mic's processing on (no gate: a beep isn't a voice), the other
// side still hears us, and the mic test's mouth to ear counts the processing.
func TestProcessedMic(t *testing.T) {
	a, b := call(t)
	cfg := proto.Config{LL: proto.DefaultLL, Spatial: "off", Processing: proto.Processing{Echo: true, Noise: true, Gain: true}}
	a.e.Handle(proto.In{T: "config", Config: &cfg})
	waitFor(t, "b to hear a", func() bool { return b.loudest("a") > 0.02 })
	a.e.Handle(proto.In{T: "test", Path: "ll"})
	waitFor(t, "the loop to measure itself", func() bool {
		ts := a.e.stats().Test
		return ts != nil && ts.Measured && ts.Ms != nil
	})
	t.Logf("mic test with processing: %.1f ms", *a.e.stats().Test.Ms)
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
	r.src.Store(src)
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
	// And handing the mic over, with what played for echo cancellation.
	go func() {
		for b := range e.capture {
			e.capFree <- b.pcm
		}
	}()
	e.echoRef.Store(true)
	e.capturing.Store(true)
	for range 200 {
		block()
	}
	if a := testing.AllocsPerRun(2000, block); a > 0 {
		t.Fatalf("%.2f allocations per block handing over the mic", a)
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
	r.mixHead(mix, out, 1, 1, itd, shadowFront, shadowFront)
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
	if a := testing.AllocsPerRun(100, func() { r.mixHead(mix, out, 1, 1, itd, shadowFront, shadowFront) }); a > 0 {
		t.Fatalf("%v allocations", a)
	}
}

func mlines(sdp string) []string {
	var out []string
	for _, l := range strings.Split(sdp, "\r\n") {
		if strings.HasPrefix(l, "m=") {
			out = append(out, l)
		}
	}
	return out
}

func TestICEServersKeepsOnlyRealOnes(t *testing.T) {
	in := []proto.IceServer{
		{URLs: "stun:stun.cloudflare.com:3478"},
		{URLs: []any{"turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp", "https://evil.example/", "turn:127.0.0.1:22", "stun:[::1]:3478", "stun:localhost", "stun:169.254.169.254:80", "stun:0.0.0.0"}, Username: "u", Credential: "c"},
		{URLs: "turn:10.0.0.1:3478"},
		{URLs: []any{"stun:127.0.0.1"}},
	}
	got := iceServers(in, false)
	var urls []string
	for _, s := range got {
		urls = append(urls, s.URLs...)
	}
	want := []string{"stun:stun.cloudflare.com:3478", "turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp", "turn:10.0.0.1:3478"}
	if strings.Join(urls, " ") != strings.Join(want, " ") {
		t.Fatalf("kept %q, want %q", urls, want)
	}
	if len(got) != 3 || got[1].Username != "u" {
		t.Fatalf("servers: %+v", got)
	}
	if n := len(iceServers(in, true)); n != 4 {
		t.Fatalf("with loopback on, %d servers, want all 4", n)
	}
}
