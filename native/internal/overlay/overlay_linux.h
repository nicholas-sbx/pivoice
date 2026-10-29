#pragma once
#include <gtk/gtk.h>
#include "webview.h"

typedef struct {
	GtkWidget *win;
	webview_t view;
	// 1: a layer-shell surface; 0: an ordinary window.
	int layer;
	// X11: raising itself whenever the stacking changes.
	int restacking;
} pv_overlay;

// How the overlay can be put on this desktop: 2 layer-shell (Wayland, not
// GNOME), 1 a keep-above window (X11), 0 neither (Wayland without
// layer-shell: GNOME).
int pv_mode(void);
pv_overlay *pv_open(int debug, const char *url, const char *js);
// On `monitor` (-1: the primary one). A layer-shell surface keeps to `edges`
// (overlay.go's edgeLeft…) `margin` in; an ordinary window goes to x, y.
void pv_place(pv_overlay *o, int monitor, int edges, int margin, int size, int x, int y);
void pv_eval(pv_overlay *o, const char *js);
void pv_close(pv_overlay *o);

int pv_monitor_count(void);
// Its maker and model (to tell it by), usable area, and whether it's the primary one.
void pv_monitor_info(int i, char *name, int len, GdkRectangle *area, int *primary);
// The screen a GtkWindow is on, or -1.
int pv_monitor_of(void *window);
