//go:build linux

package rt

import (
	"errors"
	"fmt"
	"os"

	"github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
)

// Supported says whether Promote does anything here.
const Supported = true

// Promote makes thread tid (of this process) realtime, the way PipeWire's
// own clients do it: straight away if this process may (realtime limits,
// as members of an audio group often have, or root), and otherwise by
// asking rtkit, the system service that hands it out to desktop users,
// or, where that can't be reached (a Flatpak's sandbox has no system bus),
// the Realtime portal, which asks rtkit for it. It says how it went, for the settings to show. Never from the audio
// thread: rtkit is a D-Bus call.
//
// Either way it first caps how long a realtime thread here may run
// without sleeping (RLIMIT_RTTIME, which rtkit insists on): ours sleeps
// every block, so it never gets near it, and if it ever spun, the kernel
// would stop it rather than let it freeze the machine.
func Promote(tid int) (string, error) {
	var direct error
	if err := capRTTime(200_000); err != nil {
		direct = err
	} else if err := fifo(tid, min(Priority, rtprioLimit())); err == nil {
		return fmt.Sprintf("SCHED_FIFO %d", min(Priority, rtprioLimit())), nil
	} else {
		direct = err
	}
	how, err := viaRtkit(tid)
	if err == nil {
		return how, nil
	}
	how, perr := viaPortal(tid)
	if perr != nil {
		return "", fmt.Errorf("not allowed (%v), rtkit: %v, and the portal: %w", direct, err, perr)
	}
	return how, nil
}

// rtprioLimit is the highest realtime priority this process may set
// itself; with none (0), Priority anyway, in case it's root.
func rtprioLimit() int {
	var r unix.Rlimit
	if unix.Getrlimit(unix.RLIMIT_RTPRIO, &r) != nil || r.Cur == 0 {
		return Priority
	}
	return int(min(r.Cur, 99))
}

func fifo(tid, prio int) error {
	if prio < 1 {
		return errors.New("no realtime priority allowed")
	}
	return unix.SchedSetAttr(tid, &unix.SchedAttr{
		Size:     unix.SizeofSchedAttr,
		Policy:   unix.SCHED_FIFO,
		Flags:    unix.SCHED_FLAG_RESET_ON_FORK,
		Priority: uint32(prio),
	}, 0)
}

// capRTTime brings RLIMIT_RTTIME down to at most usec (never up: it may
// be lower already, PipeWire's client library sets it too).
func capRTTime(usec uint64) error {
	var r unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_RTTIME, &r); err != nil {
		return err
	}
	if r.Max <= usec && r.Cur <= r.Max {
		return nil
	}
	r.Max = min(r.Max, usec)
	r.Cur = min(r.Cur, r.Max)
	return unix.Setrlimit(unix.RLIMIT_RTTIME, &r)
}

const (
	rtkitName  = "org.freedesktop.RealtimeKit1"
	rtkitPath  = "/org/freedesktop/RealtimeKit1"
	rtkitIface = "org.freedesktop.RealtimeKit1"
)

// The portal has rtkit's methods and properties, on the session bus, and
// turns the sandbox's process and thread IDs into the host's before it asks
// rtkit. Outside a sandbox it isn't needed, since rtkit answers first.
const (
	portalName  = "org.freedesktop.portal.Desktop"
	portalPath  = "/org/freedesktop/portal/desktop"
	portalIface = "org.freedesktop.portal.Realtime"
)

func viaRtkit(tid int) (string, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	return askRealtime(conn.Object(rtkitName, rtkitPath), rtkitIface, "rtkit", tid)
}

func viaPortal(tid int) (string, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	return askRealtime(conn.Object(portalName, portalPath), portalIface, "portal", tid)
}

// askRealtime asks rtkit, or the portal, which speak the same interface, to
// make thread tid realtime.
func askRealtime(obj dbus.BusObject, iface, via string, tid int) (string, error) {
	maxPrio, err := property[int32](obj, iface, "MaxRealtimePriority")
	if err != nil {
		return "", err
	}
	maxRTTime, err := property[int64](obj, iface, "RTTimeUSecMax")
	if err != nil {
		return "", err
	}
	// rtkit refuses a process that would let a realtime thread run longer than this.
	if maxRTTime > 0 {
		if err := capRTTime(uint64(maxRTTime)); err != nil {
			return "", err
		}
	}
	prio := min(Priority, int(maxPrio))
	if prio < 1 {
		return "", errors.New("it allows no realtime priority")
	}
	call := obj.Call(iface+".MakeThreadRealtimeWithPID", 0, uint64(os.Getpid()), uint64(tid), uint32(prio))
	if call.Err != nil {
		return "", call.Err
	}
	return fmt.Sprintf("%s, SCHED_RR %d", via, prio), nil
}

// property reads one of rtkit's (or the portal's) properties, which come as
// int32 or int64.
func property[T int32 | int64](obj dbus.BusObject, iface, name string) (T, error) {
	v, err := obj.GetProperty(iface + "." + name)
	if err != nil {
		return 0, err
	}
	switch x := v.Value().(type) {
	case int32:
		return T(x), nil
	case int64:
		return T(x), nil
	}
	return 0, fmt.Errorf("%s is a %s", name, v.Signature())
}

// Tid is the calling thread's id. Allocates nothing: fine on the audio thread.
func Tid() int { return unix.Gettid() }
