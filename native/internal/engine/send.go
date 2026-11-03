package engine

import (
	"log"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/dsp"
	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

/*
The sending side, a goroutine fed by the audio thread with every mic
block. The same pipeline as the browser engine's worker (worker.ts), so
the people on the other end can't tell which they're hearing:

our silence gate, then raw PCM, one 128-sample block per packet, each
packet repeating the last frame or two if asked to, and one in 20 carrying
a capture stamp. There's no codec: nothing that parses what anyone sends
is C (see the README, "Why no Opus").

Nothing is sent that nobody will hear: not while you're muted, and not
while nobody's listening.
*/

const (
	pcmFrame   = 128
	stampEvery = 20
	// Skip a packet rather than queue it behind this much unsent data: queued audio is late audio.
	maxBuffered = 16 * 1024
)

// targets is who to send to right now, rebuilt by the control side whenever that changes.
type targets struct {
	muted bool
	ll    []*link
	// The mic test's loop: what goes out comes straight back in here.
	loop *source
}

type sender struct {
	e   *Engine
	cfg proto.LLConfig

	// Low-latency framing.
	frame      []float32
	fill       int
	frameStart int64
	frameInMs  float64
	history    []ll.Frame
	sent       int
	gate       ll.Gate
	wasActive  bool

	// The mic's processing, while any of it is on, and what it was last
	// made for (so one that wouldn't start isn't retried every block).
	chain    *dsp.Chain
	chainFor dsp.Settings
	// Live captions: the ring's level, from the last block processing gave back.
	capLevel float32
}

func (s *sender) run() {
	for b := range s.e.capture {
		if c := s.e.llConfig.Load(); *c != s.cfg {
			s.configure(*c)
		}
		t := s.e.targets.Load()
		pcm := b.pcm
		if p := s.e.processing.Load(); p != nil || s.chain != nil {
			b = s.process(b, p)
		}
		// Live captions: one atomic load while they're off (or you're muted).
		if s.e.captions.on.Load() && !t.muted {
			s.tapCaptions(pcm, b.pcm)
		}
		s.feedLL(b, t)
		s.e.capFree <- pcm
	}
	s.setChain(nil)
}

// process the mic block through the chain, made (or remade) to the
// settings first. What comes out is stamped with the input samples it
// came from, so the capture stamps (mouth to ear) count the processing too.
func (s *sender) process(b capBlock, p *dsp.Settings) capBlock {
	switch {
	case p == nil:
		s.setChain(nil)
		return b
	case s.chain == nil:
		if *p != s.chainFor {
			s.setChain(p)
		}
	default:
		if !s.chain.Settings().SameStages(*p) {
			s.setChain(p)
		} else {
			s.chain.Retune(*p)
		}
	}
	if s.chain == nil {
		// It wouldn't start: the mic goes out as it is, and the meter (left to us while processing's on) still moves.
		raiseLevel(&s.e.selfLevel, rms(b.pcm))
		return b
	}
	out := s.chain.Process(b.pcm, b.ref)
	raiseLevel(&s.e.selfLevel, rms(out))
	back := int64(s.chain.Delay() + len(out) - len(b.pcm))
	return capBlock{ts: b.ts - back, inMs: b.inMs - float64(back)*1000/audio.SampleRate, pcm: out}
}

// captionInput is what live captions hear of a mic block: the raw block,
// or, with echo cancellation on, the echo canceller's output (before noise
// suppression and gain), which on speakers is the difference between
// captioning you and captioning everyone you can hear. Nothing is copied
// here: either slice is only lent.
func (s *sender) captionInput(raw []float32) []float32 {
	if s.chain != nil {
		if out := s.chain.EchoOut(); out != nil {
			return out
		}
	}
	return raw
}

// tapCaptions hands captions their audio, and the level the ring goes by
// (the mic after all its processing, as the page's ring sees it).
func (s *sender) tapCaptions(raw, processed []float32) {
	if len(processed) > 0 {
		s.capLevel = capLevel(processed)
	}
	s.e.captions.tap(s.captionInput(raw), s.capLevel)
}

func (s *sender) setChain(p *dsp.Settings) {
	if s.chain != nil {
		s.chain.Close()
		s.chain = nil
	}
	s.chainFor = dsp.Settings{}
	if p == nil {
		return
	}
	s.chainFor = *p
	c, err := dsp.NewChain(*p)
	if err != nil {
		log.Printf("processing: %v", err)
		return
	}
	s.chain = c
}

func (s *sender) configure(c proto.LLConfig) {
	if c.Redundancy != s.cfg.Redundancy {
		s.history = s.history[:0]
	}
	s.cfg = c
}

func (s *sender) feedLL(b capBlock, t *targets) {
	active := len(t.ll) > 0 || t.loop != nil
	if !active || (t.muted && t.loop == nil) {
		if s.wasActive {
			// A fresh start next time: no repeats of frames from before.
			s.history = s.history[:0]
			s.fill = 0
		}
		s.wasActive = false
		return
	}
	s.wasActive = true
	if len(s.frame) == 0 {
		s.frame = make([]float32, pcmFrame)
	}
	for i, v := range b.pcm {
		if s.fill == 0 {
			s.frameStart = b.ts + int64(i)
			s.frameInMs = b.inMs + float64(i)*1000/audio.SampleRate
		}
		s.frame[s.fill] = v
		s.fill++
		if s.fill == len(s.frame) {
			s.fill = 0
			s.encodeLL(t)
		}
	}
}

// encodeLL sends a finished frame, unless our silence gate (ll.Gate) holds it back.
func (s *sender) encodeLL(t *targets) {
	if s.cfg.DTX && !s.gate.Pass(s.frameStart, s.frame, s.cfg.DTXThresholdDb, s.cfg.DTXHangoverMs) {
		return
	}
	lead := 0
	if s.cfg.DTX {
		// The first frame after a silence takes the frames just before it along (see gate.go), in place of repeats of frames from before the silence.
		if l := s.gate.Lead(nil); len(l) > 0 {
			s.history, lead = l, len(l)
		}
	}
	s.emit(ll.Frame{TS: uint32(s.frameStart), Data: ll.PCMToBytes(s.frame)}, lead, t)
}

// emit a finished frame: the repeats of the ones before it (at least lead of them), now and then a capture stamp, and off it goes.
func (s *sender) emit(f ll.Frame, lead int, t *targets) {
	red := max(0, min(max(s.cfg.Redundancy, lead), len(s.history)))
	frames := append(append(make([]ll.Frame, 0, red+1), s.history[len(s.history)-red:]...), f)
	s.history = append(s.history, f)
	if len(s.history) > 2 {
		s.history = s.history[1:]
	}
	stamped := s.sent%stampEvery == 0
	s.sent++
	buf := ll.EncodePacket(frames, s.frameInMs, stamped, true)
	if t.loop != nil {
		// The mic test hears exactly what would have gone out, through the same decode and jitter buffer.
		s.e.receiveLL(t.loop, buf)
	}
	if t.muted {
		return
	}
	for _, l := range t.ll {
		l.sendLL(buf)
	}
}
