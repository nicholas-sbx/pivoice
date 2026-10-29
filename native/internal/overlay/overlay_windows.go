//go:build windows && !nowebview

package overlay

/*
#cgo LDFLAGS: -luser32 -lshcore
#include <stdlib.h>
#include "overlay_windows.h"
*/
import "C"

import (
	"errors"
	"strings"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/proto"
	// Its C API, which the overlay's webview is made with, comes with it.
	_ "github.com/webview/webview_go"
)

type window struct {
	o *Overlay
	c *C.pv_overlay
}

// The overlay up now, for the callbacks from C (all on the UI thread).
var current *Overlay

func supported() bool { return true }

func openWindow(o *Overlay) (*window, error) {
	url := C.CString(o.cfg.URL)
	js := C.CString(o.initScript())
	defer C.free(unsafe.Pointer(url))
	defer C.free(unsafe.Pointer(js))
	debug := C.int(0)
	if o.cfg.Debug {
		debug = 1
	}
	c := C.pv_open(debug, url, js)
	if c == nil {
		return nil, errors.New("couldn't make the overlay's webview")
	}
	current = o
	return &window{o: o, c: c}, nil
}

// place works in physical pixels: the size and margin are the screen's own
// scaled pixels, times its scale (WebView2 scales the page to match).
func (w *window) place(p proto.OverlayPlace) {
	s, ok := w.monitor(p.Monitor)
	if !ok {
		return
	}
	scale := func(v float64) int { return int(v*float64(s.dpi)/96 + 0.5) }
	size, margin := scale(p.Size), scale(p.Margin)
	x, y := origin(anchors[p.Anchor], margin, size, int(s.work.left), int(s.work.top), int(s.work.right-s.work.left), int(s.work.bottom-s.work.top))
	C.pv_place(w.c, C.int(x), C.int(y), C.int(size))
}

// monitor finds the screen with this id, or else the one the main window is on, or else the primary one.
func (w *window) monitor(id string) (screen, bool) {
	list := screens()
	if id != "" {
		for _, s := range list {
			if s.id == id {
				return s, true
			}
		}
	}
	if i := int(C.pv_monitor_of(w.o.cfg.Main)); i >= 0 && i < len(list) {
		return list[i], true
	}
	for _, s := range list {
		if s.primary {
			return s, true
		}
	}
	return screen{}, false
}

func (w *window) eval(js string) {
	s := C.CString(js)
	defer C.free(unsafe.Pointer(s))
	C.pv_eval(w.c, s)
}

func (w *window) close() {
	C.pv_close(w.c)
	if current == w.o {
		current = nil
	}
}

type screen struct {
	id, name string
	work     C.RECT
	dpi      int
	primary  bool
}

func screens() []screen {
	n := int(C.pv_monitor_count())
	out := make([]screen, 0, n)
	var device, name [256]C.char
	for i := range n {
		var s screen
		var dpi, primary C.int
		// Kept even if it can't be read, so the list lines up with pv_monitor_of's.
		C.pv_monitor_info(C.int(i), &device[0], C.int(len(device)), &name[0], C.int(len(name)), &s.work, &dpi, &primary)
		s.id = C.GoString(&device[0])
		s.dpi = max(int(dpi), 96)
		s.primary = primary != 0
		s.name = C.GoString(&name[0])
		// \\.\DISPLAY2 is Display 2, unless the screen has a name of its own (not its generic driver's).
		if s.name == "" || strings.HasPrefix(s.name, "Generic") {
			s.name = "Display " + strings.TrimPrefix(s.id, `\\.\DISPLAY`)
		}
		out = append(out, s)
	}
	return out
}

func monitors(main unsafe.Pointer) proto.Monitors {
	m := proto.Monitors{Placeable: true, OnTop: true}
	list := screens()
	on := int(C.pv_monitor_of(main))
	for i, s := range list {
		m.Monitors = append(m.Monitors, proto.Monitor{
			ID: s.id, Name: s.name,
			Width:   int(s.work.right-s.work.left) * 96 / s.dpi,
			Height:  int(s.work.bottom-s.work.top) * 96 / s.dpi,
			Primary: s.primary, Current: i == on,
		})
	}
	return m
}

//export pvOverlayReady
func pvOverlayReady() {
	if current != nil {
		current.ready()
	}
}

//export pvOverlayScreens
func pvOverlayScreens() {
	if current != nil {
		current.screensChanged()
	}
}
