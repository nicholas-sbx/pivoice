//go:build linux && !nowebview

// Package webkit holds the app's WebKitGTK views (the main window's and the
// overlay's) to nav.Policy: every navigation of every frame asks the
// policy, no page opens a window, nothing is downloaded, pages can't read
// the clipboard (webview turns that on; the site only ever writes to it),
// and every permission request is refused (WebKitGTK's default too, made
// explicit).
package webkit

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.0
#include <stdint.h>
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

extern int pvWebkitAllow(uintptr_t policy, char *uri);
extern void pvWebkitPageStart(uintptr_t policy);
extern void pvWebkitForget(uintptr_t policy);

static gboolean pv_decide(WebKitWebView *v, WebKitPolicyDecision *d, WebKitPolicyDecisionType type, gpointer data) {
	(void)v;
	switch (type) {
	case WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION:
		webkit_policy_decision_ignore(d);
		return TRUE;
	case WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION: {
		WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
		if (pvWebkitAllow((uintptr_t)data, (char *)webkit_uri_request_get_uri(webkit_navigation_action_get_request(a)))) return FALSE;
		webkit_policy_decision_ignore(d);
		return TRUE;
	}
	case WEBKIT_POLICY_DECISION_TYPE_RESPONSE:
		// Something the view can't show would be saved instead: refused.
		if (webkit_response_policy_decision_is_mime_type_supported(WEBKIT_RESPONSE_POLICY_DECISION(d))) return FALSE;
		webkit_policy_decision_ignore(d);
		return TRUE;
	default:
		return FALSE;
	}
}

static gboolean pv_permission(WebKitWebView *v, WebKitPermissionRequest *r, gpointer data) {
	(void)v;
	(void)data;
	webkit_permission_request_deny(r);
	return TRUE;
}

// Anything that gets as far as a download anyway (<a download>, say) stops there.
static void pv_download(WebKitWebContext *c, WebKitDownload *d, gpointer data) {
	(void)c;
	(void)data;
	webkit_download_cancel(d);
}

static void pv_load(WebKitWebView *v, WebKitLoadEvent ev, gpointer data) {
	(void)v;
	if (ev == WEBKIT_LOAD_STARTED) pvWebkitPageStart((uintptr_t)data);
}

static void pv_destroyed(GtkWidget *w, gpointer data) {
	(void)w;
	pvWebkitForget((uintptr_t)data);
}

static int pv_lock(void *widget, uintptr_t policy) {
	if (!widget || !WEBKIT_IS_WEB_VIEW(widget)) return 0;
	WebKitWebView *view = WEBKIT_WEB_VIEW(widget);
	webkit_settings_set_javascript_can_access_clipboard(webkit_web_view_get_settings(view), FALSE);
	g_signal_connect(view, "decide-policy", G_CALLBACK(pv_decide), (gpointer)policy);
	g_signal_connect(view, "permission-request", G_CALLBACK(pv_permission), NULL);
	g_signal_connect(view, "load-changed", G_CALLBACK(pv_load), (gpointer)policy);
	g_signal_connect(view, "destroy", G_CALLBACK(pv_destroyed), (gpointer)policy);
	WebKitWebContext *ctx = webkit_web_view_get_context(view);
	if (!g_signal_handler_find(ctx, G_SIGNAL_MATCH_FUNC, 0, 0, NULL, G_CALLBACK(pv_download), NULL))
		g_signal_connect(ctx, "download-started", G_CALLBACK(pv_download), NULL);
	return 1;
}

// webview puts its WebKitWebView straight into the window it's given.
static void *pv_view_of(void *window) {
	GtkWidget *child = window ? gtk_bin_get_child(GTK_BIN(window)) : NULL;
	return child && WEBKIT_IS_WEB_VIEW(child) ? child : NULL;
}
*/
import "C"

import (
	"log"
	"runtime/cgo"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/nav"
)

// ViewOf is the WebKitWebView webview put in a GtkWindow, or nil.
func ViewOf(window unsafe.Pointer) unsafe.Pointer { return C.pv_view_of(window) }

// Lock holds the WebKitWebView view to p from now on (call it before the
// view goes anywhere), and says whether it could: false if view isn't one.
// On the UI thread.
func Lock(view unsafe.Pointer, p nav.Policy) bool {
	h := cgo.NewHandle(p)
	if C.pv_lock(view, C.uintptr_t(h)) == 0 {
		h.Delete()
		return false
	}
	return true
}

//export pvWebkitAllow
func pvWebkitAllow(h C.uintptr_t, uri *C.char) C.int {
	p := cgo.Handle(h).Value().(nav.Policy)
	u := C.GoString(uri)
	if p.Allow(u) {
		return 1
	}
	log.Printf("webview: not going to %q, which isn't the site", u)
	return 0
}

//export pvWebkitPageStart
func pvWebkitPageStart(h C.uintptr_t) {
	if p := cgo.Handle(h).Value().(nav.Policy); p.PageStart != nil {
		p.PageStart()
	}
}

//export pvWebkitForget
func pvWebkitForget(h C.uintptr_t) { cgo.Handle(h).Delete() }
