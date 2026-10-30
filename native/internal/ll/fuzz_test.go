package ll

import (
	"encoding/binary"
	"math"
	"testing"
)

// FuzzDecodePacket: whatever a peer sends on the low-latency channel.
// Well-formed packets must survive a round trip; nothing may panic.
func FuzzDecodePacket(f *testing.F) {
	f.Add(EncodePacket([]Frame{{TS: 960, Data: []byte{1, 2, 3}}}, 1.7e12, true, false))
	f.Add(EncodePacket([]Frame{{TS: 0, Data: PCMToBytes(make([]float32, 480))}, {TS: 480, Data: nil}}, 0, false, true))
	f.Add(EncodePing(Ping, 12.5))
	f.Fuzz(func(t *testing.T, buf []byte) {
		DecodePing(buf)
		p, ok := DecodePacket(buf)
		if !ok {
			return
		}
		again := EncodePacket(p.Frames, p.CaptureMs, p.HasCapture, p.PCM)
		q, ok := DecodePacket(again)
		if !ok || len(q.Frames) != len(p.Frames) {
			t.Fatalf("round trip lost frames: %d → %d", len(p.Frames), len(q.Frames))
		}
		for _, fr := range p.Frames {
			BytesToPCM(fr.Data)
		}
	})
}

// FuzzJitterBuffer: packets in the engine's order (receiveLL: unwrap, drop
// what's not newer, PCM straight through), blocks of any size pulled out the
// way the mixer does, under the page's own settings range. Nothing may
// panic, hang or play anything but finite samples in [-1, 1]-ish.
func FuzzJitterBuffer(f *testing.F) {
	seed := []byte{0, 128, 0}
	for i := range 20 {
		seed = append(seed, EncodePacket([]Frame{{TS: uint32(i * 480), Data: PCMToBytes(make([]float32, 480))}}, 0, false, true)...)
	}
	f.Add(seed)
	f.Fuzz(func(t *testing.T, in []byte) {
		if len(in) < 3 {
			return
		}
		cfg := JitterConfig{
			SampleRate: 48000, MinMs: float64(in[0] % 40), MaxMs: 40 + float64(in[0]%200), MarginMs: 3,
			Multiplier: 1 + float64(in[1]%3), Stretch: float64(in[1]%5) / 100, ConcealMs: float64(in[2] % 60),
			Percentile: 80 + float64(in[2]%21), WindowSec: 1 + float64(in[2]%10),
		}
		jb := NewJitterBuffer(cfg)
		var u Unwrapper
		last := int64(math.MinInt64)
		clock := 0.0
		out := make([]float32, 4096)
		in = in[3:]
		for steps := 0; len(in) >= 4 && steps < 2000; steps++ {
			// A packet of the next n bytes, then a block of `block` samples pulled.
			n := int(binary.LittleEndian.Uint16(in))
			block := 1 + int(in[2])<<4
			in = in[4:]
			n = min(n, len(in))
			p, ok := DecodePacket(in[:n])
			in = in[n:]
			if ok {
				for _, fr := range p.Frames {
					ts := u.Unwrap(fr.TS)
					if ts <= last {
						continue
					}
					last = ts
					jb.Push(float64(ts), BytesToPCM(fr.Data), clock)
				}
			}
			buf := out[:min(block, len(out))]
			jb.Pull(buf, clock)
			for i, v := range buf {
				if math.IsNaN(float64(v)) || math.Abs(float64(v)) > 4 {
					t.Fatalf("sample %d is %v", i, v)
				}
			}
			clock += float64(len(buf))
			jb.Stats()
		}
	})
}
