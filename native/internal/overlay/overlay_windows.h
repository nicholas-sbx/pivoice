#pragma once
#include <windows.h>
#include "webview.h"

typedef struct {
	HWND hwnd;
	// webview's own window inside ours, which it sizes only in windows of its own.
	HWND widget;
	webview_t view;
	// Told when another app comes to the front, to go back on top of it.
	HWINEVENTHOOK front;
} pv_overlay;

pv_overlay *pv_open(int debug, const char *url, const char *js);
// Where it goes, in physical pixels.
void pv_place(pv_overlay *o, int x, int y, int size);
void pv_eval(pv_overlay *o, const char *js);
void pv_close(pv_overlay *o);

// Lists the screens afresh; pv_monitor_info and pv_monitor_of read that list.
int pv_monitor_count(void);
// Its device name (\\.\DISPLAY1, to tell it by), its own name, usable area in physical pixels, scale, and whether it's primary.
int pv_monitor_info(int i, char *device, int len, char *name, int nlen, RECT *work, int *dpi, int *primary);
// The screen a window's mostly on.
int pv_monitor_of(void *window);
