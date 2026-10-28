package ll

import (
	"math"
	"sort"
	"testing"
)

// The same cases as tests/ll.test.ts, so both ends of the wire are held to the same behaviour.

func TestPacketRoundTrip(t *testing.T) {
	frames := []Frame{{TS: 0xffff_ff00, Data: []byte{1, 2, 3}}, {TS: 16, Data: []byte{9}}}
	p, ok := DecodePacket(EncodePacket(frames, 1234.5, true, false))
	if !ok || !p.HasCapture || p.CaptureMs != 1234.5 {
		t.Fatalf("capture stamp lost: %+v", p)
	}
	if len(p.Frames) != 2 || p.Frames[0].TS != 0xffff_ff00 || string(p.Frames[0].Data) != "\x01\x02\x03" || p.Frames[1].TS != 16 {
		t.Fatalf("frames: %+v", p.Frames)
	}
	if p, _ := DecodePacket(EncodePacket(frames, 0, false, false)); p.HasCapture {
		t.Fatal("no stamp should mean no stamp")
	}
}

// A packet the browser made (encodePacket([{ts: 7, data: [1,2]}], 1.5, true) in packet.ts).
func TestReadsBrowserPacket(t *testing.T) {
	buf := []byte{1, 3, 1, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f, 7, 0, 0, 0, 2, 0, 1, 2}
	p, ok := DecodePacket(buf)
	if !ok || !p.PCM || p.CaptureMs != 1.5 || p.Frames[0].TS != 7 || string(p.Frames[0].Data) != "\x01\x02" {
		t.Fatalf("%v %+v", ok, p)
	}
	if got := EncodePacket(p.Frames, 1.5, true, true); string(got) != string(buf) {
		t.Fatalf("encodes differently: %v", got)
	}
}

func TestPings(t *testing.T) {
	kind, ms, ok := DecodePing(EncodePing(Ping, 1234.5))
	if !ok || kind != Ping || ms != 1234.5 {
		t.Fatal("ping")
	}
	if kind, _, _ := DecodePing(EncodePing(Pong, 7)); kind != Pong {
		t.Fatal("pong")
	}
	if _, ok := DecodePacket(EncodePing(Ping, 1)); ok {
		t.Fatal("ping read as audio")
	}
	if _, _, ok := DecodePing(EncodePacket([]Frame{{TS: 7, Data: make([]byte, 1)}}, 0, false, false)); ok {
		t.Fatal("audio read as ping")
	}
}

func TestPCM(t *testing.T) {
	samples := []float32{0, 0.5, -0.5, 1, -1, 0.25}
	p, _ := DecodePacket(EncodePacket([]Frame{{TS: 7, Data: PCMToBytes(samples)}}, 0, false, true))
	if !p.PCM {
		t.Fatal("pcm flag")
	}
	for i, v := range BytesToPCM(p.Frames[0].Data) {
		if math.Abs(float64(v-samples[i])) > 1e-4 {
			t.Fatalf("sample %d: %v", i, v)
		}
	}
}

func TestRejectsBadPackets(t *testing.T) {
	buf := EncodePacket([]Frame{{TS: 1, Data: make([]byte, 10)}}, 0, false, false)
	for _, b := range [][]byte{buf[:len(buf)-1], {2, 0, 0}, {1}} {
		if _, ok := DecodePacket(b); ok {
			t.Fatalf("accepted %v", b)
		}
	}
}

func TestUnwrap(t *testing.T) {
	var u Unwrapper
	for _, c := range []struct {
		in   uint32
		want int64
	}{{0xffff_ff00, 0xffff_ff00}, {0x100, 0x1_0000_0100}, {0xffff_ff80, 0xffff_ff80}, {0x200, 0x1_0000_0200}} {
		if got := u.Unwrap(c.in); got != c.want {
			t.Fatalf("unwrap %x = %x, want %x", c.in, got, c.want)
		}
	}
}

type simOpts struct {
	seconds  float64
	jitterMs float64
	lose     func(k int) bool
	silent   func(k int) bool
	cfg      func(*JitterConfig)
}

type simResult struct {
	stats         JitterStats
	meanDelayMs   float64
	delays        []float64
	played        float64
	silentSamples int
}

