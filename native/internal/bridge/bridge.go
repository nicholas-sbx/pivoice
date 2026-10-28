// Package bridge connects the page (the UI) to the engine (the audio).
//
// Two ways in, one set of rules:
//
//   - the app's own window: functions bound into the system webview
//     (webview.Bind / Eval), no network involved at all, so there's no
//     socket for anything else on the machine to find;
//   - a WebSocket on 127.0.0.1, for opening the UI in an ordinary browser
//     (--browser, development, the end-to-end tests).
//
// Either way, nothing gets through until the page says hello with the
// token this run of the app made up (32 random bytes). The app only hands
// the token to pages on the site's own origin: in the window, through a
// script that runs before anything else on each page and checks
// location.origin first; in a browser, in the address's #fragment, which
// never leaves the machine. Every new page starts unauthenticated again.
package bridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log"
	"runtime"
	"sync"
	"sync/atomic"

	"github.com/nicholas-sbx/pivoice/native/internal/engine"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

// Most a message from the page may be (an offer is ~3 KB).
const maxMessage = 64 * 1024

type Bridge struct {
	Token   string
	version string
	engine  *engine.Engine

	mu      sync.Mutex
	current *Conn
}

// Conn is one way in: the window, or one WebSocket.
type Conn struct {
	b      *Bridge
	send   func([]byte)
	close  func()
	authed atomic.Bool

	inMu  sync.Mutex
	in    chan []byte
	ended bool
}

func New(e *engine.Engine, version string) *Bridge {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	return &Bridge{Token: base64.RawURLEncoding.EncodeToString(key), version: version, engine: e}
}

// NewConn: send delivers a message to the page; close (may be nil) hangs up on it.
func (b *Bridge) NewConn(send func([]byte), close func()) *Conn {
	c := &Conn{b: b, send: send, close: close, in: make(chan []byte, 256)}
	go c.run()
	return c
}

// Receive queues a message from the page. Never blocks the caller (in the window, that's the UI thread).
func (c *Conn) Receive(msg []byte) {
	if len(msg) > maxMessage {
		return
	}
	c.inMu.Lock()
	defer c.inMu.Unlock()
	if c.ended {
		return
	}
	select {
	case c.in <- msg:
	default:
		log.Print("bridge: page is sending faster than we can keep up; dropped a message")
	}
}

// Gone: this way in has closed (the socket went, or the window's page is navigating away).
func (c *Conn) Gone() {
	c.Receive([]byte(`{"t":"gone"}`))
}

// End: this way in is gone for good (a closed socket). Anything already queued still runs.
func (c *Conn) End() {
	c.Gone()
	c.inMu.Lock()
	c.ended = true
	close(c.in)
	c.inMu.Unlock()
}

func (c *Conn) run() {
	for raw := range c.in {
		var m proto.In
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		c.handle(m)
	}
}

func (c *Conn) handle(m proto.In) {
	b := c.b
	switch {
	case m.T == "gone":
		// A new page in the window, or the socket's closed: whatever it was doing stops.
		b.mu.Lock()
		wasCurrent := b.current == c
		if wasCurrent {
			b.current = nil
		}
		b.mu.Unlock()
		c.authed.Store(false)
		if wasCurrent {
			b.engine.SetEmitter(nil)
			b.engine.Reset()
		}
	case m.T == "hello":
		if subtle.ConstantTimeCompare([]byte(m.Token), []byte(b.Token)) != 1 {
			log.Print("bridge: a page said hello with the wrong token; ignoring it")
			if c.close != nil {
				c.close()
			}
			return
		}
		b.mu.Lock()
		old := b.current
		b.current = c
		b.mu.Unlock()
		if old != nil && old != c && old.close != nil {
			old.close()
		}
		c.authed.Store(true)
		// A fresh page: nothing from before carries over.
		b.engine.SetEmitter(nil)
		b.engine.Reset()
		c.emit(proto.Hello{T: "hello", Version: b.version, Protocol: proto.Protocol, OS: runtime.GOOS, Arch: runtime.GOARCH})
		if m.Protocol == proto.Protocol {
			b.engine.SetEmitter(c.emit)
		}
	case !c.authed.Load():
		// Not a word until hello.
	default:
		b.mu.Lock()
		current := b.current == c
		b.mu.Unlock()
		if current {
			b.engine.Handle(m)
		}
	}
}

func (c *Conn) emit(msg any) {
	buf, err := json.Marshal(msg)
	if err != nil {
		log.Printf("bridge: %v", err)
		return
	}
	c.send(buf)
}
