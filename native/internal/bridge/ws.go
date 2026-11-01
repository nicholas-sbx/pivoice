package bridge

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Serve listens on 127.0.0.1 (a port the system picks) for the page's
// WebSocket, from the site's origin only, and returns the port.
func (b *Bridge) Serve(siteOrigin string) (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	u, err := url.Parse(siteOrigin)
	if err != nil || u.Host == "" {
		return 0, fmt.Errorf("bad site origin %q", siteOrigin)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/start/", b.start)
	mux.HandleFunc("/bridge", func(w http.ResponseWriter, r *http.Request) {
		// Browsers always send Origin on a WebSocket; it has to be the site's own.
		if !strings.EqualFold(r.Header.Get("Origin"), u.Scheme+"://"+u.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{u.Host}})
		if err != nil {
			return
		}
		ws.SetReadLimit(maxMessage)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		out := make(chan []byte, 512)
		c := b.NewConn(func(msg []byte) {
			select {
			case out <- msg:
			default:
				// A page that isn't reading: drop rather than hold the engine up.
			}
		}, cancel)
		defer c.End()
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case msg := <-out:
					wctx, done := context.WithTimeout(ctx, 5*time.Second)
					err := ws.Write(wctx, websocket.MessageText, msg)
					done()
					if err != nil {
						cancel()
						return
					}
				}
			}
		}()
		// Say hello in time or go.
		hello := time.AfterFunc(10*time.Second, func() {
			if !c.authed.Load() {
				cancel()
			}
		})
		defer hello.Stop()
		for {
			typ, msg, err := ws.Read(ctx)
			if err != nil {
				_ = ws.CloseNow()
				return
			}
			if typ == websocket.MessageText {
				c.Receive(msg)
			}
		}
	})
	b.port = ln.Addr().(*net.TCPAddr).Port
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil {
			log.Printf("bridge: %v", err)
		}
	}()
	return b.port, nil
}

// How long a StartURL works for.
const startFor = time.Minute

type startLink struct {
	page    string
	expires time.Time
}

// StartURL is an address on the bridge's port (Serve first) that sends a
// browser on to page, once, within a minute. page carries the token in its
// #fragment; this way the token itself is never on the command line that
// opens the browser, where anyone else on the machine could read it.
func (b *Bridge) StartURL(page string) string {
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	nonce := base64.RawURLEncoding.EncodeToString(key)
	b.startMu.Lock()
	if b.starts == nil {
		b.starts = map[string]startLink{}
	}
	b.starts[nonce] = startLink{page: page, expires: time.Now().Add(startFor)}
	b.startMu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d/start/%s", b.port, nonce)
}

func (b *Bridge) start(w http.ResponseWriter, r *http.Request) {
	nonce := strings.TrimPrefix(r.URL.Path, "/start/")
	b.startMu.Lock()
	s, ok := b.starts[nonce]
	delete(b.starts, nonce)
	b.startMu.Unlock()
	if !ok || time.Now().After(s.expires) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, s.page, http.StatusSeeOther)
}
