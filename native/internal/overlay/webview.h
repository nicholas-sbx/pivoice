// webview's own C API (webview_go builds it into the app): the overlay makes
// its webview with it directly, on a window of its own.
#pragma once

typedef void *webview_t;

enum { PV_HANDLE_WINDOW = 0, PV_HANDLE_WIDGET = 1, PV_HANDLE_CONTROLLER = 2 };

extern webview_t webview_create(int debug, void *window);
extern void webview_destroy(webview_t w);
extern void webview_navigate(webview_t w, const char *url);
extern void webview_init(webview_t w, const char *js);
extern void webview_eval(webview_t w, const char *js);
extern void webview_bind(webview_t w, const char *name, void (*fn)(const char *seq, const char *req, void *arg), void *arg);
extern void webview_return(webview_t w, const char *seq, int status, const char *result);
extern void *webview_get_native_handle(webview_t w, int kind);
