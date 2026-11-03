package audio

import (
	"encoding/binary"
	"errors"
	"math"
	"sync"
	"time"
)

// Fake is a sound card with no hardware: the mic beeps (a 440 Hz tone for
// 200 ms every second, like Chrome's fake capture device), or plays Mic
// over and over if it's set (someone talking, for the captions' end-to-end
// run), and what's played goes nowhere. For tests, CI and running headless
// (--fake-audio).
type Fake struct {
	// 48 kHz.
	Mic []float32
}

const fakeBlock = 128

func (Fake) Devices() []DeviceDesc {
	return []DeviceDesc{{ID: "fake", Name: "Fake beeper", Input: true, Output: true, Default: true}}
}

func (Fake) Close() {}

type fakeStream struct {
	extra float64
	mic   []float32
	stop  chan struct{}
	once  sync.Once
	done  chan struct{}
}

func (f Fake) Open(o Options, cb Callback) (Stream, error) {
	s := &fakeStream{extra: o.ExtraOutputMs, mic: f.Mic, stop: make(chan struct{}), done: make(chan struct{})}
	go s.run(cb)
	return s, nil
}

// Blocks of 128 on a steady clock, the way a sound card would call back.
func (s *fakeStream) run(cb Callback) {
	defer close(s.done)
	in := make([]float32, fakeBlock)
	out := make([]float32, 2*fakeBlock)
	start := time.Now()
	var n int64
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
		}
		due := int64(time.Since(start).Seconds() * SampleRate)
		for n+fakeBlock <= due {
			for i := range in {
				k := n + int64(i)
				if len(s.mic) > 0 {
					in[i] = s.mic[k%int64(len(s.mic))]
				} else if k%SampleRate < SampleRate/5 {
					in[i] = float32(0.3 * math.Sin(2*math.Pi*440*float64(k)/SampleRate))
				} else {
					in[i] = 0
				}
			}
			wall := epochMs(start) + float64(n)*1000/SampleRate
			cb(in, out, Times{InputMs: wall, OutputMs: wall + 1000*fakeBlock/SampleRate})
			n += fakeBlock
		}
	}
}

func (s *fakeStream) Info() Info {
	return Info{Input: "Fake beeper", Output: "Nowhere", API: "fake", Block: fakeBlock, OutputLatencyMs: s.extra, ExtraOutputMs: s.extra}
}

func (s *fakeStream) Close() error {
	s.once.Do(func() { close(s.stop) })
	<-s.done
	return nil
}

// ReadWav16k reads a 16 kHz mono 16-bit WAV (as tests/fixtures/speech.wav)
// and brings it to 48 kHz, for Fake.Mic.
func ReadWav16k(b []byte) ([]float32, error) {
	if len(b) < 44 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, errors.New("not a WAV file")
	}
	// The data chunk, after whatever chunks come first.
	for p := 12; p+8 <= len(b); {
		id, size := string(b[p:p+4]), int(binary.LittleEndian.Uint32(b[p+4:]))
		p += 8
		if id != "data" {
			p += size + size%2
			continue
		}
		data := b[p:min(len(b), p+size)]
		n := len(data) / 2
		out := make([]float32, 3*n)
		prev := float32(0)
		for i := 0; i < n; i++ {
			v := float32(int16(binary.LittleEndian.Uint16(data[2*i:]))) / 32768
			// Three samples for each, straight from one to the next.
			out[3*i] = prev + (v-prev)/3
			out[3*i+1] = prev + 2*(v-prev)/3
			out[3*i+2] = v
			prev = v
		}
		return out, nil
	}
	return nil, errors.New("no audio in the WAV file")
}
