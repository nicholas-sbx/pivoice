//go:build windows && !nowebview

// The overlay's window on Windows: a borderless popup that's
//
//  - topmost (above every ordinary window, and borderless full-screen
//    games; a game in exclusive full screen still covers it);
//  - a tool window (not on the taskbar or in Alt+Tab) that's never
//    activated, so it never takes the focus from what you're doing;
//  - layered and transparent to the mouse (WS_EX_LAYERED with
//    WS_EX_TRANSPARENT), so clicks go to whatever's under it;
//  - without a redirection bitmap: it paints nothing of its own, and what
//    WebView2 draws is composed onto the desktop with its own alpha, its
//    background (WEBVIEW2_DEFAULT_BACKGROUND_COLOR, set while it's made) see-through.
//
// The same window styles as other apps that put WebView2 over the desktop.

#include <stdlib.h>
#include <windows.h>
#include <shellscalingapi.h>
#include "overlay_windows.h"

extern void pvOverlayReady(void);
extern void pvOverlayScreens(void);

static const wchar_t *CLASS = L"PivoiceOverlay";

static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_NCHITTEST:
		return HTTRANSPARENT;
	case WM_MOUSEACTIVATE:
		return MA_NOACTIVATE;
	case WM_ERASEBKGND:
		return 1;
	case WM_SIZE: {
		// webview sizes its own part only in a window of its own.
		pv_overlay *o = (pv_overlay *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
		if (o && o->widget) MoveWindow(o->widget, 0, 0, LOWORD(lp), HIWORD(lp), TRUE);
		return 0;
	}
	case WM_DISPLAYCHANGE:
	case WM_DPICHANGED:
		pvOverlayScreens();
		return 0;
	case WM_SETTINGCHANGE:
		// The taskbar moved or changed size: the usable area did too.
		if (wp == SPI_SETWORKAREA) pvOverlayScreens();
		break;
	case WM_CLOSE:
		// Only the app takes it down.
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

static void ready(const char *seq, const char *req, void *arg) {
	(void)req;
	webview_return(((pv_overlay *)arg)->view, seq, 0, "");
	pvOverlayReady();
}

pv_overlay *pv_open(int debug, const char *url, const char *js) {
	HINSTANCE inst = GetModuleHandleW(NULL);
	static int registered;
	if (!registered) {
		WNDCLASSEXW wc = {0};
		wc.cbSize = sizeof wc;
		wc.lpfnWndProc = proc;
		wc.hInstance = inst;
		wc.lpszClassName = CLASS;
		wc.hCursor = LoadCursor(NULL, IDC_ARROW);
		if (!RegisterClassExW(&wc)) return NULL;
		registered = 1;
	}
	DWORD ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOREDIRECTIONBITMAP;
	HWND hwnd = CreateWindowExW(ex, CLASS, L"Pivoice overlay", WS_POPUP, 0, 0, 1, 1, NULL, NULL, inst, NULL);
	if (!hwnd) return NULL;
	// A layered window shows nothing until it's told how opaque it is: all of it (the page decides the rest).
	SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);

	pv_overlay *o = calloc(1, sizeof *o);
	o->hwnd = hwnd;
	SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)o);

	// See-through from the first frame (a background set afterwards flashes white first). Only for this webview: put back after.
	wchar_t before[64];
	DWORD had = GetEnvironmentVariableW(L"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", before, 64);
	SetEnvironmentVariableW(L"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", L"00000000");
	o->view = webview_create(debug, hwnd);
	SetEnvironmentVariableW(L"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", had && had < 64 ? before : NULL);
	if (!o->view) {
		DestroyWindow(hwnd);
		free(o);
		return NULL;
	}
	o->widget = webview_get_native_handle(o->view, PV_HANDLE_WIDGET);
	webview_bind(o->view, "__pivoiceOverlayReady", ready, o);
	webview_init(o->view, js);
	webview_navigate(o->view, url);
	return o;
}

void pv_place(pv_overlay *o, int x, int y, int size) {
	SetWindowPos(o->hwnd, HWND_TOPMOST, x, y, size, size, SWP_NOACTIVATE | SWP_SHOWWINDOW);
	if (o->widget) MoveWindow(o->widget, 0, 0, size, size, TRUE);
}

void pv_eval(pv_overlay *o, const char *js) {
	webview_eval(o->view, js);
}

void pv_close(pv_overlay *o) {
	SetWindowLongPtrW(o->hwnd, GWLP_USERDATA, 0);
	webview_destroy(o->view);
	DestroyWindow(o->hwnd);
	free(o);
}

// ---- screens ----------------------------------------------------------------------

#define MAX_SCREENS 16
static HMONITOR found[MAX_SCREENS];
static int nfound;

static BOOL CALLBACK each(HMONITOR m, HDC dc, LPRECT r, LPARAM lp) {
	(void)dc;
	(void)r;
	(void)lp;
	if (nfound < MAX_SCREENS) found[nfound++] = m;
	return TRUE;
}

int pv_monitor_count(void) {
	nfound = 0;
	EnumDisplayMonitors(NULL, NULL, each, 0);
	return nfound;
}

int pv_monitor_info(int i, char *device, int len, char *name, int nlen, RECT *work, int *dpi, int *primary) {
	device[0] = name[0] = 0;
	if (i < 0 || i >= nfound) return 0;
	MONITORINFOEXW mi = {0};
	mi.cbSize = sizeof mi;
	if (!GetMonitorInfoW(found[i], (MONITORINFO *)&mi)) return 0;
	*work = mi.rcWork;
	*primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
	UINT dx = 96, dy = 96;
	if (GetDpiForMonitor(found[i], MDT_EFFECTIVE_DPI, &dx, &dy) != S_OK) dx = 96;
	*dpi = (int)dx;
	WideCharToMultiByte(CP_UTF8, 0, mi.szDevice, -1, device, len, NULL, NULL);
	// The screen's own name, when Windows has one better than its generic driver's.
	DISPLAY_DEVICEW dd = {0};
	dd.cb = sizeof dd;
	if (EnumDisplayDevicesW(mi.szDevice, 0, &dd, 0)) WideCharToMultiByte(CP_UTF8, 0, dd.DeviceString, -1, name, nlen, NULL, NULL);
	return 1;
}

int pv_monitor_of(void *window) {
	if (!window) return -1;
	HMONITOR m = MonitorFromWindow((HWND)window, MONITOR_DEFAULTTONEAREST);
	for (int i = 0; i < nfound; i++)
		if (found[i] == m) return i;
	return -1;
}
