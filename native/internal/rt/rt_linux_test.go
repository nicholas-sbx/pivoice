//go:build linux

package rt

import (
	"os"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// Promotes a thread of its own, then checks the kernel has it realtime.
// Where neither this process nor rtkit may (CI's runners, most
// containers), it's skipped; PIVOICE_RT_TEST=1 makes that a failure.
func TestPromote(t *testing.T) {
	type result struct {
		how    string
		err    error
		policy uint32
		prio   uint32
	}
	done := make(chan result)
	go func() {
		// Never unlocked: the thread goes when this goroutine ends, realtime or not.
		runtime.LockOSThread()
		var r result
		r.how, r.err = Promote(Tid())
		if a, err := unix.SchedGetAttr(0, 0); err == nil {
			r.policy, r.prio = a.Policy, a.Priority
		}
		done <- r
	}()
	r := <-done
	if r.err != nil {
		if os.Getenv("PIVOICE_RT_TEST") != "" {
			t.Fatal(r.err)
		}
		t.Skipf("not allowed here: %v", r.err)
	}
	t.Logf("%s: policy %d, priority %d", r.how, r.policy, r.prio)
	if r.policy != unix.SCHED_FIFO && r.policy != unix.SCHED_RR {
		t.Fatalf("%q, but the thread's policy is %d", r.how, r.policy)
	}
	if r.prio < 1 || r.prio > Priority {
		t.Fatalf("priority %d", r.prio)
	}
	if !strings.Contains(r.how, "SCHED_") {
		t.Fatalf("says %q", r.how)
	}
	var lim unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_RTTIME, &lim); err != nil || lim.Max > 200_000 {
		t.Fatalf("RLIMIT_RTTIME %+v (%v): a spinning realtime thread could freeze the machine", lim, err)
	}
}
