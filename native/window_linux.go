//go:build linux && !nowebview

package main

import (
	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	"github.com/nicholas-sbx/pivoice/native/internal/webkit"
	webview "github.com/webview/webview_go"
)

// lockWindow holds the window to p (internal/webkit): it says whether it
// could, and so whether p.PageStart will be called.
func lockWindow(w webview.WebView, p nav.Policy) bool {
	return webkit.Lock(webkit.ViewOf(w.Window()), p)
}
