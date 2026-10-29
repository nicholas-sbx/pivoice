package dsp

import "math"

// AGC is automatic gain: it brings your voice to a steady level by
// changing its own gain (never the system's mic volume), with no
// lookahead, so it adds no delay. Each block it:
//
//   - tracks the noise floor (falls at once, rises slowly) and, while
//     you're talking, your speech level (a third of a second's memory);
//   - aims the gain at the target over that level, from −6 dB up to the
//     most it may boost, cutting quickly when you get loud (50 ms) and
//     lifting within a second, and only changing it while you talk, so
//     silence isn't pumped up;
//   - soft-limits the result, so a sudden shout is rounded off rather
//     than clipped.
//
// The target and the most it may boost are yours to set (Retune, live).
type AGC struct {
	noise  float64
	speech float64
	gain   float64
	target float64
	most   float64
}

const (
	// Defaults: −16 dBFS RMS, about as loud as browsers' own gain control
	// leaves people, and up to +30 dB for a quiet mic.
	AGCTargetDb  = -16
	AGCMaxGainDb = 30
	agcMinGain   = 0.5 // −6 dB
	agcSpeech    = 0.3 // s, speech level memory
	agcCut       = 0.05
	agcLift      = 0.8
	agcLimit     = 0.9
	// Without a voice detector, a block is speech when it's this far over the noise floor (10 dB)…
	agcOverNoise = 3.16
	// …and above digital near-silence (−66 dBFS), so a quiet mic still counts.
	agcFloor = 0.0005
)

func dbToGain(db float64) float64 { return math.Pow(10, db/20) }

// NewAGC aims at targetDb (dBFS RMS), boosting by up to maxDb.
func NewAGC(targetDb, maxDb float64) *AGC {
	a := &AGC{noise: 1e-4, gain: 1}
	a.Retune(targetDb, maxDb)
	a.speech = a.target
	return a
}

// Retune the target and the most it may boost, keeping where it's got to.
func (a *AGC) Retune(targetDb, maxDb float64) {
	a.target = dbToGain(max(-30, min(-6, targetDb)))
	a.most = dbToGain(max(0, min(40, maxDb)))
}

func tc(n int, seconds float64) float64 { return 1 - math.Exp(-float64(n)/(seconds*SampleRate)) }

// Process a block in place. voice: someone's talking, if the caller knows
// (RNNoise's detector); otherwise the level against the noise floor decides.
func (a *AGC) Process(x []float32, voice bool, know bool) {
	n := len(x)
	if n == 0 {
		return
	}
	var sum float64
	for _, v := range x {
		sum += float64(v) * float64(v)
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
	from := a.gain
	if talking {
		a.speech += (r - a.speech) * tc(n, agcSpeech)
		want := min(a.most, max(agcMinGain, a.target/max(a.speech, 1e-6)))
		if want < a.gain {
			a.gain += (want - a.gain) * tc(n, agcCut)
		} else {
			a.gain += (want - a.gain) * tc(n, agcLift)
		}
	}
	// Glide across the block, then round off anything that would clip.
	step := (a.gain - from) / float64(n)
	g := from
	for i, v := range x {
		g += step
		y := float64(v) * g
		if ay := math.Abs(y); ay > agcLimit {
			y = math.Copysign(agcLimit+(1-agcLimit)*math.Tanh((ay-agcLimit)/(1-agcLimit)), y)
		}
		x[i] = float32(y)
	}
}

// Gain is where it's at now, as a factor.
func (a *AGC) Gain() float64 { return a.gain }
