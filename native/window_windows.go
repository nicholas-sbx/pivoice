//go:build windows && !nowebview

package main

import (
	"log"

	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	"github.com/nicholas-sbx/pivoice/native/internal/wv2"
	"github.com/nicholas-sbx/pivoice/native/internal/wvhandle"
	webview "github.com/webview/webview_go"
)

// lockWindow holds the window to p (internal/wv2): it says whether it
// could, and so whether p.PageStart will be called.
func lockWindow(w webview.WebView, p nav.Policy) bool {
	if err := wv2.Lock(wvhandle.Native(w, wvhandle.Controller), p); err != nil {
		log.Printf("window: couldn't hold the window to the site: %v", err)
		return false
	}
	return true
}
