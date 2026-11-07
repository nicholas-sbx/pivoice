package engine

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/asr"
	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/captions"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

/*
Live captions in the app: you, recognised here, natively, and your words
sent to everyone on your links.

	sender goroutine ──(mic block, ring level)──▶ gate goroutine ──16 kHz──▶ recogniser goroutine ──▶ helper process
	  raw mic, or after echo cancellation          gate, pre/post-roll,        Vosk or Parakeet,          (internal/asr)
	  if that's on; never after noise               decimate                     words out to everyone
	  suppression or gain

What it hears: the mic before our processing, so the recogniser gets all of
your voice, with one exception: with echo cancellation on it hears the mic
after the echo canceller (and before noise suppression and gain). With echo
cancellation on you're probably on speakers, and the raw mic would hear
everyone else too, and caption you saying their words.

When: only while your ring would be lit (the page's rule, worked out here
from the same level), plus the pre-roll before and the post-roll after (the
gate, internal/captions). That's the privacy of it (whatever noise
suppression kept out of the call stays out of the captions) and the CPU of
it: the recogniser is given nothing, and does nothing, outside a segment. No
Vosk calls, no Parakeet reads, no re-reads.

What it costs:
  - captions off, or muted: one atomic load a block in the sender; the gate
    goroutine is asleep and the helper isn't running (or has nothing to do).
  - on, between segments: a copy of each block to the gate goroutine, its
    level, and the gate keeping the pre-roll. Nothing allocates (tested).
  - in a segment: decimating, and the recogniser's own work, in the helper
    at normal priority. The audio thread is realtime and never waits on any
    of it: blocks the gate goroutine isn't ready for are counted lost.
*/

const (
	// Mic blocks on their way to the gate goroutine, and 100 ms chunks of
	// 16 kHz on their way to the recogniser (6.4 s of them: a slow machine's
	// recogniser falls behind before anything's lost).
	capRecords   = 64
	chunkSamples = 1600
	chunkCount   = 64
	// Behind: more than this many chunks waiting. Live re-reads wait.
	behindChunks = 5
)

type capRecord struct {
	pcm   []float32
	n     int
	level float32
}

type capChunk struct {
	pcm []float32
	n   int
	end bool
}

// captionCtl: a request from the page for the recogniser goroutine ("download", "forget").
type captionCtl struct {
	op string
}

type captioner struct {
	e *Engine

	// Read by the sender every block: tap or not.
	on atomic.Bool
	// What rebuildLocked knows: unmuted, the sound card open, someone to send to (or you want your own).
	allowed atomic.Bool
	// What the recogniser goroutine knows: captions wanted, and ready.
	ready atomic.Bool

	free, full chan *capRecord
	chunks     chan *capChunk
	queue      chan *capChunk
	lost       atomic.Int64
	kick       chan struct{}
	ctl        chan captionCtl
	gateCfg    atomic.Pointer[[2]float64]
	// The page's latest settings: the recogniser goroutine takes them when it can (a slider's drag is many).
	pending atomic.Pointer[proto.Captions]
	newCfg  chan struct{}
	// Listening started or stopped (muted, unmuted, someone came or went): the page's told.
	listenChanged chan struct{}

	// Gate goroutine only.
	gate  *captions.Gate
	dec   captions.Decimator
	cur   *capChunk
	scrat []float32

	// Recogniser goroutine only (and cfg's copy, for rebuildLocked).
	mu  sync.Mutex
	cfg proto.Captions
	run int64
}

func newCaptioner(e *Engine) *captioner {
	c := makeCaptioner(e)
	go c.gateLoop()
	go c.recLoop()
	return c
}

// makeCaptioner: its buffers, made once, and nothing running yet.
func makeCaptioner(e *Engine) *captioner {
	c := &captioner{
		e:             e,
		free:          make(chan *capRecord, capRecords),
		full:          make(chan *capRecord, capRecords),
		chunks:        make(chan *capChunk, chunkCount),
		queue:         make(chan *capChunk, chunkCount+1),
		kick:          make(chan struct{}, 1),
		ctl:           make(chan captionCtl, 16),
		newCfg:        make(chan struct{}, 1),
		listenChanged: make(chan struct{}, 1),
		gate:          captions.NewGate(audio.SampleRate, 200, 200, 1000),
		scrat:         make([]float32, 0, audio.MaxBlock/3+1),
	}
	for range capRecords {
		c.free <- &capRecord{pcm: make([]float32, audio.MaxBlock)}
	}
	for range chunkCount {
		c.chunks <- &capChunk{pcm: make([]float32, chunkSamples)}
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	c.run = int64(binary.LittleEndian.Uint64(b[:]) & 0x7fffffff)
	return c
}

// configure: the page's caption settings (nil: an older page, captions off).
func (c *captioner) configure(cfg *proto.Captions) {
	if cfg == nil {
		cfg = &proto.Captions{}
	}
	cc := *cfg
	c.mu.Lock()
	c.cfg = cc
	c.mu.Unlock()
	c.gateCfg.Store(&[2]float64{cc.PreMs, cc.PostMs})
	c.pending.Store(&cc)
	select {
	case c.newCfg <- struct{}{}:
	default:
	}
}

func (c *captioner) request(op string) {
	select {
	case c.ctl <- captionCtl{op: op}:
	default:
	}
}

func (c *captioner) showOwn() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg.ShowOwn
}

