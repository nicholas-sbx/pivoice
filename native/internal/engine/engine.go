// Package engine is everything the app does with audio: the sound card,
// the WebRTC connections to everyone in the room, and the low-latency
// engine's pipeline, driven by the page over the bridge.
package engine

import (
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

// LoopID is the pretend person the mic test's packets come back from (LOOP_ID in src/audio/ll/config.ts).
const LoopID = "__loop"

const (
	levelsEvery = 50 * time.Millisecond
	pingEvery   = time.Second
)

type Options struct {
	Backend audio.Backend
	// Offer loopback ICE candidates too (tests, with everything on one machine).
	Loopback bool
}

type peerPrefs struct {
	volume   float64
	silenced bool
	angle    float64
}

type Engine struct {
	opts  Options
	emitM sync.Mutex
	emitF func(any)
	start time.Time

	mu       sync.Mutex
	links    map[string]*link
	people   map[string]*remote
	prefs    map[string]*peerPrefs
	deafSet  map[string]bool
	muted    bool
	spatial  string
	cfg      proto.Config
	stream   audio.Stream
	audioErr string
	testPath string
	loop     *remote
	stopTick chan struct{}
	readAt   map[*source]time.Time

	// Shared with the audio thread and the sender.
	remotes   atomic.Pointer[[]*remote]
	deafened  atomic.Bool
	capturing atomic.Bool
	rawLoop   atomic.Bool
	dtx       atomic.Bool
	jitter    atomic.Pointer[jitterCfg]
	llConfig  atomic.Pointer[proto.LLConfig]
	targets   atomic.Pointer[targets]
	selfLevel atomic.Uint32
	capture   chan capBlock
	capFree   chan []float32
	mixer     *mixer
}

func New(opts Options) *Engine {
	e := &Engine{
		opts:    opts,
		start:   time.Now(),
		links:   map[string]*link{},
		people:  map[string]*remote{},
		prefs:   map[string]*peerPrefs{},
		deafSet: map[string]bool{},
		readAt:  map[*source]time.Time{},
		spatial: "off",
		capture: make(chan capBlock, capSlots),
		capFree: make(chan []float32, capSlots),
	}
	for range capSlots {
		e.capFree <- make([]float32, 0, 1024)
	}
	e.mixer = &mixer{e: e}
	e.remotes.Store(&[]*remote{})
	e.targets.Store(&targets{})
	llc := proto.DefaultLL
	e.setLL(llc)
	go (&sender{e: e}).run()
	go e.pinger()
	return e
}

// SetEmitter says where messages for the page go (the bridge). Safe from any goroutine.
func (e *Engine) SetEmitter(f func(any)) {
	e.emitM.Lock()
	e.emitF = f
	e.emitM.Unlock()
}

func (e *Engine) emit(msg any) {
	e.emitM.Lock()
	f := e.emitF
	e.emitM.Unlock()
	if f != nil {
		f(msg)
	}
}

func (e *Engine) nowMs() float64 { return float64(time.Since(e.start)) / float64(time.Millisecond) }

// Reset drops everything: a new page (or a reload) starts from nothing.
func (e *Engine) Reset() {
	e.mu.Lock()
	for id := range e.links {
		e.closeLinkLocked(id)
	}
	e.stopTestLocked()
	e.closeAudioLocked()
	e.people = map[string]*remote{}
	e.prefs = map[string]*peerPrefs{}
	e.deafSet = map[string]bool{}
	e.muted = false
	e.deafened.Store(false)
	e.publishLocked()
	e.mu.Unlock()
}

// Handle one message from the page.
func (e *Engine) Handle(m proto.In) {
	switch m.T {
	case "config":
		if m.Config != nil {
			e.configure(*m.Config)
		}
	case "self":
		e.mu.Lock()
		e.muted = m.Muted
		e.deafened.Store(m.Deafened)
		e.rebuildLocked()
		e.mu.Unlock()
	case "members":
		e.mu.Lock()
		e.deafSet = map[string]bool{}
		for _, mm := range m.Members {
			e.deafSet[mm.ID] = mm.Deafened
		}
		e.rebuildLocked()
		e.mu.Unlock()
	case "peer":
		e.peer(m)
	case "link":
		e.linkOp(m)
	case "audio":
		e.mu.Lock()
		if m.On {
			e.openAudioLocked()
		} else {
			e.stopTestLocked()
			e.closeAudioLocked()
		}
		e.mu.Unlock()
	case "test":
		e.mu.Lock()
		e.stopTestLocked()
		if m.Path != "" {
			e.startTestLocked(m.Path)
		}
		e.mu.Unlock()
	case "stats":
		e.emit(e.stats())
	case "devices":
		e.emit(proto.Devices{T: "devices", Devices: e.opts.Backend.Devices()})
	}
}

// ---- settings ----------------------------------------------------------------

func (e *Engine) setLL(c proto.LLConfig) {
	e.llConfig.Store(&c)
	ver := uint64(1)
	if old := e.jitter.Load(); old != nil {
		ver = old.ver + 1
	}
	e.jitter.Store(&jitterCfg{ver: ver, cfg: ll.JitterConfig{
		SampleRate: audio.SampleRate,
		MinMs:      c.MinBufferMs,
		MaxMs:      c.MaxBufferMs,
		MarginMs:   c.MarginMs,
		Multiplier: c.JitterMultiplier,
		Stretch:    c.StretchPct / 100,
		ConcealMs:  c.ConcealMs,
		Percentile: c.JitterPercentile,
		WindowSec:  c.JitterWindowSec,
	}})
}

func (e *Engine) configure(c proto.Config) {
	e.setLL(c.LL)
	// Applies to links made from now on: it's in the SDP (the page reconnects you when it changes).
	e.dtx.Store(c.DTX)
	e.mu.Lock()
	defer e.mu.Unlock()
	devicesChanged := c.InputID != e.cfg.InputID || c.OutputID != e.cfg.OutputID
	e.cfg = c
	e.spatial = c.Spatial
	for id, r := range e.people {
		e.applyPrefsLocked(id, r)
	}
	if devicesChanged && e.stream != nil {
		e.closeAudioLocked()
		e.openAudioLocked()
	}
}

func (e *Engine) peer(m proto.In) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := e.prefs[m.ID]
	if p == nil {
		p = &peerPrefs{volume: 1, angle: math.Pi}
		e.prefs[m.ID] = p
	}
	if m.Volume != nil {
		p.volume = max(0, min(1, *m.Volume))
	}
	if m.Silenced != nil {
		p.silenced = *m.Silenced
	}
	if m.Angle != nil {
		p.angle = *m.Angle
	}
	if r := e.people[m.ID]; r != nil {
		e.applyPrefsLocked(m.ID, r)
	}
}

