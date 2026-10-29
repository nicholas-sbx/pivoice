package engine

import (
	"math"
	"sort"
	"sync/atomic"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/nicholas-sbx/pivoice/native/internal/opus"
)

/*
The audio thread: one duplex callback per block, mic in and speakers out.

	mic block ──copy──▶ capture channel ──▶ sender goroutine (send.go)
	  (with what played, for echo cancellation, only when that's on)
	each person: inbox ──▶ jitter buffer ──▶ volume, pan ──▶ speakers

Decoded frames reach each person's jitter buffer through a buffered
channel, drained at the top of every block and stamped with this block's
sample clock as their arrival, the same as the browser's playback
worklet. Nothing here waits: a full channel drops the frame (late audio
is useless anyway), and the list of people is swapped in whole by the
control side (atomic pointer), never edited under the callback.
*/

const (
	inboxFrames = 64
	// Mic blocks on their way to the sender: a pool of buffers that go round.
	capSlots = 64
	// Jitter buffer numbers (and the measured mouth to ear) are published this often.
	statsEvery = audio.SampleRate / 2
)

type frame struct {
	ts  float64
	pcm []float32
}

type stamp struct{ ts, ms float64 }

// source is one incoming stream of someone's voice: over the low-latency
// channel, or over the call's RTP.
type source struct {
	inbox chan frame

	// Audio thread only.
	jb        *ll.JitterBuffer
	cfgVer    uint64
	statsAt   float64
	measured  []float64
	scratch   []float32
	published atomic.Pointer[sourceStats]

	// Network side (one goroutine per source).
	unwrap      ll.Unwrapper
	lastDecoded int64
	dec         *opus.Decoder
	stamp       atomic.Pointer[stamp]
	// Frames thrown away because the audio thread hadn't taken the last 64 yet.
	dropped  atomic.Int64
	pcm      atomic.Bool
	gotCodec atomic.Bool
	bytes    atomic.Int64
}

type sourceStats struct {
	ll.JitterStats
	measuredMs *float64
}

func newSource() *source {
	return &source{inbox: make(chan frame, inboxFrames), lastDecoded: math.MinInt64, scratch: make([]float32, 4096)}
}

// deliver hands a decoded frame to the audio thread, or drops it if it's backed up.
func (s *source) deliver(ts float64, pcm []float32) {
	select {
	case s.inbox <- frame{ts, pcm}:
	default:
		s.dropped.Add(1)
	}
}

// remote is one person: their sources, and how loud and where they are for you.
type remote struct {
	id    string
	ll    atomic.Pointer[source]
	voice atomic.Pointer[source]
	// The mic test's loop: plays past deafen, unpanned.
	test bool
	// float32 bits: volume (0 while silenced), and left/right gains from where they sit.
	gain       atomic.Uint32
	panL, panR atomic.Uint32
	// Binaural (head.go): the interaural delay, samples (> 0 delays the
	// right ear, < 0 the left), and each ear's head-shadow coefficient, all
	// float32 bits. Neutral is 0 and shadowFront: then they cost nothing.
	itd              atomic.Uint32
	shadowL, shadowR atomic.Uint32
	// Audio thread only: the last samples heard, for the far ear's delay;
	// the delay and coefficients it's gliding from; each ear's filter.
	hist       [itdHistory]float32
	histPos    int
	itdNow     float32
	shadowLNow float32
	shadowRNow float32
	earL, earR ear
	// Loudest block (RMS) since the levels were last read, float32 bits.
	level atomic.Uint32
}

func newRemote(id string) *remote {
	r := &remote{id: id}
	storeF(&r.gain, 1)
	storeF(&r.panL, 1)
	storeF(&r.panR, 1)
	storeF(&r.shadowL, shadowFront)
	storeF(&r.shadowR, shadowFront)
	r.shadowLNow, r.shadowRNow = shadowFront, shadowFront
	return r
}

