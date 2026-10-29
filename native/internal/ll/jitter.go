package ll

import (
	"math"
	"sort"
)

/*
JitterBuffer is the low-latency engine's jitter buffer, a port of
src/audio/ll/jitter.ts (see there for the long version). Decoded audio in,
a steady stream of samples out, as little delay as the network's jitter
allows. Everything is in samples:

	base   = the smallest (arrival − ts) over the window: the best this path does
	jitter = a high percentile of how much later than that frames arrive
	target = jitter × multiplier + margin, clamped to [min, max]

and the sample that should be playing at the start of a block is
now − base − target − block. Playback steers toward that by changing speed
by up to ±stretch (only in the quiet between words, or while someone's
talking when it must: see jitter.ts), conceals gaps by fading a repeat of
the last frame, and goes idle after an underrun so the next talkspurt
starts fresh.

Not safe for concurrent use: the audio callback owns it. Frames reach it
through a channel (see engine).
*/

type JitterConfig struct {
	SampleRate float64
	MinMs      float64
	MaxMs      float64
	MarginMs   float64
	Multiplier float64
	// Fraction, e.g. 0.02 for ±2%.
	Stretch   float64
	ConcealMs float64
	// Which percentile of lateness is "the jitter" (100 = the worst in the window).
	Percentile float64
	WindowSec  float64
}

type JitterStats struct {
	TargetMs float64 `json:"targetMs"`
	// How long the samples played since the last read waited after arriving, on average, ms.
	BufferMs     *float64 `json:"bufferMs"`
	JitterMs     float64  `json:"jitterMs"`
	Late         int      `json:"late"`
	ConcealedPct float64  `json:"concealedPct"`
	Underruns    int      `json:"underruns"`
	// The last real sample played: its sender timestamp, and our sample clock when it played.
	PlayTS  *float64 `json:"playTs"`
	AtFrame float64  `json:"atFrame"`
}

type stored struct {
	start   float64
	pcm     []float32
	arrival float64
}

type arrivalRec struct{ at, off float64 }

const idleAfterMs = 80

// QuietRMS: below this (about −50 dBFS) the last block played counts as quiet, where a change of speed can't be heard.
const QuietRMS = 0.003

// The most the playback speed moves in one block: ±2% takes about 50 ms to reach.
const rateGlide = 0.001

type JitterBuffer struct {
	cfg JitterConfig
	// By value, in a slice that's reused: Push and Pull allocate nothing once it's warm.
	frames      []stored
	arrivals    []arrivalRec
	scratch     []float64
	hasBase     bool
	base        float64
	jitter      float64
	estimatedAt float64
	// Sender-clock position being played, or idle.
	playing     bool
	pos         float64
	cursor      stored
	hasCursor   bool
	lastGood    stored
	hasLastGood bool
	lastGoodEnd float64
	emptySince  float64
	empty       bool
	// How loud the last block played was (RMS), and the speed now (1 is normal), gliding to what steering wants.
	lastRMS float64
	rate    float64
	// Counters since the last Stats call.
	late, concealed, played, underruns int
	waitSum                            float64
	waitCount                          int
	hasPlayed                          bool
	playedTS, playedAt                 float64
}

func NewJitterBuffer(cfg JitterConfig) *JitterBuffer {
	return &JitterBuffer{cfg: cfg, estimatedAt: math.Inf(-1), rate: 1}
}

func (j *JitterBuffer) Configure(cfg JitterConfig) { j.cfg = cfg }

func (j *JitterBuffer) ms(n float64) float64       { return n * 1000 / j.cfg.SampleRate }
func (j *JitterBuffer) samples(ms float64) float64 { return ms * j.cfg.SampleRate / 1000 }

// Push takes a decoded frame: ts on the sender's clock, arrival on ours.
func (j *JitterBuffer) Push(ts float64, pcm []float32, arrival float64) {
	off := arrival - ts
	j.arrivals = append(j.arrivals, arrivalRec{arrival, off})
	if !j.hasBase || off < j.base {
		j.base = off
		j.hasBase = true
	}
	if j.playing && ts+float64(len(pcm)) <= j.pos {
		j.late++
		return
	}
	// Keep them sorted by start; nearly always this is an append.
	i := len(j.frames)
	for i > 0 && j.frames[i-1].start > ts {
		i--
	}
	if i > 0 && j.frames[i-1].start == ts {
		return
	}
	j.frames = append(j.frames, stored{})
	copy(j.frames[i+1:], j.frames[i:])
	j.frames[i] = stored{start: ts, pcm: pcm, arrival: arrival}
}

func (j *JitterBuffer) estimate(now float64) {
	if now-j.estimatedAt < j.samples(50) {
		return
	}
	j.estimatedAt = now
	cutoff := now - j.cfg.WindowSec*j.cfg.SampleRate
	drop := 0
	for drop < len(j.arrivals)-1 && j.arrivals[drop].at < cutoff {
		drop++
	}
	if drop > 0 {
		j.arrivals = append(j.arrivals[:0], j.arrivals[drop:]...)
	}
	if len(j.arrivals) == 0 {
		return
	}
	base := math.Inf(1)
	for _, a := range j.arrivals {
		base = math.Min(base, a.off)
	}
	j.scratch = j.scratch[:0]
	for _, a := range j.arrivals {
		j.scratch = append(j.scratch, a.off-base)
	}
	sort.Float64s(j.scratch)
	j.base = base
	k := int(math.Floor(float64(len(j.scratch)) * j.cfg.Percentile / 100))
	j.jitter = j.scratch[min(len(j.scratch)-1, k)]
}

