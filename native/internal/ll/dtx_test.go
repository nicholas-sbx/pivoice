package ll

import (
	"math"
	"testing"
)

// Silence suppression end to end, as in tests/dtx.test.ts: a voice that
// keeps stopping and starting, through the gate, packets, a network, the
// receiver's checks (link.go) and the jitter buffer, against the same voice
// with the gate off. A click shows as a large second difference around an
// onset (a 120–250 Hz voice has small ones); latency as when each onset
// first gets loud at the far end, and how far behind playback runs 150 ms in.

const dtxSR = 48000

func dtxMs(m float64) int { return int(math.Round(m * dtxSR / 1000)) }

type onset struct{ at, end int }

func dtxVoice(attackMs float64) ([]float32, []onset) {
	seed := int64(7)
	rand := func() float64 {
		seed = seed * 16807 % 2147483647
		return float64(seed) / 2147483647
	}
	gaps := []float64{600, 4000, 1200, 6000, 900, 2500}
	talks := []float64{500, 300, 800}
	const spurts = 12
	n := dtxSR
	for i := 0; i < spurts; i++ {
		n += dtxMs(gaps[i%6]+talks[i%3]) + 128
	}
	x := make([]float32, n)
	sigma := math.Pow(10, -85.0/20) * math.Sqrt(3)
	for i := range x {
		x[i] = float32(sigma * (2*rand() - 1))
	}
	var ons []onset
	t := 0
	for s := 0; s < spurts; s++ {
		t += dtxMs(gaps[s%6]) + int(rand()*128)
		d := dtxMs(talks[s%3])
		a := max(1, dtxMs(attackMs))
		r := dtxMs(30)
		f0 := float64(120 + (s*37)%130)
		var ph [12]float64
		for h := range ph {
			ph[h] = rand() * 2 * math.Pi
		}
		for i := 0; i < d; i++ {
			env := 1.0
			if i < a {
				env = 0.5 - 0.5*math.Cos(math.Pi*float64(i)/float64(a))
			} else if i > d-r {
				env = 0.5 + 0.5*math.Cos(math.Pi*float64(i-(d-r))/float64(r))
			}
			v := 0.0
			for h := 1; h <= 12; h++ {
				v += math.Sin(2*math.Pi*float64(h)*f0*float64(i)/dtxSR+ph[h-1]) / float64(h)
			}
			x[t+i] += float32(0.06 * env * v)
		}
		ons = append(ons, onset{t, t + d})
		t += d
	}
	return x, ons
}

type dtxRun struct {
	y       []float32
	delay   []float64
	packets int
}

// send.go's sending side (gate, look-back, PCM, no redundancy), a path of
// 2 ms plus up to jitterMs that keeps packets in order, receiveLL's checks,
// and the jitter buffer at DefaultLL, pulling 128-sample blocks.
func runDTX(x []float32, dtx bool, jitterMs float64, lookBack bool) dtxRun {
	var g Gate
	seed := int64(3)
	rand := func() float64 {
		seed = seed * 16807 % 2147483647
		return float64(seed) / 2147483647
	}
	const skew = 1_000_037
	type pkt struct {
		arrival float64
		buf     []byte
	}
	var sent []pkt
	var history []Frame
	arrival := 0.0
	for ts := 0; ts+128 <= len(x); ts += 128 {
		pcm := x[ts : ts+128]
		if dtx && !g.Pass(int64(ts), pcm, -70, 400) {
			continue
		}
		lead := 0
		if dtx {
			if l := g.Lead(nil); len(l) > 0 && lookBack {
				history, lead = l, len(l)
			}
		}
		f := Frame{TS: uint32(ts), Data: PCMToBytes(pcm)}
		frames := append(append([]Frame{}, history[len(history)-min(lead, len(history)):]...), f)
		history = append(history, f)
		if len(history) > 2 {
			history = history[1:]
		}
		arrival = math.Max(arrival, skew+float64(ts)+128+96+math.Floor(rand()*jitterMs*48))
		sent = append(sent, pkt{arrival, EncodePacket(frames, 0, false, true)})
	}
	jb := NewJitterBuffer(JitterConfig{SampleRate: dtxSR, MinMs: 0, MaxMs: 80, MarginMs: 3, Multiplier: 1, Stretch: 0.02, ConcealMs: 12, Percentile: 99, WindowSec: 3})
	r := dtxRun{y: make([]float32, len(x)), delay: make([]float64, len(x)/128), packets: len(sent)}
	out := make([]float32, 128)
	next := math.Inf(-1)
	p := 0
	for k := 0; (k+1)*128 <= len(x); k++ {
		now := float64(skew + k*128)
		for ; p < len(sent) && sent[p].arrival <= now; p++ {
			pk, _ := DecodePacket(sent[p].buf)
			for _, f := range pk.Frames {
				if float64(f.TS) < next {
					continue
				}
				pcm := BytesToPCM(f.Data)
				next = float64(f.TS) + float64(len(pcm))
				jb.Push(float64(f.TS), pcm, now)
			}
		}
		jb.Pull(out, now)
		copy(r.y[k*128:], out)
		st := jb.Stats()
		r.delay[k] = math.NaN()
		if st.PlayTS != nil {
			r.delay[k] = (st.AtFrame - skew - *st.PlayTS) / 48
		}
	}
	return r
}

