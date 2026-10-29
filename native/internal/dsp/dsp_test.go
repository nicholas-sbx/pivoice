package dsp

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

func rmsOf(x []float32) float64 {
	var s float64
	for _, v := range x {
		s += float64(v) * float64(v)
	}
	return math.Sqrt(s / float64(len(x)))
}

// Something speech-like to play: noise shaped into syllables.
func talker(seed int64, n int, level float64) []float32 {
	r := rand.New(rand.NewSource(seed))
	out := make([]float32, n)
	lp := 0.0
	for i := range out {
		lp += (r.NormFloat64() - lp) * 0.3
		env := 0.5 + 0.5*math.Sin(2*math.Pi*4*float64(i)/SampleRate)
		out[i] = float32(level * lp * env)
	}
	return out
}

// The speakers play someone; the mic hears them back 20 ms later, quieter.
// After a few seconds to converge, most of that echo should be gone.
func TestEchoCancels(t *testing.T) {
	e, err := NewEcho()
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	const n = SampleRate * 6
	ref := talker(1, n, 0.3)
	mic := make([]float32, n)
	for i := 960; i < n; i++ {
		mic[i] = 0.5 * ref[i-960]
	}
	out := make([]float32, n)
	for k := 0; k+EchoFrame <= n; k += EchoFrame {
		e.Process(mic[k:k+EchoFrame], ref[k:k+EchoFrame], out[k:k+EchoFrame])
	}
	tail := n - SampleRate*2
	erle := 20 * math.Log10(rmsOf(mic[tail:])/max(rmsOf(out[tail:]), 1e-9))
	t.Logf("echo return loss enhancement after 4 s: %.1f dB", erle)
	if erle < 15 {
		t.Fatalf("only %.1f dB of the echo removed", erle)
	}
}

func TestAGCLevels(t *testing.T) {
	target := dbToGain(DefaultAGC.TargetDb)
	for _, c := range []struct {
		name  string
		level float64
	}{{"quiet", 0.04}, {"loud", 0.6}} {
		// Quiet is about −40 dBFS RMS (a soft voice a way off the mic), loud
		// about −16 dBFS with peaks near full scale.
		a := NewAGC(DefaultAGC)
		x := talker(2, SampleRate*8, c.level)
		in := rmsOf(x)
		peak := float32(0)
		for k := 0; k+128 <= len(x); k += 128 {
			a.Process(x[k:k+128], false, false)
		}
		for _, v := range x {
			peak = max(peak, float32(math.Abs(float64(v))))
		}
		got := rmsOf(x[len(x)-SampleRate*2:])
		t.Logf("%s talker: %.4f in, %.4f out (gain %.1f dB), peak %.2f", c.name, in, got, 20*math.Log10(a.Gain()), peak)
		if got < target/2 || got > target*2 {
			t.Errorf("%s talker came out at %.4f RMS, want near %.3f", c.name, got, target)
		}
		if peak > 1 {
			t.Errorf("%s talker clipped: peak %.2f", c.name, peak)
		}
	}
}

// A mic so quiet it's under −50 dBFS (where the old floor stopped counting
// it as speech) still gets brought up, as far as the most it may boost.
func TestAGCLiftsAQuietMic(t *testing.T) {
	a := NewAGC(DefaultAGC)
	x := talker(6, SampleRate*6, 0.008) // about −52 dBFS RMS
	in := rmsOf(x)
	for k := 0; k+128 <= len(x); k += 128 {
		a.Process(x[k:k+128], false, false)
	}
	got := rmsOf(x[len(x)-SampleRate:])
	t.Logf("quiet mic: %.1f dBFS in, %.1f dBFS out (gain %+.1f dB)", 20*math.Log10(in), 20*math.Log10(got), 20*math.Log10(a.Gain()))
	if g := 20 * math.Log10(a.Gain()); g < DefaultAGC.MaxBoostDb-1 {
		t.Fatalf("a −52 dBFS mic only got %+.1f dB, of the %v it may", g, DefaultAGC.MaxBoostDb)
	}
}

// The target set live: 10 dB lower, and a few seconds later it's 10 dB quieter.
func TestAGCRetunes(t *testing.T) {
	a := NewAGC(DefaultAGC)
	level := func(seed int64) float64 {
		x := talker(seed, SampleRate*5, 0.04) // about −40 dBFS: the target's in reach
		for k := 0; k+128 <= len(x); k += 128 {
			a.Process(x[k:k+128], false, false)
		}
		return 20 * math.Log10(rmsOf(x[len(x)-SampleRate:]))
	}
	before := level(8)
	lower := DefaultAGC
	lower.TargetDb -= 10
	a.Retune(lower)
	after := level(9)
	t.Logf("target %v dBFS: %.1f; %v: %.1f", DefaultAGC.TargetDb, before, lower.TargetDb, after)
	if d := before - after; d < 8 || d > 12 {
		t.Fatalf("retuned 10 dB lower, came out %.1f dB lower", d)
	}
}

