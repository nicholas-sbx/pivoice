//go:build !linux && !nowebview

package main

import webview "github.com/webview/webview_go"

// lockNavigation: on Windows and macOS the window is kept on the site by
// its init script alone (initScript sends any other page back), as
// webview_go leaves WebView2's and WKWebView's navigation hooks to itself.
func lockNavigation(webview.WebView, string) {}