func d2max(v []float32, a, b int) float64 {
	m := 0.0
	for i := max(2, a); i < min(len(v), b); i++ {
		m = math.Max(m, math.Abs(float64(v[i]-2*v[i-1]+v[i-2])))
	}
	return m
}

func firstLoud(v []float32, from, to int) float64 {
	for i := from; i < min(to, len(v)); i++ {
		if math.Abs(float64(v[i])) > 0.01 {
			return float64(i)
		}
	}
	return math.NaN()
}

type dtxMeasured struct {
	step          float64
	clicks        int
	onset, steady []float64
	packets       int
}

func measureDTX(attackMs float64, dtx bool, jitterMs float64, lookBack bool) dtxMeasured {
	x, ons := dtxVoice(attackMs)
	r := runDTX(x, dtx, jitterMs, lookBack)
	m := dtxMeasured{packets: r.packets}
	for i, o := range ons {
		own := d2max(x, o.at, o.end)
		m.step = math.Max(m.step, d2max(r.y, o.at-dtxMs(20), o.at+dtxMs(40))/own)
		for k := o.at; k < o.end+dtxMs(400); k++ {
			if math.Abs(float64(r.y[k]-2*r.y[k-1]+r.y[k-2])) > 2*own {
				m.clicks++
			}
		}
		if i == 0 {
			continue
		}
		s0 := firstLoud(x, o.at, o.end)
		m.onset = append(m.onset, (firstLoud(r.y, int(s0), int(s0)+dtxMs(200))-s0)/48)
		m.steady = append(m.steady, r.delay[(o.at+dtxMs(150))/128])
	}
	return m
}

func mostLater(on, off []float64) float64 {
	worst := math.Inf(-1)
	for i := range on {
		worst = math.Max(worst, on[i]-off[i])
	}
	return worst
}

func TestDTXOnsets(t *testing.T) {
	// Desktop on a wired LAN or Wi-Fi that behaves; fast attacks (a plosive) and a slow one.
	for _, c := range []struct{ attackMs, jitterMs float64 }{{0.3, 0}, {3, 0}, {15, 0}, {3, 3}} {
		off := measureDTX(c.attackMs, false, c.jitterMs, true)
		on := measureDTX(c.attackMs, true, c.jitterMs, true)
		// Before the look-back the worst onset was 2× (slow attack) to 30–37× (fast) the voice's own.
		if off.step >= 1.2 || on.step >= 1.2 || on.clicks != 0 {
			t.Errorf("%+v: step %.2f (off %.2f), %d click samples", c, on.step, off.step, on.clicks)
		}
		if l := mostLater(on.onset, off.onset); l >= 0.1 {
			t.Errorf("%+v: an onset %.2f ms later than with it off", c, l)
		}
		if l := mostLater(on.steady, off.steady); l >= 0.1 {
			t.Errorf("%+v: playback %.2f ms further behind than with it off", c, l)
		}
		if float64(on.packets) >= 0.4*float64(off.packets) {
			t.Errorf("%+v: sent %d packets of %d", c, on.packets, off.packets)
		}
	}
}

// Every sentence after a pause longer than the jitter window used to start on the margin alone, and crackle on a jittery path.
func TestDTXKeepsTheJitterThroughAPause(t *testing.T) {
	off := measureDTX(3, false, 10, true)
	on := measureDTX(3, true, 10, true)
	avg := func(a []float64) float64 {
		s := 0.0
		for _, v := range a {
			s += v
		}
		return s / float64(len(a))
	}
	if on.clicks > off.clicks || avg(on.steady) >= avg(off.steady)+0.5 {
		t.Fatalf("%d click samples (off %d), delay %.2f ms (off %.2f)", on.clicks, off.clicks, avg(on.steady), avg(off.steady))
	}
}

// An older sender (no look-back): the fade-in turns the step into a 1 ms ramp.
func TestDTXFadesInWithoutTheLookBack(t *testing.T) {
	if on := measureDTX(0.3, true, 0, false); on.step >= 2.5 {
		t.Fatalf("step %.2f", on.step)
	}
}

func TestGateLookBack(t *testing.T) {
	var g Gate
	loud := make([]float32, 128)
	quiet := make([]float32, 128)
	for i := range loud {
		loud[i] = 0.1
	}
	ts := int64(0)
	feed := func(pcm []float32) bool { ok := g.Pass(ts, pcm, -70, 50); ts += 128; return ok }
	feed(loud)
	g.Lead(nil)
	for i := 0; i < 30; i++ {
		feed(quiet)
	}
	quiet[0] = 0.0001 // marks the last frame held back
	feed(quiet)
	if !feed(loud) {
		t.Fatal("held back a loud frame")
	}
	l := g.Lead(nil)
	if len(l) != Preroll || int64(l[0].TS) != ts-3*128 || int64(l[1].TS) != ts-2*128 || BytesToPCM(l[1].Data)[0] == 0 {
		t.Fatalf("lead %+v", l)
	}
	if len(g.Lead(nil)) != 0 {
		t.Fatal("lead twice")
	}
	// Frames from before a gap (a mute) don't go out with the next one.
	for i := 0; i < 30; i++ {
		feed(make([]float32, 128))
	}
	ts += 128 * 50
	feed(loud)
	if l := g.Lead(nil); len(l) != 0 {
		t.Fatalf("lead across a gap: %+v", l)
	}
}
