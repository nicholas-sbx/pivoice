package bridge

import (
	"context"
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
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil {
			log.Printf("bridge: %v", err)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, nil
}