// setAllowed is rebuildLocked's part; ready is the recogniser's. Tapping is both.
func (c *captioner) setAllowed(on bool) {
	c.allowed.Store(on)
	c.update()
}

func (c *captioner) update() {
	on := c.allowed.Load() && c.ready.Load()
	if c.on.Swap(on) != on {
		select {
		case c.kick <- struct{}{}:
		default:
		}
		select {
		case c.listenChanged <- struct{}{}:
		default:
		}
	}
}

// tap hands one block to the gate goroutine: the samples it should hear and
// the level the ring goes by. On the sender's goroutine, every block while
// captions are listening: a copy, no allocation, never a wait.
func (c *captioner) tap(pcm []float32, level float32) {
	if len(pcm) == 0 {
		return
	}
	select {
	case r := <-c.free:
		r.n = copy(r.pcm, pcm)
		r.level = level
		c.full <- r
	default:
		c.lost.Add(int64(len(pcm)))
	}
}

// ---- the gate goroutine -----------------------------------------------------------

func (c *captioner) gateLoop() {
	var applied [2]float64
	for {
		select {
		case r := <-c.full:
			if p := c.gateCfg.Load(); p != nil && *p != applied {
				applied = *p
				c.gate.Configure(applied[0], applied[1])
			}
			if c.on.Load() {
				c.gate.Push(r.pcm[:r.n], r.level, c)
			} else {
				c.gate.Reset(c)
			}
			c.free <- r
		case <-c.kick:
			if !c.on.Load() {
				// Muted, captions off, nobody to send to: whatever's open ends now, and the pre-roll goes.
				c.gate.Reset(c)
			}
		}
	}
}

// Start, Audio and End: the gate's sink, on the gate goroutine.
func (c *captioner) Start() { c.dec.Reset() }

func (c *captioner) Audio(pcm []float32) {
	c.scrat = c.dec.Push(pcm, c.scrat[:0])
	for s := c.scrat; len(s) > 0; {
		if c.cur == nil {
			select {
			case c.cur = <-c.chunks:
				c.cur.n, c.cur.end = 0, false
			default:
				// The recogniser is 6 s behind: this goes unheard.
				c.lost.Add(int64(len(s)) * 3)
				return
			}
		}
		n := copy(c.cur.pcm[c.cur.n:], s)
		c.cur.n += n
		s = s[n:]
		if c.cur.n == len(c.cur.pcm) {
			c.queue <- c.cur
			c.cur = nil
		}
	}
}

func (c *captioner) End() {
	if c.cur != nil {
		c.queue <- c.cur
		c.cur = nil
	}
	select {
	case k := <-c.chunks:
		k.n, k.end = 0, true
		c.queue <- k
	default:
		// No chunk free to say so: the recogniser's far behind; the next segment ends this one.
	}
}

// ---- the recogniser goroutine -------------------------------------------------------

type recState struct {
	cfg     proto.Captions
	model   asr.Model
	root    string
	phase   string
	bytes   int64
	total   int64
	err     string
	helper  *asr.Helper
	plan    *asr.Plan
	consent bool
	// The phrase: its number and what was last said of it.
	u           int64
	partialText string
	sinceReread int
	held        int
	// How hard it's working: seconds of work per second of speech, lately.
	busy, heard time.Duration
	rtf         *float64
	// The helper went (crashed, or stopped answering): started again after a pause, a few times running.
	crashes int
	retry   <-chan time.Time
}

