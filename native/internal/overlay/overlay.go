// Package overlay is the app's overlay: the table, small, in a see-through
// window above everything else on the screen, that clicks go straight
// through, so you can see where everyone sits while you're in something
// else.
//
// It's a second webview, on a window made here with whatever the desktop
// needs for that (a layer-shell surface on KDE, Sway and Hyprland; a
// keep-above window on X11; a topmost, layered, click-through window on
// Windows), showing the site's own overlay.html (src/overlay). That page
// gets nothing from the bridge: it can't reach the engine or the room.
// What it draws comes from here:
//
//   - the call (who's in it, where they sit, who's muted), from the page in
//     the main window whenever it changes, passed on as it is;
//   - the rings (who's speaking, who's making any sound), worked out here
//     from the engine's levels and sent only when they change, so a quiet
//     call costs the overlay nothing, and a minimised main window (whose
//     timers the webview slows down) doesn't slow them;
//   - how it looks (how faded, and an outline while it's being placed).
//
// While it's off there's no window, no webview and nothing worked out:
// one atomic load per levels message.
package overlay

import (
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

type Config struct {
	// Dispatch runs a function on the UI thread (the main window's).
	Dispatch func(func())
	// Main is the main window's native handle (GtkWindow, HWND): the overlay goes on its screen unless told otherwise.
	Main unsafe.Pointer
	// URL is the overlay's page; Origin is the site's, the only one its page is trusted on.
	URL    string
	Origin string
	Debug  bool
}

// The latest of each kind of message, for a page that's only just loaded.
const (
	slotState = iota
	slotLook
	slotRings
	slots
)

type Overlay struct {
	cfg Config
	// A window is up: only then are levels looked at.
	up atomic.Bool
	// The page wants it up (it may still be being made).
	want atomic.Bool

	mu    sync.Mutex
	place proto.OverlayPlace
	msgs  [slots][]byte
	rings *rings

	// The UI thread's alone.
	win *window
	// A window's being made. On Windows that runs the UI thread's messages
	// meanwhile, so another Show (or a Hide) can arrive in the middle of it.
	opening bool
}

func New(cfg Config) *Overlay {
	return &Overlay{cfg: cfg, rings: newRings()}
}

// Supported: there's a way to put an overlay on this desktop.
func (o *Overlay) Supported() bool { return supported() }

// Show puts the overlay up, or moves it to the new place if it's up already.
func (o *Overlay) Show(p proto.OverlayPlace) error {
	p = sanitize(p)
	o.mu.Lock()
	o.place = p
	o.mu.Unlock()
	o.want.Store(true)
	var err error
	if !o.onUI(func() {
		if o.win == nil {
			if o.opening {
				// It goes where it was last asked to once it's made.
				return
			}
			o.opening = true
			w, e := openWindow(o)
			o.opening = false
			if err = e; err != nil {
				return
			}
			o.win = w
			if !o.want.Load() {
				// Hidden while it was being made.
				o.closeWindow()
				return
			}
			o.mu.Lock()
			p = o.place
			o.mu.Unlock()
		}
		o.win.place(p)
	}) {
		return errors.New("the window didn't answer")
	}
	if err == nil && o.want.Load() {
		o.up.Store(true)
	}
	return err
}

// Hide takes the overlay down: the window and its webview go, so it costs nothing until it's shown again.
func (o *Overlay) Hide() {
	o.want.Store(false)
	o.up.Store(false)
	o.mu.Lock()
	o.rings = newRings()
	o.msgs[slotRings] = nil
	o.mu.Unlock()
	o.cfg.Dispatch(o.closeWindow)
}

// Reset: a new page in the main window, or none. The overlay goes, and nothing of the old call is kept.
func (o *Overlay) Reset() {
	o.Hide()
	o.mu.Lock()
	o.msgs = [slots][]byte{}
	o.mu.Unlock()
}

// Close takes the overlay down at once, as the app quits. On the UI thread.
func (o *Overlay) Close() {
	o.want.Store(false)
	o.up.Store(false)
	o.closeWindow()
}

func (o *Overlay) closeWindow() {
	if o.win != nil {
		o.win.close()
		o.win = nil
	}
}

// State is the call, from the page (OverlayState in src/native/protocol.ts).
func (o *Overlay) State(raw json.RawMessage) { o.keep(slotState, "state", raw) }

// Look is how it looks, from the page (OverlayLook).
func (o *Overlay) Look(raw json.RawMessage) { o.keep(slotLook, "look", raw) }

func (o *Overlay) keep(slot int, t string, raw json.RawMessage) {
	// Through a value and back, so what reaches the overlay's page is plain
	// JSON (and so a JavaScript expression) whatever the page sent.
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return
	}
	msg, err := json.Marshal(map[string]any{"t": t, t: v})
	if err != nil {
		return
	}
	o.mu.Lock()
	o.msgs[slot] = msg
	o.mu.Unlock()
	o.post(msg)
}

