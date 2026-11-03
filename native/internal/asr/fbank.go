package asr

import "math"

// Log-mel frames as NVIDIA NeMo models are fed them: the website's
// src/captions/fbank.ts, the same steps in the same order, so the app's
// streaming FastConformer hears the same numbers the browser's does
// (both held to tests/fixtures/streaming-ctc.json).
//
//	16 kHz, 25 ms frames every 10 ms, centred (frames reach past the start,
//	which is reflected), pre-emphasis 0.97, a periodic Hann window, a
//	512-point FFT, power spectrum, Slaney mel bins over 0–8 kHz with Slaney
//	area normalisation, log(max(e, FLT_EPSILON)). Not normalised: the
//	streaming model wants them as they are.
//
// sherpa-onnx's own streaming CTC recogniser computes Kaldi's features
// instead (a Povey window, HTK mels over 20–7600 Hz), which the model
// wasn't trained on: in noise it made half as many mistakes again. Hence
// this, and ONNX Runtime driven directly (streamctc.go).

const (
	fbRate    = 16000
	fbShift   = 160
	fbLength  = 400
	fbFFT     = 512
	fbBins    = fbFFT/2 + 1
	fbPreemph = 0.97
	fltEps    = 1.1920928955078125e-7
)

func melSlaney(hz float64) float64 {
	if hz <= 1000 {
		return hz * 3 / 200
	}
	return 15 + 14.545078505785561*math.Log(hz/1000)
}

func hzSlaney(mel float64) float64 {
	if mel <= 15 {
		return 200.0 / 3 * mel
	}
	return 1000 * math.Exp((mel-15)*0.06875177742094911)
}

type melBank struct {
	first int
	w     []float64
}

func melBanks(n int) []melBank {
	lo, hi := melSlaney(0), melSlaney(fbRate/2)
	delta := (hi - lo) / float64(n+1)
	width := float64(fbRate) / fbFFT
	banks := make([]melBank, n)
	for b := range banks {
		left := hzSlaney(lo + float64(b)*delta)
		centre := hzSlaney(lo + float64(b+1)*delta)
		right := hzSlaney(lo + float64(b+2)*delta)
		bank := melBank{first: -1}
		for i := 0; i < fbBins; i++ {
			hz := width * float64(i)
			if hz > left && hz < right {
				if bank.first < 0 {
					bank.first = i
				}
				var v float64
				if hz <= centre {
					v = (hz - left) / (centre - left)
				} else {
					v = (right - hz) / (right - centre)
				}
				bank.w = append(bank.w, v*(2/(right-left)))
			}
		}
		banks[b] = bank
	}
	return banks
}

// fbank computes frames one at a time; nothing allocates after it's made.
type fbank struct {
	bins     int
	banks    []melBank
	window   [fbLength]float64
	cos, sin [fbFFT / 2]float64
	rev      [fbFFT]uint16
	re, im   [fbFFT]float64
	power    [fbBins]float64
}

func newFbank(bins int) *fbank {
	f := &fbank{bins: bins, banks: melBanks(bins)}
	for i := range f.window {
		f.window[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/fbLength)
	}
	for i := range f.cos {
		f.cos[i] = math.Cos(2 * math.Pi * float64(i) / fbFFT)
		f.sin[i] = -math.Sin(2 * math.Pi * float64(i) / fbFFT)
	}
	const bits = 9
	for i := range f.rev {
		r := 0
		for b := 0; b < bits; b++ {
			r |= ((i >> b) & 1) << (bits - 1 - b)
		}
		f.rev[i] = uint16(r)
	}
	return f
}

// frameCount is how many frames a whole signal of n samples has.
func frameCount(n int) int { return (n + fbShift/2) / fbShift }

// firstSample is frame f's first sample (before the start, for the first: those are reflected).
func firstSample(f int) int { return fbShift*f + fbShift/2 - fbLength/2 }

// endSample is one past the last sample frame f needs.
func endSample(f int) int { return firstSample(f) + fbLength }

// frameOf computes frame f from wave, which holds the signal from sample
// offset on (every sample the frame needs, bar any before the start), into
// out[b] for each bin.
func (f *fbank) frameOf(wave []float32, offset, frame int, out []float32) {
	start := firstSample(frame)
	for s := 0; s < fbLength; s++ {
		i := start + s
		if i < 0 {
			i = -i - 1
		}
		f.re[s] = float64(wave[i-offset])
	}
	f.logMel(out)
}

func (f *fbank) logMel(out []float32) {
	re, im := &f.re, &f.im
	for s := fbLength - 1; s > 0; s-- {
		re[s] -= fbPreemph * re[s-1]
	}
	re[0] -= fbPreemph * re[0]
	for s := 0; s < fbLength; s++ {
		re[s] *= f.window[s]
	}
	for s := fbLength; s < fbFFT; s++ {
		re[s] = 0
	}
	*im = [fbFFT]float64{}
	f.fft()
	for k := 0; k < fbBins; k++ {
		f.power[k] = re[k]*re[k] + im[k]*im[k]
	}
	for b := 0; b < f.bins; b++ {
		bank := &f.banks[b]
		e := 0.0
		for k, w := range bank.w {
			e += w * f.power[bank.first+k]
		}
		out[b] = float32(math.Log(math.Max(e, fltEps)))
	}
}

func (f *fbank) fft() {
	re, im := &f.re, &f.im
	for i := 0; i < fbFFT; i++ {
		if j := int(f.rev[i]); j > i {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for size := 2; size <= fbFFT; size *= 2 {
		half, step := size/2, fbFFT/size
		for start := 0; start < fbFFT; start += size {
			for k := 0; k < half; k++ {
				c, s := f.cos[k*step], f.sin[k*step]
				a, b := start+k, start+k+half
				tr := re[b]*c - im[b]*s
				ti := re[b]*s + im[b]*c
				re[b] = re[a] - tr
				im[b] = im[a] - ti
				re[a] += tr
				im[a] += ti
			}
		}
	}
}
