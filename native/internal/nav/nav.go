// Package nav is the one rule for where the app's webviews may go, and
// what they're refused, shared by the main window and the overlay on every
// platform that lets the app enforce it (internal/webkit on Linux,
// internal/wv2 on Windows).
package nav

import "net/url"

// Allow says whether a webview may go to uri: the site's own pages, and the
// empty frames a page makes for itself (about:blank), and nothing else.
// Links out go to the system's browser instead (the page sends them there,
// see src/native/bridge.ts), so anything else that tries to take the window
// somewhere is something we didn't ask for.
func Allow(origin, uri string) bool {
	if uri == "about:blank" || uri == "about:srcdoc" {
		return true
	}
	u, err := url.Parse(uri)
	return err == nil && u.Host != "" && u.Scheme+"://"+u.Host == origin
}

// Policy is what a webview is held to. Besides navigation (Allow), every
// platform's lock refuses new windows, downloads, and every permission a
// page can ask for (the clipboard's contents, the camera, location...):
// the app does the audio itself, and the site only ever writes to the
// clipboard.
type Policy struct {
	// The site's origin, scheme://host[:port].
	Origin string
	// PageStart, if set, is called as a new document starts loading in the
	// main frame (not for #fragment changes), before any of its scripts.
	// On the UI thread.
	PageStart func()
}

// Allow is nav.Allow for this policy's origin.
func (p Policy) Allow(uri string) bool { return Allow(p.Origin, uri) }
