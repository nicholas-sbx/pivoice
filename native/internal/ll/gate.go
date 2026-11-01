package ll

import "math"

/*
Gate is our silence gate (DTX), the browser's SilenceGate in
src/audio/ll/gate.ts (see there for the long version): it skips a frame
once you've been below the threshold for the hangover, each frame
deciding from its own level, so the first frame with sound in it goes out.

It keeps the last Preroll frames it held back, and the first frame it lets
through after a silence goes out with them (Lead), so the far end's jitter
buffer, which starts a talkspurt partway into its first frame, starts on
the quiet just before the sound instead of in the middle of the attack:
that jump was the click at the start of every sentence. They were captured
already, so nothing waits for them.

Not safe for concurrent use: the sender owns it.
*/
type Gate struct {
	quietFor float64
	held     [Preroll]heldFrame
	n        int
}

// Preroll is how many frames the gate holds back for the look-back: two
// 128-sample frames (5.3 ms), and with the new one a full packet (maxPacketFrames in engine).
const Preroll = 2

type heldFrame struct {
	ts  int64
	pcm []float32
}

// Pass says whether this frame goes out. If it's the first after a silence, Lead then has the frames just before it.
func (g *Gate) Pass(ts int64, pcm []float32, thresholdDb, hangoverMs float64) bool {
	var sum float64
	for _, v := range pcm {
		sum += float64(v * v)
	}
	if db := 10 * math.Log10(sum/float64(len(pcm))+1e-12); db >= thresholdDb {
		g.quietFor = 0
	} else {
		g.quietFor += float64(len(pcm))
	}
	// Only frames that run straight up to this one (none from before a mute, say).
	if g.n > 0 && g.held[g.n-1].ts+int64(len(g.held[g.n-1].pcm)) != ts {
		g.n = 0
	}
	if g.quietFor <= hangoverMs*48 {
		return true
	}
	if g.n == Preroll {
		// The oldest goes, and its buffer takes this one.
		oldest := g.held[0]
		copy(g.held[:], g.held[1:])
		g.held[Preroll-1] = oldest
		g.n--
	}
	h := &g.held[g.n]
	h.ts = ts
	h.pcm = append(h.pcm[:0], pcm...)
	g.n++
	return false
}

// Lead appends the frames held back just before the one Pass let through, oldest first, as PCM; then forgets them.
func (g *Gate) Lead(dst []Frame) []Frame {
	for _, h := range g.held[:g.n] {
		dst = append(dst, Frame{TS: uint32(h.ts), Data: PCMToBytes(h.pcm)})
	}
	g.n = 0
	return dst
}
