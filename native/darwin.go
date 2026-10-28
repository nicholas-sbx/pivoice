//go:build darwin

package main

// macOS asks before an app may use the microphone, and needs the reason
// from the app's Info.plist. A bare binary has no bundle, so the plist is
// linked into the binary itself, where macOS looks for it.

/*
#cgo LDFLAGS: -Wl,-sectcreate,__TEXT,__info_plist,${SRCDIR}/build/Info.plist
*/
import "C"
