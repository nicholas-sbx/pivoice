//go:build linux && !nowebview

package overlay

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.0
#cgo LDFLAGS: -ldl
#include <stdlib.h>
#include "overlay_linux.h"
*/
import "C"

import (
	"errors"
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

func (w *window) place(p proto.OverlayPlace) {
	i, area := w.monitor(p.Monitor)
	size, margin := int(p.Size), int(p.Margin)
	edges := anchors[p.Anchor]
	x, y := origin(edges, margin, size, int(area.x), int(area.y), int(area.width), int(area.height))
	C.pv_place(w.c, C.int(i), C.int(edges), C.int(margin), C.int(size), C.int(x), C.int(y))
}

// monitor finds the screen with this id, or else the one the main window is on, or else the primary one.
func (w *window) monitor(id string) (int, C.GdkRectangle) {
	list := screens()
	pick := -1
	for i, s := range list {
		if s.id == id && id != "" {
			pick = i
		}
	}
	if pick < 0 {
		pick = int(C.pv_monitor_of(w.o.cfg.Main))
	}
	if pick < 0 || pick >= len(list) {
		for i, s := range list {
			if s.primary {
				pick = i
			}
		}
	}
	if pick < 0 || pick >= len(list) {
		return -1, C.GdkRectangle{}
	}
	return pick, list[pick].area
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
	area     C.GdkRectangle
	primary  bool
}

func screens() []screen {
	n := int(C.pv_monitor_count())
	out := make([]screen, n)
	names := make([]string, n)
	var buf [256]C.char
	for i := range out {
		var primary C.int
		C.pv_monitor_info(C.int(i), &buf[0], C.int(len(buf)), &out[i].area, &primary)
		names[i] = C.GoString(&buf[0])
		out[i].name = names[i]
		out[i].primary = primary != 0
	}
	for i, id := range monitorIDs(names) {
		out[i].id = id
		if out[i].name == "" {
			out[i].name = id
		}
	}
	return out
}

func monitors(main unsafe.Pointer) proto.Monitors {
	mode := C.pv_mode()
	m := proto.Monitors{Placeable: mode != 0, OnTop: mode != 0}
	on := int(C.pv_monitor_of(main))
	for i, s := range screens() {
		m.Monitors = append(m.Monitors, proto.Monitor{
			ID: s.id, Name: s.name, Width: int(s.area.width), Height: int(s.area.height),
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
