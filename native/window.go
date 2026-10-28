//go:build !nowebview

package main

import (
	"encoding/json"
	"fmt"

	"github.com/nicholas-sbx/pivoice/native/internal/bridge"
	webview "github.com/webview/webview_go"
)

// runWindow opens the site in the system's own webview (WebKitGTK,
// WKWebView or WebView2: nothing bundled) and joins it to the bridge with
// a bound function one way and Eval the other.
func runWindow(b *bridge.Bridge, page, origin string, devtools bool) error {
	w := webview.New(devtools)
	if w == nil {
		return fmt.Errorf("couldn't open a window (is a webview installed? on Linux: WebKitGTK 4.1); try --browser")
	}
	defer w.Destroy()
	w.SetTitle("Pivoice")
	w.SetSize(1280, 820, webview.HintNone)

	conn := b.NewConn(func(msg []byte) {
		// JSON is a JavaScript expression, and Go's escapes <, > and & and the line separators, so it's safe to splice in.
		js := "window.__pivoiceNative&&window.__pivoiceNative._recv(" + string(msg) + ")"
		w.Dispatch(func() { w.Eval(js) })
	}, nil)
	// Bound before the init script below, so it exists when that runs.
	if err := w.Bind("__pivoiceSend", func(msg string) { conn.Receive([]byte(msg)) }); err != nil {
		return err
	}
	w.Init(initScript(origin, b.Token))
	w.Navigate(page)
	w.Run()
	conn.Gone()
	return nil
}

// initScript runs at the start of every page in the window, before the
// page's own scripts. Each page starts with the bridge shut (whatever was
// there before stops), and only the site's own pages get the token to open
// it again: if the window ever ends up on another site, that site can't
// reach the microphone.
func initScript(origin, token string) string {
	o, _ := json.Marshal(origin)
	t, _ := json.Marshal(token)
	return `(function () {
  if (window.top !== window || typeof window.__pivoiceSend !== 'function') return;
  var send = window.__pivoiceSend;
  send('{"t":"gone"}');
  if (location.origin !== ` + string(o) + `) return;
  var api = {
    token: ` + string(t) + `,
    onmessage: null,
    send: function (s) { send(s); },
    _recv: function (m) { if (api.onmessage) api.onmessage(m); }
  };
  Object.defineProperty(window, '__pivoiceNative', { value: api });
})();`
}
