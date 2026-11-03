// Package captions is what the app does with your mic for live captions
// before any recogniser sees it: when to listen (the gate) and at what
// rate (the decimator), the same rules as the website's (src/captions/
// gate.ts, decimate.ts), held to the same test cases. The recognisers
// themselves are in internal/asr.
package captions

// The ring's rule (src/audio/activity.ts): louder than this RMS is talking,
// and the ring stays lit this long after the last loud block.
const (
	SpeakingRMS   = 0.01
	SpeakingHoldS = 0.3
)

// Sink takes what the gate lets through. Audio is lent: copy what you keep.
type Sink interface {
	Start()
	Audio(pcm []float32)
	End()
}

// Gate lets the recogniser hear you while your ring is lit, and a little
// either side: the last PreMs of raw audio is kept all the time and goes
// first when the ring lights, and it keeps listening PostMs after the ring
// goes out, then ends the segment. A ring that lights again in the post-roll
// carries on the same segment; after an end the kept audio starts from
// nothing, so no sample goes twice. It allocates nothing once made.
type Gate struct {
	rate      int
	threshold float32
	hold      int64
	pre, post int64

	buf     []float32
	written int64
	now     int64
	loudAt  int64
	open    bool
	tail    int64
}

// NewGate makes a gate for this sample rate, with room for up to maxPreMs of pre-roll.
func NewGate(rate int, preMs, postMs, maxPreMs float64) *Gate {
	g := &Gate{rate: rate, threshold: SpeakingRMS, hold: int64(SpeakingHoldS*float64(rate) + 0.5), loudAt: -1 << 62}
	g.buf = make([]float32, max(1, int(maxPreMs*float64(rate)/1000+0.999)))
	g.Configure(preMs, postMs)
	return g
}

func (g *Gate) samples(ms float64) int64 { return int64(ms*float64(g.rate)/1000 + 0.5) }

// Configure changes the pre-roll and post-roll (live).
func (g *Gate) Configure(preMs, postMs float64) {
	g.pre, g.post = g.samples(preMs), g.samples(postMs)
}

// Open says whether a segment is open.
func (g *Gate) Open() bool { return g.open }

// Push one block of raw audio, with the level (RMS) that decides the ring for it.
func (g *Gate) Push(raw []float32, level float32, sink Sink) {
	n := int64(len(raw))
	end := g.now + n
	loud := level > g.threshold
	if loud {
		g.loudAt = end
	}
	lit := loud || end-g.loudAt < g.hold
	if !g.open {
		if lit {
			g.open = true
			g.tail = g.post
			sink.Start()
			g.flushPre(sink)
			sink.Audio(raw)
		} else {
			g.keep(raw)
		}
	} else {
		sink.Audio(raw)
		if lit {
			g.tail = g.post
		} else {
			g.tail -= n
			if g.tail <= 0 {
				g.open = false
				g.written = 0
				sink.End()
			}
		}
	}
	g.now = end
}

// Reset stops listening: ends an open segment (if sink isn't nil) and forgets the pre-roll.
func (g *Gate) Reset(sink Sink) {
	if g.open && sink != nil {
		sink.End()
	}
	g.open = false
	g.written = 0
	g.loudAt = -1 << 62
}

func (g *Gate) keep(raw []float32) {
	l := int64(len(g.buf))
	w := g.written % l
	for _, v := range raw {
		g.buf[w] = v
		if w++; w == l {
			w = 0
		}
	}
	g.written += int64(len(raw))
}

func (g *Gate) flushPre(sink Sink) {
	l := int64(len(g.buf))
	n := min(g.written, l, g.pre)
	if n <= 0 {
		return
	}
	endAt := g.written % l
	start := (endAt - n + l) % l
	if start < endAt {
		sink.Audio(g.buf[start:endAt])
		return
	}
	sink.Audio(g.buf[start:])
	if endAt > 0 {
		sink.Audio(g.buf[:endAt])
	}
}
