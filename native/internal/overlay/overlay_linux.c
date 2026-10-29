//go:build linux && !nowebview

// The overlay's window on Linux: GTK 3, as the main window is (WebKitGTK
// 4.1 is GTK 3).
//
// On a Wayland desktop with layer-shell (KDE, Sway, Hyprland, most others
// but GNOME) it's a layer-shell surface on the overlay layer: above every
// window, full-screen ones too, placed by the compositor at a side of a
// screen with margins, never given the keyboard, and with an empty input
// region so the pointer goes straight through to what's under it. The same
// settings as flatshot-rs's recording controls. gtk-layer-shell is loaded
// when it's first wanted, if it's there, so the app needs nothing more to
// start.
//
// On X11 it's a window the window manager never sees (override-redirect),
// with an empty input shape. Not one it keeps above the others: it would
// put it in a frame of its own, and not every one passes the input shape
// on to that (openbox doesn't), which would catch the clicks. So it keeps
// itself on top: whenever the stacking changes, it raises itself again (an
// X event, nothing polled), and with no frame and no window manager it's on
// every workspace and in no taskbar anyway.
//
// Wayland without layer-shell (GNOME) lets no app keep a window on top or
// say where it goes: there it's an ordinary borderless window you can pin
// yourself (Alt+Space, Always on Top), so it takes clicks.

#include <dlfcn.h>
#include <string.h>
#include <gdk/gdk.h>
#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/gdkwayland.h>
#endif
#ifdef GDK_WINDOWING_X11
#include <gdk/gdkx.h>
#include <X11/Xlib.h>
#endif
#include <webkit2/webkit2.h>
#include "overlay_linux.h"

extern void pvOverlayReady(void);
extern void pvOverlayScreens(void);

// ---- gtk-layer-shell, if it's there ----------------------------------------------

// Its enums, as gtk-layer-shell.h has them.
enum { LS_EDGE_LEFT = 0, LS_EDGE_RIGHT, LS_EDGE_TOP, LS_EDGE_BOTTOM };
enum { LS_LAYER_OVERLAY = 3 };

static struct {
	gboolean (*is_supported)(void);
	void (*init_for_window)(GtkWindow *);
	void (*set_layer)(GtkWindow *, int);
	void (*set_namespace)(GtkWindow *, const char *);
	void (*set_anchor)(GtkWindow *, int, gboolean);
	void (*set_margin)(GtkWindow *, int, int);
	void (*set_exclusive_zone)(GtkWindow *, int);
	void (*set_monitor)(GtkWindow *, GdkMonitor *);
	// 0.6 and later; set_keyboard_interactivity before that.
	void (*set_keyboard_mode)(GtkWindow *, int);
	void (*set_keyboard_interactivity)(GtkWindow *, gboolean);
} ls;
static int ls_loaded; // 0 not tried, 1 there, -1 not

static int layer_shell(void) {
	if (ls_loaded) return ls_loaded > 0;
	ls_loaded = -1;
#ifdef GDK_WINDOWING_WAYLAND
	if (!GDK_IS_WAYLAND_DISPLAY(gdk_display_get_default())) return 0;
	void *h = dlopen("libgtk-layer-shell.so.0", RTLD_NOW | RTLD_LOCAL);
	if (!h) return 0;
	ls.is_supported = dlsym(h, "gtk_layer_is_supported");
	ls.init_for_window = dlsym(h, "gtk_layer_init_for_window");
	ls.set_layer = dlsym(h, "gtk_layer_set_layer");
	ls.set_namespace = dlsym(h, "gtk_layer_set_namespace");
	ls.set_anchor = dlsym(h, "gtk_layer_set_anchor");
	ls.set_margin = dlsym(h, "gtk_layer_set_margin");
	ls.set_exclusive_zone = dlsym(h, "gtk_layer_set_exclusive_zone");
	ls.set_monitor = dlsym(h, "gtk_layer_set_monitor");
	ls.set_keyboard_mode = dlsym(h, "gtk_layer_set_keyboard_mode");
	ls.set_keyboard_interactivity = dlsym(h, "gtk_layer_set_keyboard_interactivity");
	if (!ls.init_for_window || !ls.set_layer || !ls.set_anchor || !ls.set_margin || !ls.set_monitor || !ls.set_exclusive_zone) return 0;
	// Loaded, but is the compositor offering it? (Not on GNOME.)
	if (ls.is_supported && !ls.is_supported()) return 0;
	ls_loaded = 1;
#endif
	return ls_loaded > 0;
}