// Levels: one of the engine's levels messages, ~20 a second while in a call.
func (o *Overlay) Levels(l proto.Levels) {
	if !o.up.Load() {
		return
	}
	o.mu.Lock()
	var msg []byte
	if o.rings.hear(l, time.Now()) {
		msg, _ = json.Marshal(struct {
			T        string   `json:"t"`
			Speaking []string `json:"speaking"`
			Audible  []string `json:"audible"`
		}{"rings", o.rings.speaking, o.rings.audible})
		o.msgs[slotRings] = msg
	}
	o.mu.Unlock()
	if msg != nil {
		o.post(msg)
	}
}

// Monitors lists the screens, for the page's settings.
func (o *Overlay) Monitors() proto.Monitors {
	var m proto.Monitors
	o.onUI(func() { m = monitors(o.cfg.Main) })
	m.T = "monitors"
	if m.Monitors == nil {
		m.Monitors = []proto.Monitor{}
	}
	return m
}

func (o *Overlay) post(msg []byte) {
	if !o.up.Load() {
		return
	}
	js := recv(msg)
	o.cfg.Dispatch(func() {
		if o.win != nil {
			o.win.eval(js)
		}
	})
}

func recv(msg []byte) string {
	return "window.__pivoiceOverlay&&window.__pivoiceOverlay._recv(" + string(msg) + ")"
}

// ready: the overlay's page has loaded and wants what it missed. On the UI thread.
func (o *Overlay) ready() {
	o.mu.Lock()
	msgs := o.msgs
	o.mu.Unlock()
	if o.win == nil {
		return
	}
	for _, m := range msgs {
		if m != nil {
			o.win.eval(recv(m))
		}
	}
}

// screensChanged: a screen came or went, or its size or usable area changed. On the UI thread.
func (o *Overlay) screensChanged() {
	o.mu.Lock()
	p := o.place
	o.mu.Unlock()
	if o.win != nil {
		o.win.place(p)
	}
}

// onUI runs f on the UI thread and waits for it, from any other goroutine.
func (o *Overlay) onUI(f func()) bool {
	done := make(chan struct{})
	o.cfg.Dispatch(func() {
		defer close(done)
		f()
	})
	select {
	case <-done:
		return true
	case <-time.After(10 * time.Second):
		log.Print("overlay: the UI thread didn't answer")
		return false
	}
}

// initScript runs before the overlay's page does: the only thing it gives
// that page is a way to hear from us (and to say it's ready), and only on
// the site's own origin.
func (o *Overlay) initScript() string {
	origin, _ := json.Marshal(o.cfg.Origin)
	return `(function () {
  if (window.top !== window || location.origin !== ` + string(origin) + `) return;
  var ready = window.__pivoiceOverlayReady;
  var api = {
    onmessage: null,
    ready: function () { if (typeof ready === 'function') ready(); },
    _recv: function (m) { if (api.onmessage) api.onmessage(m); }
  };
  Object.defineProperty(window, '__pivoiceOverlay', { value: api });
})();`
}

// Which edges each anchor keeps to.
const (
	edgeLeft = 1 << iota
	edgeRight
	edgeTop
	edgeBottom
)

var anchors = map[string]int{
	"top-left": edgeTop | edgeLeft, "top": edgeTop, "top-right": edgeTop | edgeRight,
	"left": edgeLeft, "center": 0, "right": edgeRight,
	"bottom-left": edgeBottom | edgeLeft, "bottom": edgeBottom, "bottom-right": edgeBottom | edgeRight,
}

func sanitize(p proto.OverlayPlace) proto.OverlayPlace {
	if _, ok := anchors[p.Anchor]; !ok {
		p.Anchor = "top-right"
	}
	p.Margin = min(max(p.Margin, 0), 2000)
	p.Size = min(max(p.Size, 120), 1200)
	return p
}

// origin is where the overlay's top left goes in an area (a screen's usable part), for anchor and margin.
func origin(edges int, margin, size, x, y, w, h int) (int, int) {
	switch {
	case edges&edgeLeft != 0:
		x += margin
	case edges&edgeRight != 0:
		x += w - size - margin
	default:
		x += (w - size) / 2
	}
	switch {
	case edges&edgeTop != 0:
		y += margin
	case edges&edgeBottom != 0:
		y += h - size - margin
	default:
		y += (h - size) / 2
	}
	return x, y
}

// monitorIDs names screens by maker and model, which stay the same when
// they're plugged in another way round (their order and connectors don't);
// two of the same get a number.
func monitorIDs(names []string) []string {
	seen := map[string]int{}
	out := make([]string, len(names))
	for i, n := range names {
		n = strings.TrimSpace(n)
		if n == "" {
			n = "Screen"
		}
		seen[n]++
		if seen[n] > 1 {
			n += " (" + strconv.Itoa(seen[n]) + ")"
		}
		out[i] = n
	}
	return out
}