// A sender making 5 ms frames whose samples count up (value = its sender
// timestamp), so whatever comes out says exactly which moment of the
// sender's audio is playing and how late.
func simulate(o simOpts) simResult {
	const sr, F = 48000.0, 240
	cfg := JitterConfig{SampleRate: sr, MinMs: 0, MaxMs: 80, MarginMs: 2, Multiplier: 1.2, Stretch: 0.02, ConcealMs: 12, Percentile: 99, WindowSec: 2}
	if o.cfg != nil {
		o.cfg(&cfg)
	}
	jb := NewJitterBuffer(cfg)
	seed := int64(1)
	rand := func() float64 {
		seed = seed * 16807 % 2147483647
		return float64(seed) / 2147483647
	}
	const skew = 1_000_000.0
	type pend struct {
		arrival, ts float64
		pcm         []float32
	}
	var pending []pend
	total := o.seconds * sr
	for k := 0; float64(k*F) < total+sr/10; k++ {
		if (o.lose != nil && o.lose(k)) || (o.silent != nil && o.silent(k)) {
			continue
		}
		ts := float64(k * F)
		pcm := make([]float32, F)
		for j := range pcm {
			pcm[j] = float32(ts) + float32(j)
		}
		arrival := skew + ts + F + 96 + math.Floor(rand()*o.jitterMs*48)
		pending = append(pending, pend{arrival, ts, pcm})
	}
	sort.SliceStable(pending, func(a, b int) bool { return pending[a].arrival < pending[b].arrival })
	var r simResult
	out := make([]float32, 128)
	var played, samples float64
	p := 0
	for now := skew; now < skew+total; now += 128 {
		for p < len(pending) && pending[p].arrival <= now {
			jb.Push(pending[p].ts, pending[p].pcm, pending[p].arrival)
			p++
		}
		jb.Pull(out, now)
		for i, v := range out {
			if v > 0 {
				r.delays = append(r.delays, (now+float64(i)-skew-float64(v))/48)
				played++
			} else {
				r.silentSamples++
			}
			samples++
		}
	}
	r.stats = jb.Stats()
	settled := r.delays[len(r.delays)/2:]
	for _, d := range settled {
		r.meanDelayMs += d
	}
	r.meanDelayMs /= float64(len(settled))
	r.played = played / samples
	return r
}

func between(t *testing.T, what string, v, lo, hi float64) {
	t.Helper()
	if !(v > lo && v < hi) {
		t.Fatalf("%s = %v, want between %v and %v", what, v, lo, hi)
	}
}

func TestJitterCleanStream(t *testing.T) {
	r := simulate(simOpts{seconds: 4})
	// Capture (5 ms) + wire (2 ms) + one 128-sample block (2.7 ms) + the 2 ms margin.
	between(t, "delay", r.meanDelayMs, 5+2+2.6, 5+2+2.7+2+0.5)
	if r.stats.ConcealedPct != 0 || r.stats.Late != 0 || r.played < 0.98 {
		t.Fatalf("%+v played %v", r.stats, r.played)
	}
}

func TestJitterCoversJitter(t *testing.T) {
	r := simulate(simOpts{seconds: 6, jitterMs: 10})
	between(t, "jitter", r.stats.JitterMs, 8, 10.5)
	if math.Abs(r.stats.TargetMs-(r.stats.JitterMs*1.2+2)) > 1e-5 {
		t.Fatalf("target %v", r.stats.TargetMs)
	}
	if r.meanDelayMs > 7+2.7+r.stats.TargetMs+2 || r.played < 0.97 {
		t.Fatalf("delay %v played %v", r.meanDelayMs, r.played)
	}
}

func TestJitterInOrder(t *testing.T) {
	r := simulate(simOpts{seconds: 4, jitterMs: 4})
	tail := r.delays[len(r.delays)-48000:]
	for i := 1; i < len(tail); i++ {
		if math.Abs(tail[i]-tail[i-1]) >= 0.05 {
			t.Fatalf("jump at %d: %v → %v", i, tail[i-1], tail[i])
		}
	}
}

func settledOK(t *testing.T, r simResult) {
	t.Helper()
	for _, d := range r.delays[len(r.delays)-1000:] {
		if !(d > 9 && d < 13) {
			t.Fatalf("settled delay %v", d)
		}
	}
}

func TestJitterConceals(t *testing.T) {
	r := simulate(simOpts{seconds: 3, lose: func(k int) bool { return k == 300 }})
	if r.played < 0.97 || r.stats.ConcealedPct <= 0 {
		t.Fatalf("played %v %+v", r.played, r.stats)
	}
	settledOK(t, r)
}

func TestJitterSilence(t *testing.T) {
	r := simulate(simOpts{seconds: 3, silent: func(k int) bool { return k >= 200 && k < 400 }})
	if r.silentSamples < 40000 || r.stats.ConcealedPct != 0 {
		t.Fatalf("silent %v %+v", r.silentSamples, r.stats)
	}
	settledOK(t, r)
}

func TestJitterMinimum(t *testing.T) {
	r := simulate(simOpts{seconds: 3, cfg: func(c *JitterConfig) { c.MinMs = 30 }})
	if r.stats.TargetMs != 30 {
		t.Fatalf("target %v", r.stats.TargetMs)
	}
	between(t, "delay", r.meanDelayMs, 30+7+2.6, 30+7+2.7+1)
}

func TestPullDoesNotAllocate(t *testing.T) {
	jb := NewJitterBuffer(JitterConfig{SampleRate: 48000, MaxMs: 80, MarginMs: 2, Multiplier: 1, Stretch: 0.02, ConcealMs: 12, Percentile: 99, WindowSec: 2})
	out := make([]float32, 128)
	pcm := make([]float32, 128)
	now := 0.0
	ts := 0.0
	for i := 0; i < 200; i++ {
		jb.Push(ts, pcm, now)
		ts += 128
		jb.Pull(out, now)
		now += 128
	}
	allocs := testing.AllocsPerRun(100, func() {
		jb.Pull(out, now)
		now += 128
	})
	if allocs > 0 {
		t.Fatalf("Pull allocates %v times a call: it runs on the audio thread", allocs)
	}
}