int pv_mode(void) {
	GdkDisplay *d = gdk_display_get_default();
	if (!d) return 0;
#ifdef GDK_WINDOWING_WAYLAND
	if (GDK_IS_WAYLAND_DISPLAY(d)) return layer_shell() ? 2 : 0;
#endif
	return 1;
}

// ---- screens ----------------------------------------------------------------------

int pv_monitor_count(void) {
	GdkDisplay *d = gdk_display_get_default();
	return d ? gdk_display_get_n_monitors(d) : 0;
}

void pv_monitor_info(int i, char *name, int len, GdkRectangle *area, int *primary) {
	GdkMonitor *m = gdk_display_get_monitor(gdk_display_get_default(), i);
	name[0] = 0;
	*primary = 0;
	memset(area, 0, sizeof *area);
	if (!m) return;
	const char *maker = gdk_monitor_get_manufacturer(m), *model = gdk_monitor_get_model(m);
	// What a screen that doesn't say reports (a virtual one, say).
	if (maker && !strcmp(maker, "Unknown")) maker = NULL;
	if (model && !strcmp(model, "Unknown")) model = NULL;
	g_snprintf(name, len, "%s%s%s", maker ? maker : "", maker && model ? " " : "", model ? model : "");
	gdk_monitor_get_workarea(m, area);
	*primary = gdk_monitor_is_primary(m);
}

int pv_monitor_of(void *window) {
	GdkDisplay *d = gdk_display_get_default();
	GdkWindow *w = window ? gtk_widget_get_window(GTK_WIDGET(window)) : NULL;
	if (!d || !w) return -1;
	GdkMonitor *m = gdk_display_get_monitor_at_window(d, w);
	for (int i = 0; m && i < gdk_display_get_n_monitors(d); i++)
		if (gdk_display_get_monitor(d, i) == m) return i;
	return -1;
}

// ---- the window ---------------------------------------------------------------------

// Nothing of the window's own is drawn: only what the page draws shows.
static gboolean clear(GtkWidget *w, cairo_t *cr, gpointer data) {
	(void)w;
	(void)data;
	cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
	cairo_set_source_rgba(cr, 0, 0, 0, 0);
	cairo_paint(cr);
	return FALSE;
}

static void ready(const char *seq, const char *req, void *arg) {
	(void)req;
	webview_return(((pv_overlay *)arg)->view, seq, 0, "");
	pvOverlayReady();
}

static void screens(GdkDisplay *d, GdkMonitor *m, gpointer data) {
	(void)d;
	(void)m;
	(void)data;
	pvOverlayScreens();
}

#ifdef GDK_WINDOWING_X11
// Something else was raised, moved or shown: back on top.
static GdkFilterReturn restack(GdkXEvent *xev, GdkEvent *ev, gpointer data) {
	(void)ev;
	XEvent *e = (XEvent *)xev;
	GdkWindow *ours = gtk_widget_get_window(((pv_overlay *)data)->win);
	if (!ours) return GDK_FILTER_CONTINUE;
	Window w = e->type == ConfigureNotify ? e->xconfigure.window : e->type == MapNotify ? e->xmap.window : None;
	if (w != None && w != GDK_WINDOW_XID(ours)) gdk_window_raise(ours);
	return GDK_FILTER_CONTINUE;
}
#endif

// The namespace KWin knows without animating it in (as flatshot-rs found); ours elsewhere.
static const char *layer_namespace(void) {
	const char *desktop = g_getenv("XDG_CURRENT_DESKTOP");
	return desktop && g_strrstr(desktop, "KDE") ? "utility" : "pivoice-overlay";
}