func (c *captioner) recLoop() {
	st := &recState{phase: "off"}
	type fetched struct {
		plan *asr.Plan
		err  error
	}
	// The lookup or download under way, each with channels of its own: one
	// that's been cancelled (the settings changed under it) answers into
	// nothing anyone reads.
	var looked chan fetched
	var got chan error
	var progress chan int64
	var cancel context.CancelFunc
	stopFetch := func() {
		if cancel != nil {
			cancel()
			cancel = nil
		}
		looked, got, progress = nil, nil, nil
	}
	var last proto.CaptionState
	var lastRTF float64
	emit := func() {
		msg := proto.CaptionState{T: "captions", Model: st.cfg.Model, Phase: st.phase, Bytes: st.bytes, Total: st.total, Error: st.err, RTF: st.rtf, Listening: c.on.Load(), Hears: "raw"}
		if p := c.e.processing.Load(); p != nil && p.Echo {
			msg.Hears = "echo"
		}
		if st.root != "" && st.model.ID != "" {
			msg.CacheDir = asr.ModelPath(st.root, st.model)
		}
		// A page that never asked about captions hears nothing about them; and nobody hears the same thing twice.
		if st.cfg.Model == "" && msg.Phase == "off" {
			return
		}
		rtf := -1.0
		if msg.RTF != nil {
			rtf = *msg.RTF
		}
		cmp := msg
		cmp.RTF = nil
		if cmp == last && rtf == lastRTF {
			return
		}
		last, lastRTF = cmp, rtf
		c.e.emit(msg)
	}
	setReady := func(on bool) {
		c.ready.Store(on)
		c.update()
		c.e.rebuildTargets()
	}
	stop := func() {
		stopFetch()
		setReady(false)
		if st.helper != nil {
			st.helper.Close()
			st.helper = nil
		}
	}
	// begin: look for the model (and its runtime) for the current settings.
	begin := func() {
		stop()
		st.retry = nil
		st.err, st.bytes, st.total, st.plan = "", 0, 0, nil
		m, ok := asr.ModelByID(st.cfg.Model)
		if !st.cfg.Send || !ok {
			st.phase = "off"
			emit()
			return
		}
		st.model = m
		root, err := asr.Dir()
		if err != nil {
			st.phase, st.err = "error", "no cache folder: "+err.Error()
			emit()
			return
		}
		st.root = root
		st.phase = "checking"
		emit()
		ctx, cn := context.WithCancel(context.Background())
		cancel = cn
		site := c.e.opts.Site
		res := make(chan fetched, 1)
		looked = res
		go func() {
			p, err := asr.Look(ctx, root, site, m)
			res <- fetched{p, err}
		}()
	}
	load := func() {
		st.phase = "loading"
		emit()
		h, err := asr.StartHelper(st.root, st.model, asr.HelperOptions{Threads: st.cfg.Threads, MinConfidence: st.cfg.MinConfidence, MaxPhraseSec: st.cfg.MaxPhraseSec})
		if err != nil {
			log.Printf("captions: %v", err)
			st.phase, st.err = "error", err.Error()
			emit()
			return
		}
		st.helper = h
		st.phase = "ready"
		// A new helper counts phrases from 0 again: a new run, so nobody takes
		// its first phrases for ones already shown.
		c.run = (c.run + 1) & 0x7fffffff
		st.u, st.partialText, st.held, st.sinceReread = 0, "", 0, 0
		st.retry = nil
		setReady(true)
		emit()
	}
	fetch := func() {
		st.phase = "downloading"
		emit()
		ctx, cn := context.WithCancel(context.Background())
		cancel = cn
		p, site := st.plan, c.e.opts.Site
		done, prog := make(chan error, 1), make(chan int64, 1)
		got, progress = done, prog
		go func() {
			done <- p.Fetch(ctx, site, func(n int64) {
				// Only the latest count matters: replace whatever's waiting.
				select {
				case <-prog:
				default:
				}
				prog <- n
			})
		}()
	}
	statsAt := time.Now()
	var progressAt time.Time
	for {
		select {
		case <-c.newCfg:
			cfg := c.pending.Load()
			if cfg == nil {
				continue
			}
			old := st.cfg
			st.cfg = *cfg
			if old.Send != st.cfg.Send || old.Model != st.cfg.Model || old.Threads != st.cfg.Threads {
				begin()
			} else {
				if st.helper != nil && (old.MinConfidence != st.cfg.MinConfidence || old.MaxPhraseSec != st.cfg.MaxPhraseSec) {
					_ = st.helper.Configure(st.cfg.MinConfidence, st.cfg.MaxPhraseSec)
				}
				// The page's settings came with the processing's: what it hears may have changed.
				emit()
			}
			c.e.rebuildTargets()
		case m := <-c.ctl:
			switch {
			case m.op == "download":
				st.consent = true
				if st.phase == "needed" {
					fetch()
				}
			case m.op == "forget":
				if st.root != "" && st.model.ID != "" {
					stop()
					if err := asr.Forget(st.root, st.model); err != nil {
						log.Printf("captions: %v", err)
					}
					st.consent = false
					begin()
				}
			}
		case f := <-looked:
			cancel, looked = nil, nil
			switch {
			case f.err != nil:
				st.phase, st.err = "error", f.err.Error()
				emit()
			case f.plan.Done():
				load()
			default:
				st.plan, st.phase, st.total = f.plan, "needed", f.plan.Bytes
				emit()
				if st.consent {
					fetch()
				}
			}
		case n := <-progress:
			// For the page's bar: a few times a second, not every read off the network.
			st.bytes = n
			if time.Since(progressAt) >= 150*time.Millisecond || n >= st.total {
				progressAt = time.Now()
				emit()
			}
		case err := <-got:
			cancel, got, progress = nil, nil, nil
			if err != nil {
				log.Printf("captions: download: %v", err)
				st.phase, st.err = "error", err.Error()
				emit()
				continue
			}
			load()
		case <-c.listenChanged:
			emit()
		case <-st.retry:
			st.retry = nil
			begin()
		case k := <-c.queue:
			c.recognise(st, k)
			c.chunks <- k
			if st.helper == nil && st.phase == "error" && st.retry == nil && st.crashes < 3 {
				st.retry = time.After(5 * time.Second)
			}
			if time.Since(statsAt) > 2*time.Second {
				statsAt = time.Now()
				if st.heard > 0 {
					r := st.busy.Seconds() / st.heard.Seconds()
					st.rtf = &r
				}
				st.busy, st.heard = 0, 0
				emit()
			}
		}
	}
}