func (j *JitterBuffer) TargetSamples() float64 {
	c := j.cfg
	ms := math.Min(c.MaxMs, math.Max(c.MinMs, j.ms(j.jitter)*c.Multiplier+c.MarginMs))
	return j.samples(ms)
}

// Pull fills out with the block starting at our sample now.
func (j *JitterBuffer) Pull(out []float32, now float64) {
	j.estimate(now)
	n := float64(len(out))
	if !j.hasBase {
		clear(out)
		j.lastRMS = 0
		return
	}
	desired := now - j.base - j.TargetSamples() - n

	if !j.playing {
		// Idle: start when the earliest frame is due.
		j.dropOlderThan(desired - j.samples(j.cfg.MaxMs))
		if len(j.frames) == 0 || j.frames[0].start > desired {
			clear(out)
			j.lastRMS = 0
			return
		}
		first, last := j.frames[0], j.frames[len(j.frames)-1]
		j.pos = math.Min(math.Max(first.start, desired), last.start)
		j.rate = 1
		j.playing = true
		j.hasCursor = false
		j.empty = false
	}

	err := j.pos - desired
	if err < -j.samples(j.cfg.MaxMs) {
		// Far too deep (a stall let a backlog build): jump.
		j.pos = desired
		err = 0
	}
	k := j.samples(20)
	stretch := j.cfg.Stretch
	if j.lastRMS >= QuietRMS {
		// Talking: too little buffered (a gap's coming) steers as ever; far too much at a quarter; a little too much waits.
		if err < -k {
			stretch /= 4
		} else if err <= j.samples(1) {
			stretch = 0
		}
	}
	want := 1 - math.Max(-1, math.Min(1, err/k))*stretch
	j.rate += math.Max(-rateGlide, math.Min(rateGlide, want-j.rate))
	rate := j.rate

	for i := range out {
		if !j.playing {
			out[i] = 0
			continue
		}
		p := j.pos
		ip := math.Floor(p)
		frac := p - ip
		at := now + float64(i)
		a := j.sample(ip, at)
		b := a
		if frac > 0 {
			b = j.sample(ip+1, at)
		}
		out[i] = a + (b-a)*float32(frac)
		if j.playing {
			j.pos += rate
		}
	}
	var sum float64
	for _, v := range out {
		sum += float64(v) * float64(v)
	}
	j.lastRMS = math.Sqrt(sum / n)
	if j.playing {
		j.dropOlderThan(j.pos - j.samples(5))
	}
}

func (j *JitterBuffer) find(ip float64) (stored, bool) {
	if c := j.cursor; j.hasCursor && ip >= c.start && ip < c.start+float64(len(c.pcm)) {
		return c, true
	}
	// Usually the very next frame.
	for _, f := range j.frames {
		if ip >= f.start && ip < f.start+float64(len(f.pcm)) {
			return f, true
		}
		if f.start > ip {
			break
		}
	}
	return stored{}, false
}

func (j *JitterBuffer) sample(ip, now float64) float32 {
	if f, ok := j.find(ip); ok {
		// Frames are told apart by where they start (Push keeps one per start).
		if !j.hasCursor || f.start != j.cursor.start {
			j.cursor, j.hasCursor = f, true
			j.waitSum += now - f.arrival
			j.waitCount++
		}
		j.lastGood, j.hasLastGood = f, true
		j.lastGoodEnd = f.start + float64(len(f.pcm))
		j.empty = false
		j.played++
		j.hasPlayed = true
		j.playedTS, j.playedAt = ip, now
		return f.pcm[int(ip-f.start)]
	}
	// Nothing here: conceal by fading out a repeat of the last good frame.
	since := ip - j.lastGoodEnd
	conceal := j.samples(j.cfg.ConcealMs)
	var v float32
	ahead := len(j.frames) > 0 && j.frames[len(j.frames)-1].start > ip
	if g := j.lastGood; j.hasLastGood && since >= 0 && since < conceal {
		n := len(g.pcm)
		idx := ((int(ip-g.start) % n) + n) % n
		v = g.pcm[idx] * float32(1-since/conceal)
		// Only a hole with audio after it is a loss; running out is just the end of a sentence.
		if ahead {
			j.concealed++
		}
	}
	if !ahead {
		// Underrun. Go idle if it lasts, so the next talkspurt starts fresh.
		if !j.empty {
			j.empty = true
			j.emptySince = now
			j.underruns++
		} else if now-j.emptySince > j.samples(idleAfterMs) {
			j.playing = false
			j.hasCursor = false
		}
	}
	return v
}

func (j *JitterBuffer) dropOlderThan(t float64) {
	i := 0
	for i < len(j.frames) && j.frames[i].start+float64(len(j.frames[i].pcm)) < t {
		i++
	}
	if i > 0 {
		n := copy(j.frames, j.frames[i:])
		clear(j.frames[n:])
		j.frames = j.frames[:n]
	}
}

// Stats returns the numbers since the last call and resets the counters.
func (j *JitterBuffer) Stats() JitterStats {
	total := j.played + j.concealed
	s := JitterStats{
		TargetMs:  j.ms(j.TargetSamples()),
		JitterMs:  j.ms(j.jitter),
		Late:      j.late,
		Underruns: j.underruns,
	}
	if j.waitCount > 0 {
		b := j.ms(j.waitSum / float64(j.waitCount))
		s.BufferMs = &b
	}
	if total > 0 {
		s.ConcealedPct = float64(j.concealed) / float64(total) * 100
	}
	if j.hasPlayed {
		ts := j.playedTS
		s.PlayTS = &ts
		s.AtFrame = j.playedAt
	}
	j.late, j.concealed, j.played, j.underruns, j.waitCount = 0, 0, 0, 0, 0
	j.waitSum = 0
	return s
}
