package asr

import (
	"io"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// childStderr: ours if we have one. The release is a GUI program with no
// console, whose standard error is no handle at all, and handing that to
// CreateProcess fails; then the helper's log goes nowhere (os/exec opens NUL).
func childStderr() io.Writer {
	h, err := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	if err != nil || h == 0 || h == windows.InvalidHandle {
		return nil
	}
	return os.Stderr
}

// No console window for the helper.
func helperProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
