package asr

import (
	"os"

	"golang.org/x/sys/unix"
)

// harden: if memory runs out, the kernel ends the helper before the app
// (and the call); and the helper goes when the app does, however it goes.
func harden() {
	_ = os.WriteFile("/proc/self/oom_score_adj", []byte("500"), 0)
	_ = unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGKILL), 0, 0, 0)
}
