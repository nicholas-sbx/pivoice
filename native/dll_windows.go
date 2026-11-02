package main

import "golang.org/x/sys/windows"

// DLLs load from System32 only, never the folder the app sits in: it's a
// single exe people run from Downloads, where a planted WebView2Loader.dll
// (which webview tries by name before its own built-in loader) would
// otherwise run as them.
func init() {
	if err := windows.SetDefaultDllDirectories(windows.LOAD_LIBRARY_SEARCH_SYSTEM32); err != nil {
		panic(err)
	}
}
