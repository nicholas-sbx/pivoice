package overlay

import (
	"slices"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

// The same thresholds and hold as src/audio/activity.ts, so the overlay's
// rings light when the page's do.
const (
	// RMS above this counts as talking (about −40 dBFS).
	speakingRMS = 0.01
	// Above this, something's coming through (about −80 dBFS).
	audibleRMS = 0.0001
	// A ring stays lit this long after the last block that lit it.
	ringHold = 300 * time.Millisecond
)

// rings works out who's speaking and who's making any sound from the
// engine's levels (~20 a second), and says when that changes: the overlay's
// page hears about the rings only then, which in a quiet call is never.
// Your own mic is "" (the page knows who you are).
type rings struct {
	loudAt, heardAt   map[string]time.Time
	speaking, audible []string
}

func newRings() *rings {
	return &rings{loudAt: map[string]time.Time{}, heardAt: map[string]time.Time{}}
}

// hear takes one levels message; true when the rings changed (then read speaking and audible).
func (r *rings) hear(l proto.Levels, now time.Time) bool {
	r.note("", l.Self, now)
	for id, v := range l.Remotes {
		r.note(id, v, now)
	}
	speaking := lit(r.loudAt, now)
	audible := lit(r.heardAt, now)
	if slices.Equal(speaking, r.speaking) && slices.Equal(audible, r.audible) {
		return false
	}
	r.speaking, r.audible = speaking, audible
	return true
}

func (r *rings) note(id string, rms float64, now time.Time) {
	if rms > speakingRMS {
		r.loudAt[id] = now
	}
	if rms > audibleRMS {
		r.heardAt[id] = now
	}
}

// lit: who's still within the hold, sorted (so the same people compare equal). Forgets the rest.
func lit(at map[string]time.Time, now time.Time) []string {
	out := []string{}
	for id, t := range at {
		if now.Sub(t) < ringHold {
			out = append(out, id)
		} else {
			delete(at, id)
		}
	}
	slices.Sort(out)
	return out
}
