//go:build !nowebview

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sync"

	"github.com/nicholas-sbx/pivoice/native/internal/bridge"
	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	"github.com/nicholas-sbx/pivoice/native/internal/offline"
	"github.com/nicholas-sbx/pivoice/native/internal/overlay"
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
	// Everything that runs on the UI thread from elsewhere goes through
	// dispatch, which does nothing once the window's going: as it closes,
	// the bridge is still tidying up (the page is gone, so the overlay
	// goes), and a Dispatch on a destroyed webview crashes the app.
	var mu sync.Mutex
	closed := false
	dispatch := func(f func()) {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return
		}
		w.Dispatch(func() {
			// Queued before it closed, run as it's destroyed: not on a webview that's going.
			mu.Lock()
			gone := closed
			mu.Unlock()
			if !gone {
				f()
			}
		})
	}
	defer func() {
		mu.Lock()
		closed = true
		mu.Unlock()
		w.Destroy()
	}()
	w.SetTitle("Pivoice")
	w.SetSize(1280, 820, webview.HintNone)

	conn := b.NewConn(func(msg []byte) {
		// JSON is a JavaScript expression, and Go's escapes <, > and & and the line separators, so it's safe to splice in.
		js := "window.__pivoiceNative&&window.__pivoiceNative._recv(" + string(msg) + ")"
		dispatch(func() { w.Eval(js) })
	}, nil)
	// Bound before the init script below, so it exists when that runs.
	if err := w.Bind("__pivoiceSend", func(msg string) { conn.Receive([]byte(msg)) }); err != nil {
		return err
	}
	// Held to the site (internal/nav), and each new document in the window
	// ends whatever the last one was doing. Where the window can't tell us
	// that (macOS), the page says so itself: see initScript.
	b.PageGone = !lockWindow(w, nav.Policy{Origin: origin, PageStart: conn.Gone})
	w.Init(initScript(origin, home(page), b.Token))

	// The overlay, made only when the page asks for it (src/native/overlay.ts).
	ov := overlay.New(overlay.Config{Dispatch: dispatch, Main: w.Window(), URL: overlayPage(page), Origin: origin, Debug: devtools})
	b.Overlay = ov

	// The site is only opened once it answers: the webview's own error page
	// for a failed load is generic, and can't be replaced on every platform.
	// Until then the window shows the offline page (internal/offline).
	retry := make(chan struct{}, 1)
	if err := w.Bind("__pivoiceRetry", func() {
		select {
		case retry <- struct{}{}:
		default:
		}
	}); err != nil {
		return err
	}
	ctx, stop := context.WithCancel(context.Background())
	w.SetHtml(offline.Blank)
	go offline.Watch(ctx, offline.Config{
		URL:   home(page),
		Show:  func(html string) { dispatch(func() { w.SetHtml(html) }) },
		Open:  func() { dispatch(func() { w.Navigate(page) }) },
		Retry: retry,
	})
	w.Run()
	stop()
	ov.Close()
	conn.Gone()
	return nil
}

// home is the page the window opens, without the room code it may carry.
func home(page string) string {
	u, err := url.Parse(page)
	if err != nil {
		return page
	}
	u.Fragment = ""
	return u.String()
}

// overlayPage is the site's overlay.html, next to the page the window opens.
func overlayPage(page string) string {
	u, err := url.Parse(page)
	if err != nil {
		return page
	}
	u.Fragment = ""
	return u.ResolveReference(&url.URL{Path: "overlay.html"}).String()
}

// initScript runs at the start of every page in the window, before the
// page's own scripts. Each page starts with the bridge shut (whatever was
// there before stops: the window says so on Linux and Windows, the page's
// "gone" does on macOS), and only the site's own pages get the token to
// open it again: if the window ever ends up on another site, that site
// can't reach the microphone, or catch what the app sends the page. And it
// doesn't stay there: it's sent straight back to the site (on Linux and
// Windows the window doesn't even go: lockWindow).
func initScript(origin, home, token string) string {
	o, _ := json.Marshal(origin)
	h, _ := json.Marshal(home)
	t, _ := json.Marshal(token)
	return `(function () {
  if (window.top !== window || typeof window.__pivoiceSend !== 'function') return;
  var send = window.__pivoiceSend;
  send('{"t":"gone"}');
  if (location.origin !== ` + string(o) + `) {
    // Nobody here gets to stand in for the bridge's end, either.
    Object.defineProperty(window, '__pivoiceNative', { value: null });
    if (location.protocol !== 'about:') location.replace(` + string(h) + `);
    return;
  }
  var api = {
    token: ` + string(t) + `,
    onmessage: null,
    send: function (s) { send(s); },
    _recv: function (m) { if (api.onmessage) api.onmessage(m); }
  };
  Object.defineProperty(window, '__pivoiceNative', { value: api });
})();`
}
