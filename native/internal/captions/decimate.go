package captions

import "math"

// The same filter as src/captions/decimate.ts: 95 taps of a Kaiser-windowed
// sinc (β 7) cutting at 7.3 kHz, so 48 kHz becomes the recognisers' 16 kHz
// with everything that would fold back into the models' band (up to 7.6 kHz)
// at least 60 dB down.
const (
	Taps     = 95
	cutoffHz = 7300
	beta     = 7
	inRate   = 48000
)

func i0(x float64) float64 {
	sum, term := 1.0, 1.0
	q := (x / 2) * (x / 2)
	for k := 1; k < 50; k++ {
		term *= q / float64(k*k)
		sum += term
		if term < sum*1e-12 {
			break
		}
	}
	return sum
}

// FilterTaps is the low-pass, unity gain at DC.
func FilterTaps() []float64 {
	h := make([]float64, Taps)
	m := float64(Taps-1) / 2
	fc := float64(cutoffHz) / inRate
	sum := 0.0
	for k := range h {
		t := float64(k) - m
		sinc := 2 * fc
		if t != 0 {
			sinc = math.Sin(2*math.Pi*fc*t) / (math.Pi * t)
		}
		r := t / m
		h[k] = sinc * i0(beta*math.Sqrt(max(0, 1-r*r))) / i0(beta)
		sum += h[k]
	}
	for k := range h {
		h[k] /= sum
	}
	return h
}

var taps = FilterTaps()

// Decimator takes 48 kHz to 16 kHz, a stream at a time. It allocates nothing.
type Decimator struct {
	line  [2 * Taps]float64
	pos   int
	phase int
}

// Push the samples in; the 16 kHz ones are appended to out (which should have room: len(in)/3+1).
func (d *Decimator) Push(in []float32, out []float32) []float32 {
	for _, v := range in {
		d.line[d.pos] = float64(v)
		d.line[d.pos+Taps] = float64(v)
		if d.pos++; d.pos == Taps {
			d.pos = 0
		}
		if d.phase++; d.phase == 3 {
			d.phase = 0
			acc := 0.0
			w := d.line[d.pos : d.pos+Taps]
			for k, x := range w {
				acc += taps[Taps-1-k] * x
			}
			out = append(out, float32(acc))
		}
	}
	return out
}

// Reset forgets what came before (a new segment starts from silence).
func (d *Decimator) Reset() { *d = Decimator{} }