// recognise one chunk of a segment (or its end). This is the only place the recogniser is given work.
func (c *captioner) recognise(st *recState, k *capChunk) {
	h := st.helper
	if h == nil {
		return
	}
	t0 := time.Now()
	defer func() { st.busy += time.Since(t0) }()
	fail := func(err error) {
		log.Printf("captions: recogniser: %v", err)
		st.crashes++
		st.helper = nil
		h.Close()
		c.ready.Store(false)
		c.update()
		c.e.rebuildTargets()
		st.phase, st.err = "error", "the recogniser stopped: "+err.Error()
		c.e.emit(proto.CaptionState{T: "captions", Model: st.cfg.Model, Phase: st.phase, Error: st.err})
	}
	if k.end {
		text, err := h.Finish()
		if err != nil {
			fail(err)
			return
		}
		c.say(st, text, true)
		st.held, st.sinceReread = 0, 0
		// A whole phrase recognised: whatever went wrong before is behind it.
		st.crashes = 0
		return
	}
	pcm := k.pcm[:k.n]
	st.heard += time.Duration(len(pcm)) * time.Second / 16000
	st.held += len(pcm)
	text, ended, err := h.Accept(pcm)
	if err != nil {
		fail(err)
		return
	}
	if ended {
		c.say(st, text, true)
		st.held, st.sinceReread = 0, 0
		st.crashes = 0
		return
	}
	streaming := asr.Streams(st.model.Engine)
	if !streaming && float64(st.held) >= st.cfg.MaxPhraseSec*16000 {
		// A long phrase: finished here, the next picks up where it stops.
		text, err := h.Finish()
		if err != nil {
			fail(err)
			return
		}
		c.say(st, text, true)
		st.held, st.sinceReread = 0, 0
		return
	}
	if !st.cfg.Partials {
		return
	}
	if !streaming {
		st.sinceReread += len(pcm)
		if float64(st.sinceReread) < st.cfg.RereadMs*16 || len(c.queue) > behindChunks {
			return
		}
		st.sinceReread = 0
	}
	p, err := h.Partial()
	if err != nil {
		fail(err)
		return
	}
	c.say(st, p, false)
}

// say a phrase update: to the page (yours, to show if you want) and to everyone on your links.
func (c *captioner) say(st *recState, text string, final bool) {
	text = captions.Clean(text)
	if !final {
		if text == "" || text == st.partialText {
			return
		}
		st.partialText = text
	} else if text == "" && st.partialText == "" {
		return
	}
	c.e.emit(proto.CaptionOwn{T: "caption", Peer: "", U: st.u, Text: text, Final: final})
	c.e.sendCaption(captions.Encode(c.run, st.u, text, final))
	if final {
		st.u++
		st.partialText = ""
	}
}

// capLevel is a block's RMS, for the gate's ring.
func capLevel(x []float32) float32 {
	if len(x) == 0 {
		return 0
	}
	var s float32
	for _, v := range x {
		s += v * v
	}
	return float32(math.Sqrt(float64(s / float32(len(x)))))
}
