//go:build linux && !nowebview

package webkit

import (
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	"github.com/nicholas-sbx/pivoice/native/internal/wvhandle"
	webview "github.com/webview/webview_go"
)

// GTK runs on the thread that started it, which webview_go keeps the main
// goroutine on: the window is made and run here, and the tests drive it
// from their own goroutine through Dispatch.
var (
	win       webview.WebView
	reports   = make(chan string, 16)
	starts    atomic.Int32
	downloads string
)

func TestMain(m *testing.M) {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		fmt.Println("webkit: no display, skipping (CI runs this under xvfb-run)")
		os.Exit(0)
	}
	// Containers and CI runners often can't make the user namespaces
	// WebKit's sandbox needs; these tests are about our policy, not it.
	os.Setenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")
	os.Setenv("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
	// Where an unrefused download would land (WebKit saves to the Downloads
	// folder, or the home folder without one): somewhere we can look.
	home, err := os.MkdirTemp("", "pivoice-webkit-")
	if err != nil {
		panic(err)
	}
	downloads = home
	os.Setenv("HOME", home)
	os.Setenv("XDG_DOWNLOAD_DIR", home)
	win = webview.New(false)
	if win == nil {
		fmt.Println("webkit: couldn't make a webview")
		os.Exit(1)
	}
	if err := win.Bind("report", func(s string) { reports <- s }); err != nil {
		panic(err)
	}
	code := make(chan int, 1)
	go func() {
		code <- m.Run()
		win.Dispatch(win.Terminate)
	}()
	win.Run()
	c := <-code
	os.RemoveAll(home)
	os.Exit(c)
}

func onUI(f func()) {
	done := make(chan struct{})
	win.Dispatch(func() { f(); close(done) })
	<-done
}

func eval(js string) { onUI(func() { win.Eval(js) }) }

// next waits for the page to report something starting with prefix.
func next(t *testing.T, prefix string) string {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case r := <-reports:
			if strings.HasPrefix(r, prefix) {
				return strings.TrimPrefix(r, prefix)
			}
		case <-timeout:
			t.Fatalf("no %q from the page", prefix)
		}
	}
}

const page = `<!doctype html><title>site</title><script>report('loaded:' + location.href)</script>`

// wvhandle reaches webview's C handles through webview_go; this is where a
// window exists to check it against (the overlay and Windows rely on it).
func TestNativeHandle(t *testing.T) {
	var got, want, view unsafe.Pointer
	onUI(func() {
		got, want = wvhandle.Native(win, wvhandle.Window), win.Window()
		view = wvhandle.Native(win, wvhandle.Widget)
	})
	if got == nil || got != want {
		t.Fatalf("Native(Window) = %p, want %p", got, want)
	}
	if view == nil || view != ViewOf(want) {
		t.Fatalf("Native(Widget) = %p, want the WebKitWebView %p", view, ViewOf(want))
	}
}

func TestLock(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/file" {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", `attachment; filename="file.bin"`)
			fmt.Fprint(w, "not for you")
			return
		}
		fmt.Fprint(w, page)
	}))
	defer site.Close()
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere.Add(1)
		fmt.Fprint(w, page)
	}))
	defer other.Close()

	// Before the lock, webview lets the page read the clipboard.
	onUI(func() { win.Navigate(site.URL + "/before") })
	next(t, "loaded:")
	eval(`report('paste:' + document.execCommand('paste'))`)
	if got := next(t, "paste:"); got != "true" {
		t.Fatalf("before the lock, execCommand('paste') = %s; the test can't tell the lock worked", got)
	}

	var locked bool
	onUI(func() {
		locked = Lock(ViewOf(win.Window()), nav.Policy{Origin: site.URL, PageStart: func() { starts.Add(1) }})
	})
	if !locked {
		t.Fatal("Lock: couldn't find the webview")
	}

	onUI(func() { win.Navigate(site.URL + "/") })
	if got := next(t, "loaded:"); got != site.URL+"/" {
		t.Fatalf("loaded %s", got)
	}
	if starts.Load() == 0 {
		t.Error("PageStart wasn't called as the page loaded")
	}

	t.Run("no clipboard", func(t *testing.T) {
		eval(`report('paste:' + document.execCommand('paste'))`)
		if got := next(t, "paste:"); got != "false" {
			t.Errorf("execCommand('paste') = %s, want false", got)
		}
	})

	t.Run("fragment isn't a new page", func(t *testing.T) {
		before := starts.Load()
		eval(`location.hash = 'ROOM42'; report('hash:' + location.hash)`)
		next(t, "hash:")
		time.Sleep(300 * time.Millisecond)
		if n := starts.Load(); n != before {
			t.Errorf("PageStart called %d times for a #fragment change", n-before)
		}
	})

	t.Run("reload is a new page", func(t *testing.T) {
		before := starts.Load()
		eval(`location.reload()`)
		next(t, "loaded:")
		if starts.Load() == before {
			t.Error("PageStart wasn't called on reload")
		}
	})

	t.Run("stays on the site", func(t *testing.T) {
		eval(`location.href = '` + other.URL + `/'`)
		eval(`window.open('` + other.URL + `/popup')`)
		eval(`var f = document.createElement('iframe'); f.src = '` + other.URL + `/frame'; document.body.appendChild(f)`)
		time.Sleep(time.Second)
		if n := elsewhere.Load(); n != 0 {
			t.Errorf("the other origin was asked for %d pages", n)
		}
		eval(`report('at:' + location.href)`)
		if got := next(t, "at:"); !strings.HasPrefix(got, site.URL+"/") {
			t.Errorf("the window went to %s", got)
		}
	})

	t.Run("no downloads", func(t *testing.T) {
		eval(`location.href = '/file'`)
		eval(`var a = document.createElement('a'); a.href = '/file'; a.download = 'x.bin'; document.body.appendChild(a); a.click()`)
		time.Sleep(time.Second)
		var saved []string
		filepath.WalkDir(downloads, func(path string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() && (strings.HasSuffix(path, ".bin") || strings.Contains(path, "file")) {
				saved = append(saved, path)
			}
			return nil
		})
		if len(saved) > 0 {
			t.Errorf("downloaded %v", saved)
		}
		eval(`report('at:' + location.href)`)
		if got := next(t, "at:"); !strings.HasPrefix(got, site.URL+"/") || strings.HasSuffix(got, "/file") {
			t.Errorf("the window is at %s", got)
		}
	})

	t.Run("no permissions", func(t *testing.T) {
		eval(`navigator.geolocation.getCurrentPosition(function () { report('geo:allowed') }, function (e) { report('geo:' + e.code) })`)
		if got := next(t, "geo:"); got != "1" {
			t.Errorf("geolocation: %s, want 1 (PERMISSION_DENIED)", got)
		}
	})
}
