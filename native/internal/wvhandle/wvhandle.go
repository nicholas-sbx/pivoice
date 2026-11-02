//go:build !nowebview

// Package wvhandle reaches the native objects behind a webview_go WebView
// (its window, its widget, and on Windows the WebView2 controller), which
// webview's C API hands out but webview_go's Go API doesn't.
package wvhandle

/*
// webview's own C API (webview_go builds it into the app).
extern void *webview_get_native_handle(void *w, int kind);
*/
import "C"

import (
	"reflect"
	"unsafe"

	webview "github.com/webview/webview_go"
)

// What to get (webview_native_handle_kind_t).
const (
	Window     = 0 // GtkWindow, NSWindow, HWND
	Widget     = 1 // GtkWidget (the WebKitWebView), NSView, HWND
	Controller = 2 // ICoreWebView2Controller (Windows), WKWebView (macOS); nil on Linux
)

// Native is w's native handle of the given kind, or nil.
func Native(w webview.WebView, kind int) unsafe.Pointer {
	h := handle(w)
	if h == nil {
		return nil
	}
	return C.webview_get_native_handle(h, C.int(kind))
}

// handle is the webview_t inside webview_go's WebView, its only field
// (webview_go is pinned in go.mod, and the test checks this against the
// window webview_go itself reports). nil if that ever stops being so.
func handle(w webview.WebView) unsafe.Pointer {
	v := reflect.ValueOf(w)
	if v.Kind() != reflect.Pointer || v.IsNil() || v.Elem().Kind() != reflect.Struct {
		return nil
	}
	s := v.Elem()
	if s.NumField() != 1 || s.Field(0).Kind() != reflect.UnsafePointer {
		return nil
	}
	return s.Field(0).UnsafePointer()
}
