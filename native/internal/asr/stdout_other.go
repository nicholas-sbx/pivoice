//go:build !windows

package asr

import (
	"os"

	"golang.org/x/sys/unix"
)

// protocolOut keeps the real stdout for the protocol and points fd 1 at
// stderr, so a library printing to stdout can't corrupt a frame.
func protocolOut() (*os.File, error) {
	fd, err := unix.Dup(1)
	if err != nil {
		return nil, err
	}
	if err := unix.Dup2(2, 1); err != nil {
		return nil, err
	}
	harden()
	return os.NewFile(uintptr(fd), "captions-protocol"), nil
}