// applyPrefsLocked sets someone's gain and pan for the audio thread.
// Panning is equal-power, from the direction of their seat (seatDirection
// in src/lib/seats.ts), the same law as Web Audio's "equalpower" panner.
// HRTF isn't done natively yet, so it pans the same way.
func (e *Engine) applyPrefsLocked(id string, r *remote) {
	p := e.prefs[id]
	if p == nil {
		p = &peerPrefs{volume: 1, angle: math.Pi}
	}
	g := float32(p.volume)
	if p.silenced {
		g = 0
	}
	storeF(&r.gain, g)
	if e.spatial == "off" || r.test {
		storeF(&r.panL, 1)
		storeF(&r.panR, 1)
		return
	}
	x := -math.Sin(p.angle)
	z := math.Cos(p.angle) - 1
	if l := math.Hypot(x, z); l > 1e-9 {
		x /= l
	} else {
		x = 0
	}
	pos := (math.Asin(max(-1, min(1, x)))/(math.Pi/2) + 1) / 2
	storeF(&r.panL, float32(math.Cos(pos*math.Pi/2)))
	storeF(&r.panR, float32(math.Sin(pos*math.Pi/2)))
}

// ---- the people we hear ---------------------------------------------------------

// publishLocked hands the audio thread a fresh list of everyone (never edited in place).
func (e *Engine) publishLocked() {
	list := make([]*remote, 0, len(e.people)+1)
	for _, r := range e.people {
		list = append(list, r)
	}
	if e.loop != nil {
		list = append(list, e.loop)
	}
	e.remotes.Store(&list)
}

// attach puts a link's incoming audio onto that person's strip.
func (e *Engine) attach(l *link) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if l.closed.Load() || e.links[l.id] != l {
		return
	}
	r := e.people[l.peer]
	if r == nil {
		r = newRemote(l.peer)
		e.people[l.peer] = r
		e.applyPrefsLocked(l.peer, r)
	}
	if l.kind == "ll" {
		r.ll.Store(l.src)
	} else {
		r.voice.Store(l.src)
	}
	e.publishLocked()
	e.rebuildLocked()
}

// rebuildLocked works out who gets what we say, the way the browser does
// (updateSenders in session.ts, send() in worker.ts): nobody while we're
// muted, nobody who's deafened, and people on the low-latency engine
// don't get it twice over the call.
func (e *Engine) rebuildLocked() {
	t := &targets{muted: e.muted}
	llUp := map[string]bool{}
	for _, l := range e.links {
		if l.kind == "ll" && l.up.Load() {
			llUp[l.peer] = true
			if !e.deafSet[l.peer] {
				t.ll = append(t.ll, l)
			}
		}
	}
	for _, l := range e.links {
		if l.kind == "voice" && l.up.Load() && !e.deafSet[l.peer] && !llUp[l.peer] {
			t.voice = append(t.voice, l)
		}
	}
	if e.loop != nil {
		t.loop = e.loop.ll.Load()
	}
	e.targets.Store(t)
	e.capturing.Store(e.stream != nil && (t.loop != nil || (!t.muted && (len(t.ll) > 0 || len(t.voice) > 0))))
}

