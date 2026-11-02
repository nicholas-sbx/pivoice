package audio

import (
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/rt"
)

// Opens the default device through the binding and checks blocks arrive.
// Needs a sound card (or ALSA's null device: PIVOICE_AUDIO_TEST=1 with
// `pcm.!default { type null }` in ~/.asoundrc); skipped otherwise.
func TestPortAudioCallback(t *testing.T) {
	if os.Getenv("PIVOICE_AUDIO_TEST") == "" {
		t.Skip("set PIVOICE_AUDIO_TEST=1 to open a real device")
	}
	pa, err := NewPortAudio()
	if err != nil {
		t.Fatal(err)
	}
	defer pa.Close()
	t.Logf("devices: %+v", pa.Devices())
	var blocks, samples atomic.Int64
	s, err := pa.Open(Options{}, func(in, out []float32, _ Times) {
		blocks.Add(1)
		samples.Add(int64(len(in)))
		if len(out) != 2*len(in) {
			t.Errorf("out %d for in %d", len(out), len(in))
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	// The binding itself allocates nothing per block: the garbage collector
	// shouldn't have a reason to stop the audio thread on our account.
	var before, after runtime.MemStats
	b0 := blocks.Load()
	runtime.ReadMemStats(&before)
	time.Sleep(300 * time.Millisecond)
	runtime.ReadMemStats(&after)
	n := blocks.Load() - b0
	info := s.Info()
	_ = s.Close()
	t.Logf("%+v: %d blocks, %d samples; %d allocations over %d blocks", info, blocks.Load(), samples.Load(), after.Mallocs-before.Mallocs, n)
	if samples.Load() < SampleRate/4 {
		t.Fatalf("only %d samples", samples.Load())
	}
	if per := float64(after.Mallocs-before.Mallocs) / float64(n); per > 0.01 {
		t.Fatalf("%.3f allocations per block", per)
	}
	// Linux: the callback's thread was put forward for realtime, whether or not the system allowed it.
	if rt.Supported && info.Realtime == "" {
		t.Fatal("the audio thread wasn't put forward for realtime priority")
	}
}

// More buffer for the speakers, asked for: the stream says it got it.
func TestPortAudioExtraOutput(t *testing.T) {
	if os.Getenv("PIVOICE_AUDIO_TEST") == "" {
		t.Skip("set PIVOICE_AUDIO_TEST=1 to open a real device")
	}
	pa, err := NewPortAudio()
	if err != nil {
		t.Fatal(err)
	}
	defer pa.Close()
	latency := func(extra float64) Info {
		s, err := pa.Open(Options{ExtraOutputMs: extra}, func(in, out []float32, _ Times) {})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		time.Sleep(100 * time.Millisecond)
		return s.Info()
	}
	small, big := latency(0), latency(24)
	t.Logf("smallest: %+v\n+24 ms: %+v", small, big)
	if big.ExtraOutputMs != 24 || big.OutputLatencyMs < small.OutputLatencyMs+10 {
		t.Fatalf("asked for 24 ms more: %.1f ms, was %.1f", big.OutputLatencyMs, small.OutputLatencyMs)
	}
}
