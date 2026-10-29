package engine

import (
	"math"
	"math/cmplx"
	"testing"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
)

// The model's own answer: |H(ω, θ) / H(ω, 90°)|, in dB.
func shadowModelDb(theta, hz float64) float64 {
	w0 := soundMps / headRadiusM
	h := func(t float64) complex128 {
		jw := complex(0, 2*math.Pi*hz/(2*w0))
		return (1 + complex(shadowAlpha(t), 0)*jw) / (1 + jw)
	}
	return 20 * math.Log10(cmplx.Abs(h(theta)/h(math.Pi/2)))
}

// What the filter does to a steady sine, in dB.
func shadowFilterDb(theta, hz float64) float64 {
	var e ear
	p := shadowCoef(theta)
	const n = audio.SampleRate // a second: settled long before the end
	var peak float64
	for i := range n {
		y := e.step(float32(math.Sin(2*math.Pi*hz*float64(i)/audio.SampleRate)), p)
		if i > n/2 {
			peak = max(peak, math.Abs(float64(y)))
		}
	}
	return 20 * math.Log10(peak)
}

func TestHeadShadowMatchesTheModel(t *testing.T) {
	for _, deg := range []float64{0, 45, 90, 120, 150, 180} {
		for _, hz := range []float64{100, 500, 1000, 2000, 4000} {
			th := deg * math.Pi / 180
			want, got := shadowModelDb(th, hz), shadowFilterDb(th, hz)
			// The bilinear transform bends frequencies a little near the top; at 4 kHz that's a few per cent.
			if math.Abs(got-want) > 0.5 {
				t.Errorf("%v° from the ear, %v Hz: %.2f dB, the model says %.2f", deg, hz, got, want)
			}
		}
	}
	// The shape of it: the ear facing the sound is brighter, the shadowed one darker, the bass alike.
	if d := shadowFilterDb(0, 4000); d < 5 {
		t.Errorf("facing the sound, 4 kHz is only %+.1f dB", d)
	}
	// At 4 kHz the model's shadow is about −8 dB, heading for −17.6 dB at the very top.
	if d := shadowFilterDb(150*math.Pi/180, 4000); d > -6 {
		t.Errorf("in the shadow, 4 kHz is only %+.1f dB", d)
	}
	if d := shadowFilterDb(150*math.Pi/180, 100); math.Abs(d) > 0.5 {
		t.Errorf("in the shadow, 100 Hz is %+.1f dB: bass should go round the head", d)
	}
}

// Straight ahead is what you'd hear with spatial audio off: the mixer
// doesn't run the head at all there, and the filter is flat anyway.
func TestHeadStraightAheadIsUntouched(t *testing.T) {
	l, r := headCoefs(0)
	if l != shadowFront || r != shadowFront || woodworth(0) != 0 {
		t.Fatalf("straight ahead: coefficients %v, %v (want %v), delay %v", l, r, shadowFront, woodworth(0))
	}
	if newRemote("x").headActive(0, l, r) {
		t.Fatal("straight ahead still goes through the head model")
	}
	var e ear
	for i := range 1000 {
		x := float32(math.Sin(float64(i) * 0.37))
		if y := e.step(x, shadowFront); math.Abs(float64(y-x)) > 1e-6 {
			t.Fatalf("sample %d: %v in, %v out", i, x, y)
		}
	}
}

// Someone on your right: the left ear is the shadowed, late one.
func TestHeadSidesTheRightWayRound(t *testing.T) {
	l, r := headCoefs(1)
	if !(l < shadowFront && r > shadowFront) {
		t.Fatalf("on the right: left %v, right %v (front %v): want the left ear darker", l, r, shadowFront)
	}
	if woodworth(1) >= 0 {
		t.Fatalf("on the right, but the delay %v isn't on the left ear", woodworth(1))
	}
}

// Swinging someone from hard left to hard right every block, mid-sentence:
// the delay and both filters glide, so the output never jumps.
func TestHeadGlidesWithoutClicks(t *testing.T) {
	r := newRemote("x")
	mix := make([]float32, 128)
	out := make([]float32, 256)
	prevL, prevR := float32(0), float32(0)
	worst := float32(0)
	k := 0
	for b := range 200 {
		x := 1.0
		if b%2 == 0 {
			x = -1
		}
		sl, sr := headCoefs(x)
		for i := range mix {
			mix[i] = float32(0.5 * math.Sin(2*math.Pi*200*float64(k)/audio.SampleRate))
			k++
		}
		clear(out)
		r.mixHead(mix, out, 1, 1, float32(woodworth(x)), sl, sr)
		for i := range mix {
			worst = max(worst, abs32(out[2*i]-prevL), abs32(out[2*i+1]-prevR))
			prevL, prevR = out[2*i], out[2*i+1]
		}
	}
	// A 200 Hz sine at 0.5 moves 0.013 a sample; allow for the delay sweeping and the near ear's lift.
	if worst > 0.05 {
		t.Fatalf("biggest jump between samples %.3f: that's a click", worst)
	}
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

func TestMixHeadDoesNotAllocate(t *testing.T) {
	r := newRemote("x")
	mix, out := make([]float32, 128), make([]float32, 256)
	sl, sr := headCoefs(0.7)
	if a := testing.AllocsPerRun(1000, func() { r.mixHead(mix, out, 1, 1, float32(woodworth(0.7)), sl, sr) }); a > 0 {
		t.Fatalf("%v allocations", a)
	}
}
