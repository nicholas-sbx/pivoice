package asr

import (
	"os"

	"golang.org/x/sys/windows"
)

// protocolOut keeps the real stdout for the protocol and makes the
// process's standard output stderr from here on, so libraries loaded later
// (their C runtimes pick up the handles then) print there, not into a frame.
func protocolOut() (*os.File, error) {
	out := os.Stdout
	errh, err := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	if err == nil {
		_ = windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, errh)
	}
	return out, nil
}
