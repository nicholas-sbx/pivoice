// Package ll is the low-latency engine's wire format and jitter buffer,
// ported from src/audio/ll so the app and browsers can talk to each other.
// Keep the two in step: a packet either side makes, the other must read.
package ll

import (
	"encoding/binary"
	"math"
)

/*
The low-latency engine's packet: one datagram on an unordered,
no-retransmit data channel (src/audio/ll/packet.ts).

	u8  version (1)
	u8  flags   bit 0: a capture-time stamp follows
	            bit 1: frames are raw 16-bit little-endian PCM, not Opus
	u8  frame count n
	[f64 capture time of the newest frame, ms since the epoch]   if flagged
	n × { u32 timestamp (sender's 48 kHz sample clock), u16 length, bytes }

Frames run oldest first; the last is the new one, the others are repeats of
the frames before it (redundancy).

Pings share the channel, with a first byte no audio packet has:

	u8  PING or PONG
	f64 the pinger's clock when it sent the ping, ms (a pong echoes it)
*/

const (
	PacketVersion = 1
	Ping          = 0xf0
	Pong          = 0xf1
	flagCapture   = 1
	flagPCM       = 2
)

type Frame struct {
	TS   uint32
	Data []byte
}

type Packet struct {
	Frames []Frame
	// Wall-clock capture time of the newest frame, ms since the epoch, if HasCapture.
	CaptureMs  float64
	HasCapture bool
	PCM        bool
}

// EncodePacket appends nothing: it returns a fresh buffer, since the data
// channel keeps it until it's sent.
func EncodePacket(frames []Frame, captureMs float64, hasCapture, pcm bool) []byte {
	size := 3
	if hasCapture {
		size += 8
	}
	for _, f := range frames {
		size += 6 + len(f.Data)
	}
	buf := make([]byte, size)
	buf[0] = PacketVersion
	var flags byte
	if hasCapture {
		flags |= flagCapture
	}
	if pcm {
		flags |= flagPCM
	}
	buf[1] = flags
	buf[2] = byte(len(frames))
	o := 3
	if hasCapture {
		binary.LittleEndian.PutUint64(buf[o:], math.Float64bits(captureMs))
		o += 8
	}
	for _, f := range frames {
		binary.LittleEndian.PutUint32(buf[o:], f.TS)
		binary.LittleEndian.PutUint16(buf[o+4:], uint16(len(f.Data)))
		copy(buf[o+6:], f.Data)
		o += 6 + len(f.Data)
	}
	return buf
}

// DecodePacket returns false for anything that isn't a well-formed packet.
// The frames point into buf.
func DecodePacket(buf []byte) (Packet, bool) {
	var p Packet
	if len(buf) < 3 || buf[0] != PacketVersion {
		return p, false
	}
	flags := buf[1]
	n := int(buf[2])
	o := 3
	if flags&flagCapture != 0 {
		if len(buf) < o+8 {
			return p, false
		}
		p.CaptureMs = math.Float64frombits(binary.LittleEndian.Uint64(buf[o:]))
		p.HasCapture = true
		o += 8
	}
	p.Frames = make([]Frame, 0, n)
	for i := 0; i < n; i++ {
		if len(buf) < o+6 {
			return p, false
		}
		ts := binary.LittleEndian.Uint32(buf[o:])
		l := int(binary.LittleEndian.Uint16(buf[o+4:]))
		if len(buf) < o+6+l {
			return p, false
		}
		p.Frames = append(p.Frames, Frame{TS: ts, Data: buf[o+6 : o+6+l]})
		o += 6 + l
	}
	p.PCM = flags&flagPCM != 0
	return p, true
}

func EncodePing(kind byte, sentMs float64) []byte {
	buf := make([]byte, 9)
	buf[0] = kind
	binary.LittleEndian.PutUint64(buf[1:], math.Float64bits(sentMs))
	return buf
}

// DecodePing returns the kind (Ping or Pong) and the time it echoes, or ok false for anything else.
func DecodePing(buf []byte) (kind byte, sentMs float64, ok bool) {
	if len(buf) != 9 || (buf[0] != Ping && buf[0] != Pong) {
		return 0, 0, false
	}
	return buf[0], math.Float64frombits(binary.LittleEndian.Uint64(buf[1:])), true
}

// PCMToBytes: float samples → 16-bit little-endian PCM, the way the browser does it.
func PCMToBytes(pcm []float32) []byte {
	out := make([]byte, len(pcm)*2)
	for i, v := range pcm {
		v = max(-1, min(1, v))
		var s int16
		if v < 0 {
			s = int16(v * 0x8000)
		} else {
			s = int16(v * 0x7fff)
		}
		binary.LittleEndian.PutUint16(out[i*2:], uint16(s))
	}
	return out
}

// BytesToPCM: 16-bit little-endian PCM → float samples.
func BytesToPCM(b []byte) []float32 {
	n := len(b) / 2
	out := make([]float32, n)
	for i := 0; i < n; i++ {
		out[i] = float32(int16(binary.LittleEndian.Uint16(b[i*2:]))) / 0x8000
	}
	return out
}

// Unwrapper turns the sender's 32-bit sample counter into one that keeps
// going up past the wrap (every ~25 hours at 48 kHz).
type Unwrapper struct {
	started  bool
	last     uint32
	lastFull int64
}

func (u *Unwrapper) Unwrap(ts uint32) int64 {
	if !u.started {
		u.started = true
		u.last = ts
		u.lastFull = int64(ts)
		return u.lastFull
	}
	d := int64(int32(ts - u.last))
	full := u.lastFull + d
	if d > 0 {
		u.last = ts
		u.lastFull = full
	}
	return full
}
