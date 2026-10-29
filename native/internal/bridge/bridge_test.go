package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/nicholas-sbx/pivoice/native/internal/audio"
	"github.com/nicholas-sbx/pivoice/native/internal/engine"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

const site = "https://pivoice.example"

func serve(t *testing.T) (*Bridge, string) {
	b := New(engine.New(engine.Options{Backend: audio.Fake{}}), "1.2.3")
	port, err := b.Serve(site)
	if err != nil {
		t.Fatal(err)
	}
	return b, fmt.Sprintf("ws://127.0.0.1:%d/bridge", port)
}

func dial(t *testing.T, url, origin string) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
}

func send(t *testing.T, c *websocket.Conn, v any) {
	buf, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, buf); err != nil {
		t.Fatal(err)
	}
}

func read(c *websocket.Conn) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, buf, err := c.Read(ctx)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	return m, json.Unmarshal(buf, &m)
}

func TestOtherSitesCantConnect(t *testing.T) {
	_, url := serve(t)
	for _, origin := range []string{"https://evil.example", "http://pivoice.example", "null", ""} {
		_, res, err := dial(t, url, origin)
		if err == nil {
			t.Fatalf("origin %q got in", origin)
		}
		if res != nil && res.StatusCode != http.StatusForbidden {
			t.Fatalf("origin %q: status %d", origin, res.StatusCode)
		}
	}
}

func TestWrongTokenGetsNothing(t *testing.T) {
	_, url := serve(t)
	c, _, err := dial(t, url, site)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send(t, c, proto.In{T: "hello", Token: "guess", Protocol: proto.Protocol})
	send(t, c, proto.In{T: "devices"})
	if m, err := read(c); err == nil {
		t.Fatalf("answered a page with the wrong token: %v", m)
	}
}

func TestNothingBeforeHello(t *testing.T) {
	_, url := serve(t)
	c, _, err := dial(t, url, site)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send(t, c, proto.In{T: "devices"})
	if m, err := read(c); err == nil {
		t.Fatalf("answered before hello: %v", m)
	}
}

func TestHello(t *testing.T) {
	b, url := serve(t)
	c, _, err := dial(t, url, site)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send(t, c, proto.In{T: "hello", Token: b.Token, Protocol: proto.Protocol, Site: "0.6.0"})
	m, err := read(c)
	if err != nil {
		t.Fatal(err)
	}
	if m["t"] != "hello" || m["version"] != "1.2.3" || m["protocol"] != float64(proto.Protocol) {
		t.Fatalf("hello: %v", m)
	}
	send(t, c, proto.In{T: "devices"})
	if m, err := read(c); err != nil || m["t"] != "devices" {
		t.Fatalf("devices: %v %v", m, err)
	}
}

// A page on another protocol hears who we are (so it can say what to
// update), and nothing else happens.
func TestOtherProtocolOnlyGetsHello(t *testing.T) {
	b, url := serve(t)
	c, _, err := dial(t, url, site)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send(t, c, proto.In{T: "hello", Token: b.Token, Protocol: proto.Protocol + 1})
	if m, err := read(c); err != nil || m["t"] != "hello" {
		t.Fatalf("hello: %v %v", m, err)
	}
	send(t, c, proto.In{T: "audio", On: true})
	if m, err := read(c); err == nil {
		t.Fatalf("answered a page on another protocol: %v", m)
	}
	if b.engine.AudioOn() {
		t.Fatal("opened the sound card for a page on another protocol")
	}
}

type fakeOverlay struct {
	calls chan string
}

func (f *fakeOverlay) Supported() bool { return true }
func (f *fakeOverlay) Show(p proto.OverlayPlace) error {
	f.calls <- "show " + p.Anchor
	return nil
}
func (f *fakeOverlay) Hide()                   { f.calls <- "hide" }
func (f *fakeOverlay) Reset()                  { f.calls <- "reset" }
func (f *fakeOverlay) State(r json.RawMessage) { f.calls <- "state " + string(r) }
func (f *fakeOverlay) Look(r json.RawMessage)  { f.calls <- "look " + string(r) }
func (f *fakeOverlay) Levels(proto.Levels)     {}
func (f *fakeOverlay) Monitors() proto.Monitors {
	return proto.Monitors{T: "monitors", Placeable: true}
}

// The page that said hello can show the overlay and tell it what to draw; it's told the overlay's there.
func TestOverlay(t *testing.T) {
	b, url := serve(t)
	ov := &fakeOverlay{calls: make(chan string, 16)}
	b.Overlay = ov
	c, _, err := dial(t, url, site)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send(t, c, proto.In{T: "overlay", Op: "show", Place: &proto.OverlayPlace{Anchor: "top"}})
	send(t, c, proto.In{T: "hello", Token: b.Token, Site: site, Protocol: proto.Protocol})
	m, err := read(c)
	if err != nil || m["t"] != "hello" || m["overlay"] != true {
		t.Fatalf("hello: %v %v", m, err)
	}
	if got := <-ov.calls; got != "reset" {
		t.Fatalf("a fresh page should reset the overlay first, got %q", got)
	}
	send(t, c, proto.In{T: "overlay", Op: "show", Place: &proto.OverlayPlace{Anchor: "bottom-left"}})
	send(t, c, proto.In{T: "overlay", Op: "state", State: json.RawMessage(`{"selfId":"me"}`)})
	send(t, c, proto.In{T: "monitors"})
	for _, want := range []string{"show bottom-left", `state {"selfId":"me"}`} {
		if got := <-ov.calls; got != want {
			t.Fatalf("got %q, want %q (nothing before hello should have got through)", got, want)
		}
	}
	for _, want := range []string{"overlay", "monitors"} {
		m, err := read(c)
		for err == nil && m["t"] != want {
			m, err = read(c)
		}
		if err != nil {
			t.Fatalf("no %s answer: %v", want, err)
		}
	}
}
