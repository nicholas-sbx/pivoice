// Pivoice, the app: the site in your system's own webview, with the audio
// done here instead of in the page. One duplex callback on the sound card
// (microphone and speakers in the same block, the smallest the device
// does), WebRTC from Go, and the low-latency engine's pipeline around
// them. The page is the UI; see internal/bridge for how the two talk.
package main

import (
	_ "embed"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"runtime"
	"strings"

	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/bridge"
	"github.com/nicholas-sbx/pivoice/native/internal/engine"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

//go:embed VERSION
var versionFile string

// The site the app opens, set at build time (-ldflags "-X main.siteURL=...").
var siteURL = ""

var roomCode = regexp.MustCompile(`^[A-Z0-9]{6}$`)

func main() {
	version := strings.TrimSpace(versionFile)
	site := flag.String("url", siteURL, "the Pivoice site to open")
	browser := flag.Bool("browser", false, "open the UI in your web browser instead of the app's own window")
	headless := flag.Bool("headless", false, "open nothing: print the address to open the UI at (for tests)")
	fake := flag.Bool("fake-audio", false, "no sound card: a beeping microphone and silent speakers (for tests)")
	loopback := flag.Bool("loopback-ice", false, "offer loopback network candidates too (for tests on one machine)")
	devtools := flag.Bool("devtools", false, "let the window's web inspector open")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: pivoice [flags] [invite link or room code]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVersion {
		fmt.Printf("pivoice %s (bridge protocol %d, %s/%s)\n", version, proto.Protocol, runtime.GOOS, runtime.GOARCH)
		return
	}
	if *site == "" {
		log.Fatal("this build doesn't know which site to open: pass --url")
	}
	u, err := url.Parse(*site)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		log.Fatalf("bad --url %q", *site)
	}
	origin := u.Scheme + "://" + u.Host
	code := invite(flag.Arg(0))

	var backend audio.Backend
	if *fake {
		backend = audio.Fake{}
	} else {
		pa, err := audio.NewPortAudio()
		if err != nil {
			log.Fatalf("audio: %v", err)
		}
		backend = pa
	}
	defer backend.Close()
	e := engine.New(engine.Options{Backend: backend, Loopback: *loopback})
	b := bridge.New(e, version)

	if *browser || *headless {
		port, err := b.Serve(origin)
		if err != nil {
			log.Fatal(err)
		}
		// The bridge's address and key ride in the #fragment, which never leaves the machine.
		page := *u
		page.Fragment = joinHash(code, fmt.Sprintf("native=%d.%s", port, b.Token))
		if *headless {
			fmt.Println(page.String())
		} else if err := openBrowser(page.String()); err != nil {
			fmt.Println("Open this in your browser:", page.String())
		}
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, os.Interrupt)
		<-stop
		e.Reset()
		return
	}
	page := *u
	page.Fragment = code
	if err := runWindow(b, page.String(), origin, *devtools); err != nil {
		log.Fatal(err)
	}
	e.Reset()
}

// invite takes a room code from an invite link (…/#CODE) or a bare code.
func invite(arg string) string {
	if arg == "" {
		return ""
	}
	if i := strings.LastIndexByte(arg, '#'); i >= 0 {
		arg = arg[i+1:]
	}
	arg = strings.ToUpper(strings.TrimSpace(arg))
	if roomCode.MatchString(arg) {
		return arg
	}
	return ""
}

func joinHash(parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "&")
}

func openBrowser(u string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", u).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	default:
		return exec.Command("xdg-open", u).Start()
	}
}
