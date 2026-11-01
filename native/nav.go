package main

import "net/url"

// allowNavigation says whether the window may go to uri: the site's own
// pages, and the empty frames a page makes for itself (about:blank), and
// nothing else. Links out go to the system's browser instead (the page
// sends them there, see src/native/bridge.ts), so anything else that tries
// to take the window somewhere is something we didn't ask for.
func allowNavigation(origin, uri string) bool {
	if uri == "about:blank" || uri == "about:srcdoc" {
		return true
	}
	u, err := url.Parse(uri)
	return err == nil && u.Host != "" && u.Scheme+"://"+u.Host == origin
}