// A loud, peaky talker pushed for a loud target: the peaks are held to the
// ceiling by the gain itself, so the limiter only catches the odd surprise,
// and nothing ever goes over it.
func TestAGCKeepsPeaksUnderTheCeiling(t *testing.T) {
	loud := DefaultAGC
	loud.TargetDb = -12 // asks for more than the peaks allow
	a := NewAGC(loud)
	x := talker(10, SampleRate*8, 0.3)
	for i := range x {
		// Now and then a much louder syllable, as people do.
		if (i/(SampleRate/2))%5 == 4 {
			x[i] *= 2.5
		}
	}
	for k := 0; k+128 <= len(x); k += 128 {
		a.Process(x[k:k+128], false, false)
	}
	tail := x[SampleRate*2:]
	var peak float64
	over := 0
	for _, v := range tail {
		peak = max(peak, math.Abs(float64(v)))
		if math.Abs(float64(v)) > dbToGain(loud.CeilingDb)*1.05 {
			over++
		}
	}
	t.Logf("peak %.1f dBFS, %.2f%% of samples past the ceiling (%v dBFS)", 20*math.Log10(peak), 100*float64(over)/float64(len(tail)), loud.CeilingDb)
	if peak > limitAt+1e-6 {
		t.Fatalf("peak %.3f: past the limiter", peak)
	}
	if share := float64(over) / float64(len(tail)); share > 0.005 {
		t.Fatalf("%.2f%% of samples past the ceiling: the gain isn't holding the peaks", 100*share)
	}
}

// RNNoise delays its output by exactly NoiseDelay on top of filling its
// frame, with its lookahead and without. (The chain's Delay counts on it.)
func TestNoiseDelay(t *testing.T) {
	if !NoiseAvailable {
		t.Skip("built without RNNoise")
	}
	for _, lookahead := range []bool{false, true} {
		t.Run(fmt.Sprintf("lookahead=%v", lookahead), func(t *testing.T) { testNoiseDelay(t, lookahead) })
	}
}

func testNoiseDelay(t *testing.T, lookahead bool) {
	d, err := NewDenoise(lookahead)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	// A voice-like burst, so the denoiser lets it through.
	x := talker(3, SampleRate, 0.3)
	in := append([]float32(nil), x...)
	for k := 0; k+NoiseFrame <= len(x); k += NoiseFrame {
		d.Process(x[k : k+NoiseFrame])
	}
	best, bestLag := 0.0, -1
	for lag := 0; lag < 3*NoiseFrame; lag++ {
		var c float64
		for i := SampleRate / 4; i < SampleRate*3/4; i++ {
			c += float64(in[i]) * float64(x[i+lag])
		}
		if c > best {
			best, bestLag = c, lag
		}
	}
	t.Logf("RNNoise delays its output by %d samples (%.1f ms) beyond filling its %d-sample frame", bestLag, float64(bestLag)/48, NoiseFrame)
	if bestLag != NoiseDelay(lookahead) {
		t.Fatalf("delay %d, the chain assumes %d", bestLag, NoiseDelay(lookahead))
	}
}

func TestChainDoesNotAllocate(t *testing.T) {
	c, err := NewChain(Settings{Echo: true, Noise: true, Gain: true, GateThreshold: 0.3, GateGraceMs: 300})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	mic, ref := talker(4, 128, 0.1), talker(5, 128, 0.1)
	for range 200 {
		c.Process(mic, ref)
	}
	if a := testing.AllocsPerRun(500, func() { c.Process(mic, ref) }); a > 0 {
		t.Fatalf("%.2f allocations per block", a)
	}
}

// ---- benchmarks: each as ns per call and as a share of the real time the audio lasts ----

func report(b *testing.B, samples int) {
	perCall := float64(b.Elapsed().Nanoseconds()) / float64(b.N)
	b.ReportMetric(perCall/(float64(samples)/SampleRate*1e9)*100, "%realtime")
}

func BenchmarkEcho(b *testing.B) {
	e, _ := NewEcho()
	defer e.Close()
	mic, ref, out := talker(1, EchoFrame, 0.1), talker(2, EchoFrame, 0.1), make([]float32, EchoFrame)
	b.ResetTimer()
	for range b.N {
		e.Process(mic, ref, out)
	}
	report(b, EchoFrame)
}

func BenchmarkNoise(b *testing.B) {
	if !NoiseAvailable {
		b.Skip("built without RNNoise")
	}
	d, _ := NewDenoise(false)
	defer d.Close()
	f := talker(1, NoiseFrame, 0.1)
	b.ResetTimer()
	for range b.N {
		d.Process(f)
	}
	report(b, NoiseFrame)
}

func BenchmarkGain(b *testing.B) {
	a := NewAGC(DefaultAGC)
	x := talker(1, 128, 0.1)
	b.ResetTimer()
	for range b.N {
		a.Process(x, true, true)
	}
	report(b, 128)
}

func BenchmarkChainAll(b *testing.B) {
	c, _ := NewChain(Settings{Echo: true, Noise: true, Gain: true, GateThreshold: 0.3, GateGraceMs: 300})
	defer c.Close()
	mic, ref := talker(4, 128, 0.1), talker(5, 128, 0.1)
	b.ResetTimer()
	for range b.N {
		c.Process(mic, ref)
	}
	report(b, 128)
}

// Whatever the block sizes, everything that went in comes out Delay later, in order.
func TestChainKeepsCount(t *testing.T) {
	for _, s := range []Settings{{Echo: true}, {Noise: true, GateThreshold: 0.3, GateGraceMs: 300}, {Noise: true, NoiseLookahead: true}, {Gain: true}, {Echo: true, Noise: true, Gain: true}} {
		c, err := NewChain(s)
		if err != nil {
			t.Fatal(err)
		}
		in, out := 0, 0
		for i := range 300 {
			n := 64 + (i*37)%400
			x := talker(int64(i), n, 0.1)
			out += len(c.Process(x, nil))
			in += n
			if out != in-c.Delay() {
				t.Fatalf("%+v: %d in, %d out, but the delay says %d", s, in, out, c.Delay())
			}
		}
		c.Close()
	}
}