func (e *Engine) rebuildTargets() {
	e.mu.Lock()
	e.rebuildLocked()
	e.mu.Unlock()
}

// ---- links ------------------------------------------------------------------------

func (e *Engine) linkOp(m proto.In) {
	switch m.Op {
	case "open":
		e.mu.Lock()
		if old := e.links[m.Link]; old != nil {
			e.mu.Unlock()
			return
		}
		e.mu.Unlock()
		l, err := e.openLink(m)
		if err != nil {
			log.Printf("%s link %s: %v", m.Kind, m.Link, err)
			e.emit(proto.LinkState{T: "link", Link: m.Link, State: "closed"})
			return
		}
		e.mu.Lock()
		e.links[l.id] = l
		e.mu.Unlock()
	case "signal":
		e.mu.Lock()
		l := e.links[m.Link]
		e.mu.Unlock()
		if l != nil {
			go l.onSignal(m.Signal)
		}
	case "close":
		e.closeLink(m.Link)
	}
}

func (e *Engine) closeLink(id string) {
	e.mu.Lock()
	e.closeLinkLocked(id)
	e.mu.Unlock()
}

func (e *Engine) closeLinkLocked(id string) {
	l := e.links[id]
	if l == nil {
		return
	}
	delete(e.links, id)
	l.close()
	if r := e.people[l.peer]; r != nil {
		r.ll.CompareAndSwap(l.src, nil)
		r.voice.CompareAndSwap(l.src, nil)
		if r.ll.Load() == nil && r.voice.Load() == nil {
			delete(e.people, l.peer)
		}
	}
	e.publishLocked()
	e.rebuildLocked()
	go e.emit(proto.LinkState{T: "link", Link: id, State: "closed"})
}

func (e *Engine) pinger() {
	for range time.Tick(pingEvery) {
		e.mu.Lock()
		var up []*link
		for _, l := range e.links {
			if l.kind == "ll" && l.up.Load() {
				up = append(up, l)
			}
		}
		e.mu.Unlock()
		now := e.nowMs()
		for _, l := range up {
			_ = l.dc.Send(ll.EncodePing(ll.Ping, now))
		}
	}
}

// ---- the sound card ------------------------------------------------------------------

func (e *Engine) openAudioLocked() {
	if e.stream != nil {
		// Already open: say so anyway, since the page waits for an answer.
		e.emitAudioLocked()
		return
	}
	s, err := e.opts.Backend.Open(e.cfg.InputID, e.cfg.OutputID, e.mixer.process)
	if err != nil {
		e.audioErr = err.Error()
		log.Printf("audio: %v", err)
		e.emitAudioLocked()
		return
	}
	e.stream = s
	e.audioErr = ""
	e.stopTick = make(chan struct{})
	go e.levels(e.stopTick)
	e.rebuildLocked()
	e.emitAudioLocked()
}

// AudioOn: whether the sound card is open.
func (e *Engine) AudioOn() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stream != nil
}

func (e *Engine) closeAudioLocked() {
	if e.stream == nil {
		return
	}
	close(e.stopTick)
	_ = e.stream.Close()
	e.stream = nil
	e.rebuildLocked()
	e.emitAudioLocked()
}

func (e *Engine) emitAudioLocked() {
	st := proto.AudioState{T: "audio", On: e.stream != nil, Error: e.audioErr}
	if e.stream != nil {
		st.Info = e.stream.Info()
		hasMic := false
		for _, d := range e.opts.Backend.Devices() {
			hasMic = hasMic || d.Input
		}
		if !hasMic {
			st.MicProblem = "missing"
		}
	}
	go e.emit(st)
}

// levels sends everyone's loudness (and your mic's) for the speaking rings and the meter.
func (e *Engine) levels(stop chan struct{}) {
	t := time.NewTicker(levelsEvery)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		msg := proto.Levels{T: "levels", Self: float64(math.Float32frombits(e.selfLevel.Swap(0))), Remotes: map[string]float64{}}
		for _, r := range *e.remotes.Load() {
			if !r.test {
				msg.Remotes[r.id] = float64(math.Float32frombits(r.level.Swap(0)))
			}
		}
		e.emit(msg)
	}
}

// ---- mic test -------------------------------------------------------------------------

// Raw is the mic straight to the speakers inside the duplex callback,
// the same as a pw-loopback: the floor for everything else. Low latency
// is the whole engine, looped back: gate, encoder, packets, decoder,
// jitter buffer.
func (e *Engine) startTestLocked(path string) {
	e.testPath = path
	switch path {
	case "raw":
		e.rawLoop.Store(true)
	case "ll":
		r := newRemote(LoopID)
		r.test = true
		r.ll.Store(newSource())
		e.loop = r
		e.publishLocked()
		e.rebuildLocked()
	}
}

func (e *Engine) stopTestLocked() {
	e.testPath = ""
	e.rawLoop.Store(false)
	if e.loop != nil {
		e.loop = nil
		e.publishLocked()
		e.rebuildLocked()
	}
}
