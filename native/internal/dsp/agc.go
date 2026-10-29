package dsp

import "math"

// AGC is automatic gain: it brings your voice to a steady level by
// changing its own gain (never the system's mic volume), with no
// lookahead, so it adds no delay. Three stages, each block:
//
//   - The level. It tracks the noise floor (falls at once, rises slowly)
//     and, while you're talking, your speech level (a third of a second's
//     memory), and aims the gain at the target over that level: from −6 dB
//     up to the most it may boost, cutting at the fall time when you get
//     loud and lifting at the rise time, and only moving while you talk, so
//     silence isn't pumped up.
//   - The peaks. It also remembers your recent peaks (instantly up,
//     fading over 1.5 s) and never lets the gain lift them past the peak
//     ceiling. This is what keeps a loud target from living in the limiter:
//     the level stage asks for loud, this says how loud the peaks allow.
//   - The limiter, for what neither saw coming (a sudden shout): over
//     limitAt, the gain drops at once to hold it there and comes back over
//     60 ms. It turns the whole sound down for a moment rather than bending
//     each sample, which is what made the old soft clipper sound clipped.
//
// Everything about it is yours to set (Retune, live).
type AGC struct {
	noise  float64
	speech float64
	peak   float64
	gain   float64
	lim    float64
	t      AGCTuning
	// From the tuning.
	target, most, ceiling float64
}

// AGCTuning is the gain control's settings.
type AGCTuning struct {
	// The level it brings speech to, dBFS RMS.
	TargetDb float64
	// The most it may boost a quiet mic, dB.
	MaxBoostDb float64
	// The loudest it lets your recent peaks be, dBFS.
	CeilingDb float64
	// How long it takes to turn up, and to turn down, s.
	Rise, Fall float64
}

// DefaultAGC: −20 dBFS speech (about where speech sits in a mix, with room
// for its peaks), up to +30 dB for a quiet mic, peaks held to −3 dBFS,
// turning up over a second and down in 50 ms.
var DefaultAGC = AGCTuning{TargetDb: -20, MaxBoostDb: 30, CeilingDb: -3, Rise: 1, Fall: 0.05}

const (
	agcMinGain = 0.5 // −6 dB
	agcSpeech  = 0.3 // s, speech level memory
	agcPeaks   = 1.5 // s, peak memory
	// The limiter: −1 dBFS, and how fast it lets go.
	limitAt      = 0.891
	limitRelease = 0.06
	// Without a voice detector, a block is speech when it's this far over the noise floor (10 dB)…
	agcOverNoise = 3.16
	// …and above digital near-silence (−66 dBFS), so a quiet mic still counts.
	agcFloor = 0.0005
)

func dbToGain(db float64) float64 { return math.Pow(10, db/20) }

func NewAGC(t AGCTuning) *AGC {
	a := &AGC{noise: 1e-4, gain: 1, lim: 1}
	a.Retune(t)
	a.speech = a.target
	return a
}

// Retune to new settings, keeping where it's got to.
func (a *AGC) Retune(t AGCTuning) {
	t.TargetDb = max(-30, min(-6, t.TargetDb))
	t.MaxBoostDb = max(0, min(40, t.MaxBoostDb))
	t.CeilingDb = max(-20, min(-1, t.CeilingDb))
	t.Rise = max(0.05, min(10, t.Rise))
	t.Fall = max(0.005, min(2, t.Fall))
	a.t = t
	a.target, a.most, a.ceiling = dbToGain(t.TargetDb), dbToGain(t.MaxBoostDb), dbToGain(t.CeilingDb)
}

func tc(n int, seconds float64) float64 { return 1 - math.Exp(-float64(n)/(seconds*SampleRate)) }

// Process a block in place. voice: someone's talking, if the caller knows
// (RNNoise's detector); otherwise the level against the noise floor decides.
func (a *AGC) Process(x []float32, voice bool, know bool) {
	n := len(x)
	if n == 0 {
		return
	}
	var sum, pk float64
	for _, v := range x {
		f := float64(v)
		sum += f * f
		pk = max(pk, math.Abs(f))
	}
	r := math.Sqrt(sum / float64(n))
	if r < a.noise {
		a.noise = r
	} else {
		a.noise += (r - a.noise) * tc(n, 5)
	}
	talking := r > agcFloor && r > agcOverNoise*a.noise
	if know {
		talking = voice && r > agcFloor
	}
	// Peaks: up at once, fading slowly, and only from speech (a cough's still speech; a door between sentences isn't).
	a.peak *= 1 - tc(n, agcPeaks)
	if talking {
		a.peak = max(a.peak, pk)
	}
	from := a.gain
	want := a.gain
	if talking {
		a.speech += (r - a.speech) * tc(n, agcSpeech)
		want = min(a.most, max(agcMinGain, a.target/max(a.speech, 1e-6)))
	}
	// Whatever the level wants, the peaks have the last word, talking or not.
	if a.peak > 0 {
		want = min(want, max(agcMinGain, a.ceiling/a.peak))
	}
	if want < a.gain {
		a.gain += (want - a.gain) * tc(n, a.t.Fall)
	} else if talking {
		a.gain += (want - a.gain) * tc(n, a.t.Rise)
	}
	// Glide across the block, then the limiter.
	step := (a.gain - from) / float64(n)
	g := from
	release := 1 - math.Exp(-1/(limitRelease*SampleRate))
	for i, v := range x {
		g += step
		y := float64(v) * g
		a.lim += (1 - a.lim) * release
		if ay := math.Abs(y) * a.lim; ay > limitAt {
			a.lim *= limitAt / ay
		}
		y *= a.lim
		x[i] = float32(max(-1, min(1, y)))
	}
}

// Gain is where it's at now, as a factor (the limiter's moment aside).
func (a *AGC) Gain() float64 { return a.gain }
