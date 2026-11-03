package asr

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// No console window for the helper.
func helperProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
