package engine

import (
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

func TestHideRelated(t *testing.T) {
	for in, want := range map[string]string{
		"candidate:1 1 udp 1694498815 203.0.113.7 54321 typ srflx raddr 192.168.1.20 rport 54321":       "candidate:1 1 udp 1694498815 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0",
		"candidate:2 1 udp 16777215 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 9 generation 0": "candidate:2 1 udp 16777215 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0",
		"candidate:3 1 udp 2130706431 4b1e.local 5000 typ host":                                         "candidate:3 1 udp 2130706431 4b1e.local 5000 typ host",
	} {
		if got := hideRelated(in); got != want {
			t.Errorf("hideRelated(%q)\n = %q\nwant %q", in, got, want)
		}
	}
}

func TestReachableInterface(t *testing.T) {
	for name, want := range map[string]bool{"eth0": true, "wlan0": true, "en0": true, "wg0": true, "tun0": true, "docker0": false, "br-1a2b": false, "veth9f": false, "virbr0": false, "vboxnet0": false} {
		if got := reachableInterface(name); got != want {
			t.Errorf("%s: %v, want %v", name, got, want)
		}
	}
}

// What a link offers the room names none of this machine's addresses.
func TestCandidatesHideOurAddresses(t *testing.T) {
	e := New(Options{Backend: audio.Fake{}})
	var mu sync.Mutex
	var cands []string
	e.SetEmitter(func(m any) {
		if s, ok := m.(proto.SignalOut); ok {
			if body, ok := s.Signal.(map[string]any); ok {
				if ice, ok := body["ice"].(map[string]any); ok {
					mu.Lock()
					cands = append(cands, ice["candidate"].(string))
					mu.Unlock()
				}
			}
		}
	})
	defer e.Reset()
	e.Handle(proto.In{T: "link", Op: "open", Link: "l1", Peer: "p1", Offerer: true})
	time.Sleep(2 * time.Second)

	var ours []string
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() {
				ours = append(ours, ipn.IP.String())
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	// With no STUN server here, only host candidates come: none at all if
	// this machine can't do mDNS (they'd have shown its addresses).
	for _, c := range cands {
		f := strings.Fields(c)
		if len(f) < 8 {
			t.Fatalf("odd candidate %q", c)
		}
		if f[7] == "host" && !strings.HasSuffix(f[4], ".local") {
			t.Errorf("a host candidate with a real address: %q", c)
		}
		for _, ip := range ours {
			for _, w := range f {
				if w == ip {
					t.Errorf("our address %s is in %q", ip, c)
				}
			}
		}
	}
	t.Logf("%d candidates: %q", len(cands), cands)
}

// As the app runs for real (no loopback): each end offers only a random
// name.local for its own addresses, and the other finds it by mDNS.
func TestLinkOverMDNS(t *testing.T) {
	probe := New(Options{Backend: audio.Fake{}})
	got := make(chan bool, 1)
	probe.SetEmitter(func(m any) {
		if _, ok := m.(proto.SignalOut); ok {
			select {
			case got <- true:
			default:
			}
		}
	})
	probe.Handle(proto.In{T: "link", Op: "open", Link: "probe", Peer: "x", Offerer: true})
	select {
	case <-got:
	case <-time.After(3 * time.Second):
		probe.Reset()
		t.Skip("this machine can't do mDNS (or has no network but loopback), so no host candidates")
	}
	probe.Reset()
	a, b := callWith(t, false)
	waitFor(t, "the channel to open", func() bool { return a.has("L", "up") && b.has("L", "up") })
	waitFor(t, "b to hear a", func() bool { return b.loudest("a") > 0.05 })
}
