package opus

import (
	"math"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	enc, err := NewEncoder(LowDelay)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.Close()
	enc.SetBitrate(64000)
	dec, err := NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	defer dec.Close()
	// 2.5 ms frames, the smallest the engine sends: a 440 Hz tone should come back as one.
	frame := make([]float32, 120)
	var energy float64
	for k := 0; k < 200; k++ {
		for i := range frame {
			frame[i] = float32(0.5 * math.Sin(2*math.Pi*440*float64(k*120+i)/SampleRate))
		}
		pkt, err := enc.Encode(frame)
		if err != nil {
			t.Fatal(err)
		}
		pcm, err := dec.Decode(pkt)
		if err != nil {
			t.Fatal(err)
		}
		if len(pcm) != 120 {
			t.Fatalf("decoded %d samples", len(pcm))
		}
		if k > 100 {
			for _, v := range pcm {
				energy += float64(v * v)
			}
		}
	}
	rms := math.Sqrt(energy / (99 * 120))
	if rms < 0.25 || rms > 0.45 {
		t.Fatalf("tone came back at rms %v, want ~0.35", rms)
	}
}
