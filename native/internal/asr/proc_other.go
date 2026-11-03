//go:build !windows

package asr

import "os/exec"

func helperProcAttr(*exec.Cmd) {}
