//go:build !linux && !windows && !nowebview

package main

import (
	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	webview "github.com/webview/webview_go"
)

// lockWindow: on macOS (not released yet) the window is kept on the site
// by its init script alone (initScript sends any other page back), and
// the page says when it's gone itself.
func lockWindow(webview.WebView, nav.Policy) bool { return false }
