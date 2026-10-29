package overlay

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

func TestRings(t *testing.T) {
	r := newRings()
	t0 := time.Unix(0, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }

	if r.hear(proto.Levels{Remotes: map[string]float64{"a": 0}}, at(0)) {
		t.Fatal("silence lit a ring")
	}
	// Speaking lights both rings; just audible, only the thin one.
	if !r.hear(proto.Levels{Self: 0.001, Remotes: map[string]float64{"a": 0.05}}, at(50)) {
		t.Fatal("no change when someone spoke")
	}
	if !slices.Equal(r.speaking, []string{"a"}) || !slices.Equal(r.audible, []string{"", "a"}) {
		t.Fatalf("speaking %v audible %v", r.speaking, r.audible)
	}
	// The same again: nothing to send.
	if r.hear(proto.Levels{Self: 0.001, Remotes: map[string]float64{"a": 0.05}}, at(100)) {
		t.Fatal("a change reported when nothing changed")
	}
	// Quiet, but within the hold: still lit, nothing sent.
	if r.hear(proto.Levels{Remotes: map[string]float64{"a": 0}}, at(350)) {
		t.Fatal("a ring went out within the hold")
	}
	// Past it: out.
	if !r.hear(proto.Levels{Remotes: map[string]float64{"a": 0}}, at(420)) {
		t.Fatal("the rings didn't go out after the hold")
	}
	if len(r.speaking) != 0 || len(r.audible) != 0 {
		t.Fatalf("still lit: %v %v", r.speaking, r.audible)
	}
}

func TestOrigin(t *testing.T) {
	// A 1920×1040 usable area at (0, 40) (a panel along the top), a 200 px overlay, 16 px in.
	for anchor, want := range map[string][2]int{
		"top-left": {16, 56}, "top": {860, 56}, "top-right": {1704, 56},
		"left": {16, 460}, "center": {860, 460}, "right": {1704, 460},
		"bottom-left": {16, 864}, "bottom": {860, 864}, "bottom-right": {1704, 864},
	} {
		x, y := origin(anchors[anchor], 16, 200, 0, 40, 1920, 1040)
		if x != want[0] || y != want[1] {
			t.Errorf("%s: (%d, %d), want %v", anchor, x, y, want)
		}
	}
}

func TestSanitize(t *testing.T) {
	p := sanitize(proto.OverlayPlace{Anchor: "nowhere", Margin: -5, Size: 1e6})
	if p.Anchor != "top-right" || p.Margin != 0 || p.Size != 1200 {
		t.Fatalf("%+v", p)
	}
}

func TestMonitorIDs(t *testing.T) {
	got := monitorIDs([]string{"Dell U2720Q", "", "Dell U2720Q", " "})
	want := []string{"Dell U2720Q", "Screen", "Dell U2720Q (2)", "Screen (2)"}
	if !slices.Equal(got, want) {
		t.Fatalf("%q", got)
	}
}

// What the page sends goes on as plain JSON, and only while the overlay's up.
func TestKeep(t *testing.T) {
	var ran []func()
	o := New(Config{Dispatch: func(f func()) { ran = append(ran, f) }, Origin: "https://pivoice.example"})
	o.State(json.RawMessage(`{"selfId":"me","name":" </script>"}`))
	o.Levels(proto.Levels{Self: 1})
	if len(ran) != 0 {
		t.Fatal("sent to an overlay that isn't up")
	}
	msg := string(o.msgs[slotState])
	if !strings.HasPrefix(msg, `{"state":{`) || !strings.Contains(msg, `"t":"state"`) || strings.Contains(msg, " ") || strings.Contains(msg, "</script>") {
		t.Fatalf("kept %s", msg)
	}
	o.State(json.RawMessage(`not json`))
	if string(o.msgs[slotState]) != msg {
		t.Fatal("bad JSON replaced the state")
	}
	o.up.Store(true)
	o.Levels(proto.Levels{Remotes: map[string]float64{"a": 0.5}})
	if len(ran) != 1 || o.msgs[slotRings] == nil {
		t.Fatalf("%d sent, rings %s", len(ran), o.msgs[slotRings])
	}
	if !strings.Contains(o.initScript(), `location.origin !== "https://pivoice.example"`) {
		t.Fatal("the init script doesn't check the origin")
	}
}
