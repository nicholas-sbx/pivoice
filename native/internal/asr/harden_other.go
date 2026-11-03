//go:build !linux && !windows

package asr

// harden: nothing more to ask for here (the helper still ends when its stdin closes).
func harden() {}
