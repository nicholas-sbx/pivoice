//go:build linux && !nowebview

package main

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.0
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

extern int pvAllowNavigation(char *uri);

// Every navigation, the page's own frames' included, asks allowNavigation;
// no page gets to open a window.
static gboolean pv_decide(WebKitWebView *v, WebKitPolicyDecision *d, WebKitPolicyDecisionType type, gpointer data) {
	(void)v;
	(void)data;
	if (type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
		webkit_policy_decision_ignore(d);
		return TRUE;
	}
	if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) return FALSE;
	WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
	if (pvAllowNavigation((char *)webkit_uri_request_get_uri(webkit_navigation_action_get_request(a)))) return FALSE;
	webkit_policy_decision_ignore(d);
	return TRUE;
}

// webview puts its WebKitWebView straight into the window.
static int pv_lock_navigation(void *window) {
	GtkWidget *view = gtk_bin_get_child(GTK_BIN(window));
	if (!view || !WEBKIT_IS_WEB_VIEW(view)) return 0;
	g_signal_connect(view, "decide-policy", G_CALLBACK(pv_decide), NULL);
	return 1;
}
*/
import "C"

import (
	"log"

	webview "github.com/webview/webview_go"
)

// The site's origin, for pvAllowNavigation (set before the window navigates anywhere).
var navOrigin string

//export pvAllowNavigation
func pvAllowNavigation(uri *C.char) C.int {
	u := C.GoString(uri)
	if allowNavigation(navOrigin, u) {
		return 1
	}
	log.Printf("window: not going to %q, which isn't the site", u)
	return 0
}

// lockNavigation keeps the window on the site: WebKitGTK asks us before every navigation.
func lockNavigation(w webview.WebView, origin string) {
	navOrigin = origin
	if C.pv_lock_navigation(w.Window()) == 0 {
		log.Print("window: couldn't find the webview to keep it on the site")
	}
}