func storeF(a *atomic.Uint32, v float32) { a.Store(math.Float32bits(v)) }
func loadF(a *atomic.Uint32) float32     { return math.Float32frombits(a.Load()) }

// raiseLevel keeps the loudest value since the last read.
func raiseLevel(a *atomic.Uint32, v float32) {
	for {
		old := a.Load()
		if math.Float32frombits(old) >= v || a.CompareAndSwap(old, math.Float32bits(v)) {
			return
		}
	}
}

// Room for the longest interaural delay (32 samples) and then some.
const itdHistory = 64

// headActive: whether this person needs the head model this block (it's
// set, or still gliding back to neutral).
func (r *remote) headActive(itd, sl, sr float32) bool {
	return itd != 0 || r.itdNow != 0 || sl != shadowFront || sr != shadowFront ||
		r.shadowLNow != shadowFront || r.shadowRNow != shadowFront
}

// mixHead mixes one person in through the spherical head (head.go): the
// far ear delayed (a fractional delay read from a short history of what
// they just said) and each ear through its head-shadow filter. The delay
// and both filters glide to their new settings across the block when a
// seat moves, so it never clicks.
func (r *remote) mixHead(mix, out []float32, l, rr, itd, sl, sr float32) {
	fromD, fromL, fromR := r.itdNow, r.shadowLNow, r.shadowRNow
	n := float32(len(mix))
	for i, v := range mix {
		r.hist[r.histPos] = v
		f := float32(i+1) / n
		d := fromD + (itd-fromD)*f
		late := r.delayed(d)
		left, right := late, v
		if d > 0 {
			left, right = v, late
		}
		out[2*i] += l * r.earL.step(left, fromL+(sl-fromL)*f)
		out[2*i+1] += rr * r.earR.step(right, fromR+(sr-fromR)*f)
		r.histPos = (r.histPos + 1) % itdHistory
	}
	r.itdNow, r.shadowLNow, r.shadowRNow = itd, sl, sr
}

// delayed is the sample d (fractional, either sign) before the newest one in the history.
func (r *remote) delayed(d float32) float32 {
	if d < 0 {
		d = -d
	}
	d = min(d, itdHistory-2)
	k := int(d)
	frac := d - float32(k)
	a := r.hist[(r.histPos-k+itdHistory)%itdHistory]
	b := r.hist[(r.histPos-k-1+itdHistory)%itdHistory]
	return a + (b-a)*frac
}

type capBlock struct {
	ts   int64
	inMs float64
	pcm  []float32
	// What played over the same block, mono (only for echo cancellation).
	ref []float32
}

type jitterCfg struct {
	ver uint64
	cfg ll.JitterConfig
}

// mixer is the state the callback owns.
type mixer struct {
	e        *Engine
	clock    int64
	mix      []float32
	selfPeak float32
}

func rms(x []float32) float32 {
	if len(x) == 0 {
		return 0
	}
	var sum float32
	for _, v := range x {
		sum += v * v
	}
	return float32(math.Sqrt(float64(sum / float32(len(x)))))
}

