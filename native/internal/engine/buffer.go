package engine

import (
	"log"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

// The speakers' buffer, when the app manages it: it opens the sound card
// with the smallest buffer the device offers, and whenever the speakers
// run dry again and again (a block was late: a crackle each time), it
// reopens it with the next of these steps on top (ms), up to the last.
// It never comes back down by itself (each change is a gap in the audio,
// and coming down would only find the crackles again), but it starts
// from the smallest again for other devices, or when the app restarts.
var bufferSteps = []float64{0, 3, 6, 12, proto.MaxBufferMs}

const (
	// This many underruns within underrunWindow: a step up.
	underrunsToStep = 2
	underrunWindow  = 30 * time.Second
)

// How the watch runs: an engine's own, so a test can hurry its engine along.
type watchTiming struct {
	// Opening the sound card can flag an underrun or two before it settles.
	settle time.Duration
	every  time.Duration
}

var defaultWatch = watchTiming{settle: 2 * time.Second, every: time.Second}

// carried: glitches counted before the sound card was reopened for more
// buffer. It's the same call, and they're how you'd see it was needed.
type carried struct {
	inputOverflows, outputUnderflows, captureDropped int64
}

func (e *Engine) extraOutputMsLocked() float64 {
	if e.cfg.BufferAuto {
		return bufferSteps[e.autoStep]
	}
	return e.cfg.BufferMs
}

// underrunWatch says when it's time for more buffer, from the stream's
// running count of underruns, read once a second.
type underrunWatch struct {
	opened time.Time
	settle time.Duration
	seen   int64
	recent []time.Time
}

func (w *underrunWatch) see(now time.Time, total int64) bool {
	n := total - w.seen
	w.seen = total
	if now.Sub(w.opened) < w.settle {
		return false
	}
	for ; n > 0 && len(w.recent) < underrunsToStep; n-- {
		w.recent = append(w.recent, now)
	}
	for len(w.recent) > 0 && now.Sub(w.recent[0]) > underrunWindow {
		w.recent = w.recent[1:]
	}
	return len(w.recent) >= underrunsToStep
}

// watchBuffer steps the buffer up while this stream is open, if the app manages it.
func (e *Engine) watchBuffer(stop chan struct{}, s audio.Stream, tm watchTiming) {
	w := underrunWatch{opened: time.Now(), settle: tm.settle}
	t := time.NewTicker(tm.every)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			if w.see(now, s.Info().OutputUnderflows) && e.stepUp(s) {
				return
			}
		}
	}
}

// stepUp reopens the sound card with the next step of buffer, if the app
// manages it, there's a step left, and s is still the stream. Says whether it did.
func (e *Engine) stepUp(s audio.Stream) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stream != s || !e.cfg.BufferAuto || e.autoStep >= len(bufferSteps)-1 {
		return false
	}
	info := s.Info()
	c := e.carried
	c.inputOverflows += info.InputOverflows
	c.outputUnderflows += info.OutputUnderflows
	c.captureDropped += e.capDropped.Load()
	e.autoStep++
	log.Printf("audio: the speakers keep running dry: %g ms more buffer", bufferSteps[e.autoStep])
	e.closeAudioLocked()
	e.openAudioLocked()
	if e.stream != nil {
		e.carried = c
	}
	return true
}