pv_overlay *pv_open(int debug, const char *url, const char *js) {
	int mode = pv_mode();
	pv_overlay *o = g_new0(pv_overlay, 1);
	GtkWindow *win = GTK_WINDOW(gtk_window_new(mode == 1 ? GTK_WINDOW_POPUP : GTK_WINDOW_TOPLEVEL));
	o->win = GTK_WIDGET(win);
	gtk_window_set_title(win, "Pivoice overlay");
	gtk_window_set_decorated(win, FALSE);
	gtk_window_set_skip_taskbar_hint(win, mode != 0);
	gtk_window_set_skip_pager_hint(win, mode != 0);
	GdkScreen *screen = gtk_widget_get_screen(o->win);
	GdkVisual *rgba = gdk_screen_get_rgba_visual(screen);
	if (rgba) gtk_widget_set_visual(o->win, rgba);
	gtk_widget_set_app_paintable(o->win, TRUE);
	g_signal_connect(o->win, "draw", G_CALLBACK(clear), NULL);
	if (mode == 2) {
		o->layer = 1;
		ls.init_for_window(win);
		ls.set_layer(win, LS_LAYER_OVERLAY);
		if (ls.set_namespace) ls.set_namespace(win, layer_namespace());
		// Kept out of panels' room (the margins count from the area windows get), and keeps none of its own.
		ls.set_exclusive_zone(win, 0);
		if (ls.set_keyboard_mode) ls.set_keyboard_mode(win, 0);
		else if (ls.set_keyboard_interactivity) ls.set_keyboard_interactivity(win, FALSE);
	} else if (mode == 0) {
		// Ask anyway, in case the desktop listens.
		gtk_window_set_keep_above(win, TRUE);
	}

	o->view = webview_create(debug, win);
	if (!o->view) {
		gtk_widget_destroy(o->win);
		g_free(o);
		return NULL;
	}
	GtkWidget *view = webview_get_native_handle(o->view, PV_HANDLE_WIDGET);
	if (view) {
		GdkRGBA none = {0, 0, 0, 0};
		webkit_web_view_set_background_color(WEBKIT_WEB_VIEW(view), &none);
		// A few faces don't need the GPU: drawn in software it holds about 36 MB of its own, against about 130 with it.
		webkit_settings_set_hardware_acceleration_policy(webkit_web_view_get_settings(WEBKIT_WEB_VIEW(view)), WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER);
	}
	webview_bind(o->view, "__pivoiceOverlayReady", ready, o);
	webview_init(o->view, js);
	webview_navigate(o->view, url);

	GdkDisplay *d = gdk_display_get_default();
	g_signal_connect(d, "monitor-added", G_CALLBACK(screens), NULL);
	g_signal_connect(d, "monitor-removed", G_CALLBACK(screens), NULL);
	return o;
}

void pv_place(pv_overlay *o, int monitor, int edges, int margin, int size, int x, int y) {
	GtkWindow *win = GTK_WINDOW(o->win);
	GdkDisplay *d = gdk_display_get_default();
	GdkMonitor *m = monitor >= 0 ? gdk_display_get_monitor(d, monitor) : NULL;
	if (!m) m = gdk_display_get_primary_monitor(d);
	if (!m) m = gdk_display_get_monitor(d, 0);
	gtk_widget_set_size_request(o->win, size, size);
	gtk_window_resize(win, size, size);
	if (o->layer) {
		ls.set_monitor(win, m);
		static const int edge[4] = {LS_EDGE_LEFT, LS_EDGE_RIGHT, LS_EDGE_TOP, LS_EDGE_BOTTOM};
		for (int i = 0; i < 4; i++) {
			int on = (edges >> i) & 1;
			ls.set_anchor(win, edge[i], on);
			ls.set_margin(win, edge[i], on ? margin : 0);
		}
	} else {
		gtk_window_move(win, x, y);
	}
	if (!gtk_widget_get_visible(o->win)) {
		gtk_widget_show_all(o->win);
		// Clicks go through, except where nothing can keep it on top (GNOME): there you need to reach its menu.
		int mode = pv_mode();
		if (mode != 0) {
			cairo_region_t *none = cairo_region_create();
			gtk_widget_input_shape_combine_region(o->win, none);
			cairo_region_destroy(none);
		}
#ifdef GDK_WINDOWING_X11
		if (mode == 1 && !o->restacking) {
			GdkWindow *root = gdk_get_default_root_window();
			gdk_window_set_events(root, gdk_window_get_events(root) | GDK_SUBSTRUCTURE_MASK);
			gdk_window_add_filter(root, restack, o);
			o->restacking = 1;
		}
#endif
	}
}

void pv_eval(pv_overlay *o, const char *js) {
	webview_eval(o->view, js);
}

void pv_close(pv_overlay *o) {
	g_signal_handlers_disconnect_by_func(gdk_display_get_default(), G_CALLBACK(screens), NULL);
#ifdef GDK_WINDOWING_X11
	if (o->restacking) gdk_window_remove_filter(gdk_get_default_root_window(), restack, o);
#endif
	webview_destroy(o->view);
	gtk_widget_destroy(o->win);
	g_free(o);
}