func (m *mixer) process(in, out []float32, t audio.Times) {
	e := m.e
	n := len(in)
	clock := float64(m.clock)

	// The mic: its level (the meter, the gate's threshold; the sender
	// measures it after processing instead, when there is any), and the
	// samples to the sender when it wants them: straight away, unless echo
	// cancellation wants what this block plays alongside.
	if e.processing.Load() == nil {
		raiseLevel(&e.selfLevel, rms(in))
	}
	echoRef := e.echoRef.Load()
	capturing := e.capturing.Load()
	if capturing && !echoRef {
		m.handoff(in, nil, t)
	}

	clear(out)
	if cap(m.mix) < n {
		m.mix = make([]float32, n)
	}
	mix := m.mix[:n]
	deafened := e.deafened.Load()
	jc := e.jitter.Load()
	for _, r := range *e.remotes.Load() {
		clear(mix)
		heard := false
		for _, s := range [2]*source{r.ll.Load(), r.voice.Load()} {
			if s == nil {
				continue
			}
			m.pull(s, mix, clock, jc, t)
			heard = true
		}
		if !heard {
			continue
		}
		raiseLevel(&r.level, rms(mix))
		if deafened && !r.test {
			continue
		}
		g := loadF(&r.gain)
		l, rr := g*loadF(&r.panL), g*loadF(&r.panR)
		if g == 0 {
			continue
		}
		if itd, sl, sr := loadF(&r.itd), loadF(&r.shadowL), loadF(&r.shadowR); r.headActive(itd, sl, sr) {
			r.mixHead(mix, out, l, rr, itd, sl, sr)
			continue
		}
		for i, v := range mix {
			out[2*i] += v * l
			out[2*i+1] += v * rr
		}
	}
	if capturing && echoRef {
		m.handoff(in, out, t)
	}
	if e.rawLoop.Load() {
		for i, v := range in {
			out[2*i] += v
			out[2*i+1] += v
		}
	}
	m.clock += int64(n)
}

// handoff a mic block to the sender in a buffer it handed back (and with
// it, mixed to mono, what's playing: out, if it's wanted), or count it lost
// if the sender's that far behind.
func (m *mixer) handoff(in, out []float32, t audio.Times) {
	n := len(in)
	select {
	case buf := <-m.e.capFree:
		need := n
		if out != nil {
			need = 2 * n
		}
		if cap(buf) < need {
			buf = make([]float32, need)
		}
		b := capBlock{ts: m.clock, inMs: t.InputMs, pcm: buf[:n]}
		copy(b.pcm, in)
		if out != nil {
			b.ref = buf[n:need]
			for i := range b.ref {
				b.ref[i] = 0.5 * (out[2*i] + out[2*i+1])
			}
		}
		m.e.capture <- b
	default:
		m.e.capDropped.Add(1)
	}
}

// pull one block of this source into mix (added).
func (m *mixer) pull(s *source, mix []float32, clock float64, jc *jitterCfg, t audio.Times) {
	if s.jb == nil {
		s.jb = ll.NewJitterBuffer(jc.cfg)
		s.cfgVer = jc.ver
		s.statsAt = clock
	} else if s.cfgVer != jc.ver {
		s.jb.Configure(jc.cfg)
		s.cfgVer = jc.ver
	}
	// Whatever the network side has decoded since the last block is here now.
drain:
	for {
		select {
		case f := <-s.inbox:
			s.jb.Push(f.ts, f.pcm, clock)
		default:
			break drain
		}
	}
	buf := s.scratch[:len(mix)]
	s.jb.Pull(buf, clock)
	for i, v := range buf {
		mix[i] += v
	}
	if clock-s.statsAt >= statsEvery {
		s.statsAt = clock
		m.publish(s, clock, t)
	}
}

// publish the jitter buffer's numbers, and measure mouth to ear: when the
// last sample played was captured at their end (their capture stamp,
// carried forward on their sample clock), against when it reaches our
// speakers (this block's output time, carried forward on ours).
func (m *mixer) publish(s *source, clock float64, t audio.Times) {
	st := sourceStats{JitterStats: s.jb.Stats()}
	if sp := s.stamp.Load(); sp != nil && st.PlayTS != nil {
		captured := sp.ms + (*st.PlayTS-sp.ts)*1000/audio.SampleRate
		heard := t.OutputMs + (st.AtFrame-clock)*1000/audio.SampleRate
		if d := heard - captured; d > -1000 && d < 5000 {
			s.measured = append(s.measured, d)
			if len(s.measured) > 5 {
				s.measured = s.measured[1:]
			}
		}
	}
	if len(s.measured) > 0 {
		sorted := append([]float64(nil), s.measured...)
		sort.Float64s(sorted)
		med := sorted[len(sorted)/2]
		st.measuredMs = &med
	}
	s.published.Store(&st)
}
