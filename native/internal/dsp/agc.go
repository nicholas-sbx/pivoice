package dsp

import "math"

// AGC is automatic gain: it brings your voice to a steady level by
// changing its own gain (never the system's mic volume), with no
// lookahead, so it adds no delay. Each block it:
//
//   - tracks the noise floor (falls at once, rises slowly) and, while
//     you're talking, your speech level (about half a second's memory);
//   - aims the gain at the target over that level, between −6 and +24 dB,
//     cutting quickly when you get loud (50 ms) and lifting slowly (2 s),
//     and only changing it while you talk, so silence isn't pumped up;
//   - soft-limits the result, so a sudden shout is rounded off rather
//     than clipped.
type AGC struct {
	noise  float64
	speech float64
	gain   float64
}

const (
	agcTarget  = 0.1   // −20 dBFS RMS: speech that sits well in the mix
	agcMaxGain = 15.85 // +24 dB
	agcMinGain = 0.5   // −6 dB
	agcSpeech  = 0.4   // s, speech level memory
	agcCut     = 0.05  // s
	agcLift    = 2.0   // s
	agcLimit   = 0.9
)

func NewAGC() *AGC { return &AGC{noise: 1e-4, speech: agcTarget, gain: 1} }

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
	talking := r > 0.003 && r > 4*a.noise
	if know {
		talking = voice && r > 0.001
	}
	from := a.gain
	if talking {
		a.speech += (r - a.speech) * tc(n, agcSpeech)
		want := min(agcMaxGain, max(agcMinGain, agcTarget/max(a.speech, 1e-6)))
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
