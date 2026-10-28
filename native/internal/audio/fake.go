package audio

import (
	"math"
	"sync"
	"time"
)

// Fake is a sound card with no hardware: the mic beeps (a 440 Hz tone for
// 200 ms every second, like Chrome's fake capture device) and what's played
// goes nowhere. For tests, CI and running headless (--fake-audio).
type Fake struct{}

const fakeBlock = 128

func (Fake) Devices() []DeviceDesc {
	return []DeviceDesc{{ID: "fake", Name: "Fake beeper", Input: true, Output: true, Default: true}}
}

func (Fake) Close() {}

type fakeStream struct {
	stop chan struct{}
	once sync.Once
	done chan struct{}
}

func (Fake) Open(_, _ string, cb Callback) (Stream, error) {
	s := &fakeStream{stop: make(chan struct{}), done: make(chan struct{})}
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
				if k%SampleRate < SampleRate/5 {
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
	return Info{Input: "Fake beeper", Output: "Nowhere", API: "fake", Block: fakeBlock}
}

func (s *fakeStream) Close() error {
	s.once.Do(func() { close(s.stop) })
	<-s.done
	return nil
}
