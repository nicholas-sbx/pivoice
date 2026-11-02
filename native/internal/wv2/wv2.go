//go:build windows && !nowebview

// Package wv2 holds the app's WebView2 views (the main window's and the
// overlay's) to nav.Policy, as internal/webkit does on Linux: navigation,
// and every request for a page or frame, only to the site (anything else
// is answered here and never sent), no new windows, no downloads, and
// every permission request refused (webview itself allows reading the
// clipboard; this runs after it and wins).
//
// webview_go exposes none of WebView2's events, so this speaks WebView2's
// COM interfaces directly, from Go: no C. The vtable slots and IIDs are
// from the WebView2.h webview_go builds against (SDK 1.0.1150.38), and an
// interface's existing slots never change in later SDKs or runtimes.
package wv2

import (
	"errors"
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	"golang.org/x/sys/windows"
)

// Vtable slots (IUnknown's three first).
const (
	slotRelease = 2

	controllerGetCoreWebView2 = 25 // ICoreWebView2Controller

	addNavigationStarting         = 7 // ICoreWebView2
	addContentLoading             = 9
	addPermissionRequested        = 23
	addNewWindowRequested         = 44
	addWebResourceRequested       = 55
	addWebResourceRequestedFilter = 57
	getEnvironment                = 67 // ICoreWebView2_2
	addDownloadStarting           = 75 // ICoreWebView2_4

	createWebResourceResponse = 4 // ICoreWebView2Environment
	resourceGetRequest        = 3 // ICoreWebView2WebResourceRequestedEventArgs
	resourcePutResponse       = 5
	requestGetURI             = 3 // ICoreWebView2WebResourceRequest

	navigationGetURI    = 3 // ICoreWebView2NavigationStartingEventArgs
	navigationPutCancel = 8
	newWindowPutHandled = 6 // ICoreWebView2NewWindowRequestedEventArgs
	permissionPutState  = 7 // ICoreWebView2PermissionRequestedEventArgs
	downloadPutCancel   = 5 // ICoreWebView2DownloadStartingEventArgs
	downloadPutHandled  = 9

	permissionDeny  = 2 // COREWEBVIEW2_PERMISSION_STATE_DENY
	contextDocument = 1 // COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT
)

var (
	iidWebView2_2 = windows.GUID{Data1: 0x9e8f0cf8, Data2: 0xe670, Data3: 0x4b5e, Data4: [8]byte{0xb2, 0xbc, 0x73, 0xe0, 0x61, 0xe3, 0x18, 0x4c}}
	iidWebView2_4 = windows.GUID{Data1: 0x20d02d59, Data2: 0x6df2, Data3: 0x42dc, Data4: [8]byte{0xbd, 0x06, 0xf9, 0x8a, 0x69, 0x4b, 0x13, 0x02}}
)

// query is obj's interface iid (QueryInterface), or nil.
func query(obj unsafe.Pointer, iid *windows.GUID) unsafe.Pointer {
	var out unsafe.Pointer
	if call(obj, 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))) != 0 {
		return nil
	}
	return out
}

