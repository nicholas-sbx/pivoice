//go:build !windows

package asr

import (
	"io"
	"os"
	"os/exec"
)

func helperProcAttr(*exec.Cmd) {}

func childStderr() io.Writer { return os.Stderr }
