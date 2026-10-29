package engine

import (
	"math"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
)

/*
Binaural, the app's spatial mode "hrtf": Brown and Duda's spherical head
model ("A structural model for binaural sound synthesis", 1998), without
its pinna and shoulder echoes (those place sounds up and down, and
everyone at the table is at ear height, in front of you).

A head is a sphere of radius a with an ear at each end of a diameter. For
each ear, sound arriving at angle θ from that ear's axis (0: straight at
it, π: from the far side) is shaped by a head-shadow filter,

	H(ω, θ) = (1 + jα(θ)ω/2ω₀) / (1 + jω/2ω₀),   ω₀ = c/a,
	α(θ) = (1 + α_min/2) + (1 − α_min/2)·cos(θ/θ_min · π),

which leaves low frequencies alone (they bend round a head) and tilts the
treble: up to +6 dB facing the sound, down to −20 dB in the shadow at
θ_min = 150°, and back up a little behind (the "bright spot"). And the far
ear hears it later, by Woodworth's interaural time difference, which is
the model's delay for each ear taken as a difference (woodworth, engine.go).

Two departures, both so the person straight across sounds just as with
spatial audio off:
  - Only the far ear is delayed: the near ear's own (negative) delay in
    the model would mean hearing them early, which no real-time system can.
  - Both ears are equalised to straight ahead: divided by H(ω, 90°), which
    is the same for every source and so moves no one. Straight ahead is
    then exactly flat, and everyone else is shaped relative to that.

The equalised filter is first order, (1 + jαω/2ω₀) / (1 + jα₉₀ω/2ω₀), whose
pole doesn't depend on the angle: only the zero moves. So its
coefficients can glide sample by sample when a seat moves without ever
going unstable, and the mixer glides them across each block.
*/

const (
	// α_min and θ_min, Brown and Duda's values.
	shadowAlphaMin = 0.1
	shadowThetaMin = 150 * math.Pi / 180
	// The bilinear transform's 2·fs over the model's 2ω₀: α times this is the zero's coefficient.
	shadowK = 2 * audio.SampleRate / (2 * soundMps / headRadiusM)
)

// shadowAlpha is α(θ), θ the angle from the ear's axis, 0 to π.
func shadowAlpha(theta float64) float64 {
	return (1 + shadowAlphaMin/2) + (1-shadowAlphaMin/2)*math.Cos(theta/shadowThetaMin*math.Pi)
}

// The straight-ahead filter everything is equalised to: its coefficient,
// and from it the filter's two fixed numbers.
var (
	shadowFront = float32(shadowAlpha(math.Pi/2) * shadowK)
	shadowInv   = 1 / (1 + shadowFront)
	shadowA1    = (1 - shadowFront) * shadowInv
)

// shadowCoef is the coefficient for an ear θ from the sound (what the mixer glides between).
func shadowCoef(theta float64) float32 {
	return float32(shadowAlpha(theta) * shadowK)
}

// ear is one ear's head-shadow filter state (audio thread only).
type ear struct{ x1, y1 float32 }

// step filters one sample with coefficient p (shadowCoef). p = shadowFront is exactly flat.
func (e *ear) step(x, p float32) float32 {
	y := ((1+p)*x+(1-p)*e.x1)*shadowInv - shadowA1*e.y1
	e.x1, e.y1 = x, y
	return y
}

// headCoefs are the two ears' coefficients for a sound whose direction has
// sideways component x (−1 left .. 1 right): the right ear's axis points
// right, the left ear's left.
func headCoefs(x float64) (left, right float32) {
	x = max(-1, min(1, x))
	return shadowCoef(math.Acos(-x)), shadowCoef(math.Acos(x))
}
