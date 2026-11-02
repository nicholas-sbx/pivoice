package main

import (
	"encoding/json"
	"html"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// How long the launcher is left for the browser to read.
const launcherFor = time.Minute

// launcher writes a page that sends a browser on to page (which carries the
// bridge's token in its #fragment), in a folder only this user can read,
// and returns its file:// address and a function that removes it (it goes
// by itself after a minute anyway). That address is what goes on the
// command line that opens the browser, which anyone else on the machine can
// read: the token never does, and nor does anything they could fetch it
// with.
func launcher(page string) (string, func(), error) {
	dir, err := os.MkdirTemp(os.Getenv("XDG_RUNTIME_DIR"), "pivoice-") // 0700
	if err != nil {
		return "", nil, err
	}
	var once sync.Once
	done := func() { once.Do(func() { os.RemoveAll(dir) }) }
	target, _ := json.Marshal(page) // escapes <, > and &: safe in a script
	body := `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
		`<meta http-equiv="refresh" content="0;url=` + html.EscapeString(page) + `">` +
		`<title>Pivoice</title><script>location.replace(` + string(target) + `)</script>`
	file := filepath.Join(dir, "pivoice.html")
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		done()
		return "", nil, err
	}
	time.AfterFunc(launcherFor, done)
	p := filepath.ToSlash(file)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/… on Windows
	}
	return (&url.URL{Scheme: "file", Path: p}).String(), done, nil
}