// call invokes method slot of the COM object obj.
func call(obj unsafe.Pointer, slot int, args ...uintptr) uintptr {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, slot*int(unsafe.Sizeof(uintptr(0)))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func release(obj unsafe.Pointer) { call(obj, slotRelease) }

// A handler is an event handler COM object: a vtable pointer first, as COM
// expects, then ours. One vtable serves every handler (each interface is
// QueryInterface, AddRef, Release, Invoke). WebView2 holds handlers by
// pointer, so a live one is kept in the alive set until its last Release.
type handler struct {
	vtbl   *handlerVtbl
	refs   atomic.Int32
	invoke func(args unsafe.Pointer)
}

type handlerVtbl struct{ queryInterface, addRef, release, invoke uintptr }

var (
	aliveMu sync.Mutex
	alive   = map[*handler]struct{}{}

	vtbl = handlerVtbl{
		// The one interface asked of a handler is its own (or IUnknown).
		queryInterface: windows.NewCallback(func(h *handler, iid, out *unsafe.Pointer) uintptr {
			h.refs.Add(1)
			*out = unsafe.Pointer(h)
			return 0
		}),
		addRef: windows.NewCallback(func(h *handler) uintptr { return uintptr(h.refs.Add(1)) }),
		release: windows.NewCallback(func(h *handler) uintptr {
			n := h.refs.Add(-1)
			if n == 0 {
				aliveMu.Lock()
				delete(alive, h)
				aliveMu.Unlock()
			}
			return uintptr(n)
		}),
		// Invoke(sender, args).
		invoke: windows.NewCallback(func(h *handler, sender, args unsafe.Pointer) uintptr {
			h.invoke(args)
			return 0
		}),
	}
)

// on registers f for the event that adder (an add_* slot) of obj adds handlers for.
func on(obj unsafe.Pointer, adder int, f func(args unsafe.Pointer)) error {
	h := &handler{vtbl: &vtbl, invoke: f}
	h.refs.Store(1)
	aliveMu.Lock()
	alive[h] = struct{}{}
	aliveMu.Unlock()
	var token int64 // EventRegistrationToken
	hr := call(obj, adder, uintptr(unsafe.Pointer(h)), uintptr(unsafe.Pointer(&token)))
	runtime.KeepAlive(&token)
	// Ours goes; WebView2 keeps its own while it's registered.
	call(unsafe.Pointer(h), slotRelease)
	if hr != 0 {
		return fmt.Errorf("adding a handler (slot %d): HRESULT %#x", adder, uint32(hr))
	}
	return nil
}

// uri reads an args object's URI (get_Uri).
func uri(args unsafe.Pointer, slot int) string {
	var p *uint16
	if call(args, slot, uintptr(unsafe.Pointer(&p))) != 0 || p == nil {
		return ""
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(p))
	return windows.UTF16PtrToString(p)
}

// allow is p.Allow, plus the documents the app itself puts in the window
// (webview's SetHtml navigates to a data: URL; Chromium never lets a page
// take the top frame to one itself).
func allow(p nav.Policy, u string) bool {
	return p.Allow(u) || strings.HasPrefix(u, "data:text/html")
}

// Lock holds the WebView2 behind controller (an ICoreWebView2Controller) to
// p from now on. Call it before the view goes anywhere, on the UI thread.
// Everything but downloads is required (they need a runtime from 2021 on):
// an error means the view isn't locked, though some of it may be.
func Lock(controller unsafe.Pointer, p nav.Policy) error {
	if controller == nil {
		return errors.New("no WebView2 controller")
	}
	var core unsafe.Pointer
	if hr := call(controller, controllerGetCoreWebView2, uintptr(unsafe.Pointer(&core))); hr != 0 || core == nil {
		return fmt.Errorf("get_CoreWebView2: HRESULT %#x", uint32(hr))
	}
	defer release(core)
	block, err := blockElsewhere(core, p)
	if err != nil {
		return err
	}
	err = errors.Join(
		on(core, addWebResourceRequested, block),
		on(core, addNavigationStarting, func(args unsafe.Pointer) {
			if u := uri(args, navigationGetURI); !allow(p, u) {
				log.Printf("webview: not going to %q, which isn't the site", u)
				call(args, navigationPutCancel, 1)
			}
		}),
		on(core, addNewWindowRequested, func(args unsafe.Pointer) {
			// Handled, and no window given: window.open gets null.
			call(args, newWindowPutHandled, 1)
		}),
		on(core, addPermissionRequested, func(args unsafe.Pointer) {
			call(args, permissionPutState, permissionDeny)
		}),
	)
	if p.PageStart != nil {
		// Before anything of a new document loads, the init scripts included; not for #fragment changes.
		err = errors.Join(err, on(core, addContentLoading, func(unsafe.Pointer) { p.PageStart() }))
	}
	if err != nil {
		return err
	}
	core4 := query(core, &iidWebView2_4)
	if core4 == nil {
		log.Print("webview: this WebView2 runtime can't refuse downloads (it's older than 2021)")
		return nil
	}
	defer release(core4)
	if err := on(core4, addDownloadStarting, func(args unsafe.Pointer) {
		call(args, downloadPutCancel, 1)
		call(args, downloadPutHandled, 1)
	}); err != nil {
		log.Printf("webview: %v", err)
	}
	return nil
}

// blockElsewhere makes the handler that answers any request for a document
// off the site (a page or a frame) with a 403 of our own, so it never goes
// out: WebView2 holds each request until its handler has run. Cancelling
// the navigation in NavigationStarting keeps the window where it is, but
// the request has already been sent by then, and a page could use that to
// carry data off past the site's CSP (location.href = elsewhere + data).
func blockElsewhere(core unsafe.Pointer, p nav.Policy) (func(args unsafe.Pointer), error) {
	core2 := query(core, &iidWebView2_2)
	if core2 == nil {
		return nil, errors.New("no ICoreWebView2_2 (a WebView2 runtime from before 2021)")
	}
	defer release(core2)
	// Kept for as long as the view lives: the handler makes its responses with it.
	var env unsafe.Pointer
	if hr := call(core2, getEnvironment, uintptr(unsafe.Pointer(&env))); hr != 0 || env == nil {
		return nil, fmt.Errorf("get_Environment: HRESULT %#x", uint32(hr))
	}
	all, _ := windows.UTF16PtrFromString("*")
	hr := call(core, addWebResourceRequestedFilter, uintptr(unsafe.Pointer(all)), contextDocument)
	runtime.KeepAlive(all)
	if hr != 0 {
		release(env)
		return nil, fmt.Errorf("AddWebResourceRequestedFilter: HRESULT %#x", uint32(hr))
	}
	reason, _ := windows.UTF16PtrFromString("Forbidden")
	headers, _ := windows.UTF16PtrFromString("")
	return func(args unsafe.Pointer) {
		var req unsafe.Pointer
		if call(args, resourceGetRequest, uintptr(unsafe.Pointer(&req))) != 0 || req == nil {
			return
		}
		u := uri(req, requestGetURI)
		release(req)
		if allow(p, u) {
			return
		}
		log.Printf("webview: not asking for %q, which isn't the site", u)
		var res unsafe.Pointer
		hr := call(env, createWebResourceResponse, 0, 403, uintptr(unsafe.Pointer(reason)), uintptr(unsafe.Pointer(headers)), uintptr(unsafe.Pointer(&res)))
		runtime.KeepAlive(reason)
		runtime.KeepAlive(headers)
		if hr != 0 || res == nil {
			return
		}
		call(args, resourcePutResponse, uintptr(res))
		release(res)
	}, nil
}
