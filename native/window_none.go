//go:build nowebview

package main

import (
	"errors"

	"github.com/nicholas-sbx/pivoice/native/internal/bridge"
)

// Built without a window (-tags nowebview: no webview library needed, for CI and servers).
func runWindow(*bridge.Bridge, string, string, bool) error {
	return errors.New("this build has no window: run it with --browser or --headless")
}
