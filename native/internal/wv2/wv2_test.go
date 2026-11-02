//go:build windows && !nowebview

package wv2

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/nav"
	"github.com/nicholas-sbx/pivoice/native/internal/wvhandle"
	webview "github.com/webview/webview_go"
	"golang.org/x/sys/windows"
)

// The window is made and run on the main goroutine (webview_go keeps it on
// the main thread); the tests drive it from theirs through Dispatch.
var (
	win     webview.WebView
	reports = make(chan string, 16)
	starts  atomic.Int32
)

func TestMain(m *testing.M) {
	// As the app does (dll_windows.go): WebView2 must still start with DLLs from System32 only.
	if err := windows.SetDefaultDllDirectories(windows.LOAD_LIBRARY_SEARCH_SYSTEM32); err != nil {
		panic(err)
	}
	win = webview.New(false)
	if win == nil {
		fmt.Println("wv2: couldn't make a webview (is the WebView2 runtime installed?)")
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
	os.Exit(<-code)
}

func onUI(f func()) {
	done := make(chan struct{})
	win.Dispatch(func() { f(); close(done) })
	<-done
}

func eval(js string) { onUI(func() { win.Eval(js) }) }

func next(t *testing.T, prefix string) string {
	t.Helper()
	timeout := time.After(20 * time.Second)
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

func TestNativeHandle(t *testing.T) {
	var got, want, controller unsafe.Pointer
	onUI(func() {
		got, want = wvhandle.Native(win, wvhandle.Window), win.Window()
		controller = wvhandle.Native(win, wvhandle.Controller)
	})
	if got == nil || got != want {
		t.Fatalf("Native(Window) = %p, want %p", got, want)
	}
	if controller == nil {
		t.Fatal("no WebView2 controller")
	}
}

func TestLock(t *testing.T) {
	name := make([]byte, 8)
	rand.Read(name)
	file := "pivoice-test-" + hex.EncodeToString(name) + ".bin"
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/file" {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", `attachment; filename="`+file+`"`)
			fmt.Fprint(w, "not for you")
			return
		}
		fmt.Fprint(w, page)
	}))
	defer site.Close()
	var (
		mu   sync.Mutex
		hits []string
	)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, r.URL.Path+" (Sec-Fetch-Dest "+r.Header.Get("Sec-Fetch-Dest")+", Sec-Purpose "+r.Header.Get("Sec-Purpose")+")")
		mu.Unlock()
		fmt.Fprint(w, page)
	}))
	defer other.Close()

	var err error
	onUI(func() {
		err = Lock(wvhandle.Native(win, wvhandle.Controller), nav.Policy{Origin: site.URL, PageStart: func() { starts.Add(1) }})
	})
	if err != nil {
		t.Fatalf("Lock: %v", err)
	}

	onUI(func() { win.SetHtml(`<!doctype html><script>report('html:ok')</script>`) })
	next(t, "html:")

	onUI(func() { win.Navigate(site.URL + "/") })
	if got := next(t, "loaded:"); got != site.URL+"/" {
		t.Fatalf("loaded %s", got)
	}
	if starts.Load() == 0 {
		t.Error("PageStart wasn't called as the page loaded")
	}

	t.Run("fragment isn't a new page", func(t *testing.T) {
		before := starts.Load()
		eval(`location.hash = 'ROOM42'; report('hash:' + location.hash)`)
		next(t, "hash:")
		time.Sleep(500 * time.Millisecond)
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

	// What the other origin was asked for, since the last look.
	asked := func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := hits
		hits = nil
		return out
	}

	t.Run("stays on the site", func(t *testing.T) {
		eval(`location.href = '` + other.URL + `/away?data=secret'`)
		time.Sleep(2 * time.Second)
		if got := asked(); len(got) > 0 {
			t.Errorf("going there asked the other origin for %v", got)
		}
		eval(`var f = document.createElement('iframe'); f.src = '` + other.URL + `/frame'; document.body.appendChild(f)`)
		time.Sleep(2 * time.Second)
		if got := asked(); len(got) > 0 {
			t.Errorf("a frame asked the other origin for %v", got)
		}
		eval(`report('at:' + location.href)`)
		if got := next(t, "at:"); !strings.HasPrefix(got, site.URL+"/") {
			t.Errorf("the window went to %s", got)
		}
	})

	t.Run("no new windows", func(t *testing.T) {
		eval(`report('popup:' + window.open('` + other.URL + `/popup'))`)
		if got := next(t, "popup:"); got != "null" {
			t.Errorf("window.open gave %s", got)
		}
		time.Sleep(2 * time.Second)
		if got := asked(); len(got) > 0 {
			t.Errorf("a new window asked the other origin for %v", got)
		}
	})

	t.Run("no downloads", func(t *testing.T) {
		eval(`var a = document.createElement('a'); a.href = '/file'; a.download = ''; document.body.appendChild(a); a.click()`)
		eval(`location.href = '/file'`)
		time.Sleep(3 * time.Second)
		home, _ := os.UserHomeDir()
		if _, err := os.Stat(filepath.Join(home, "Downloads", file)); err == nil {
			t.Errorf("%s was downloaded", file)
		}
	})

	t.Run("no permissions", func(t *testing.T) {
		eval(`navigator.geolocation.getCurrentPosition(function () { report('geo:allowed') }, function (e) { report('geo:' + e.code) })`)
		if got := next(t, "geo:"); got != "1" {
			t.Errorf("geolocation: %s, want 1 (PERMISSION_DENIED)", got)
		}
		eval(`navigator.clipboard.readText().then(function () { report('clip:read') }, function (e) { report('clip:' + e.name) })`)
		if got := next(t, "clip:"); got == "read" {
			t.Error("the page read the clipboard")
		}
	})
}
