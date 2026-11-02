package offline

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReachable(t *testing.T) {
	// An error status is still an answer.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down for lunch", http.StatusServiceUnavailable)
	}))
	if err := Reachable(context.Background(), srv.URL); err != nil {
		t.Errorf("503: %v, want reachable", err)
	}
	// Nothing listening is not.
	srv.Close()
	if err := Reachable(context.Background(), srv.URL); err == nil {
		t.Error("closed server: reachable")
	}
	if err := Reachable(context.Background(), "://bad"); err == nil {
		t.Error("bad url: reachable")
	}
}

func TestWatchOpensOnceBack(t *testing.T) {
	var checks atomic.Int32
	var shown []string
	opened := make(chan struct{})
	go Watch(context.Background(), Config{
		URL: "https://pivoice.example/",
		Check: func(context.Context, string) error {
			if checks.Add(1) < 4 {
				return errors.New("offline")
			}
			return nil
		},
		Show:  func(p string) { shown = append(shown, p) },
		Open:  func() { close(opened) },
		Every: time.Millisecond,
	})
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("never opened")
	}
	// Shown once, not on every failed check.
	if len(shown) != 1 || !strings.Contains(shown[0], "pivoice.example") {
		t.Errorf("shown %d times: %q", len(shown), shown)
	}
}

func TestWatchRetryShowsAgain(t *testing.T) {
	var shown []string
	showed := make(chan struct{}, 4)
	retry := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		Watch(ctx, Config{
			URL:   "https://pivoice.example/",
			Check: func(context.Context, string) error { return errors.New("offline") },
			Show:  func(p string) { shown = append(shown, p); showed <- struct{}{} },
			Open:  func() { t.Error("opened while offline") },
			Retry: retry,
			Every: time.Hour,
		})
	}()
	<-showed
	retry <- struct{}{}
	<-showed
	cancel()
	<-done
	if len(shown) != 2 || strings.Contains(shown[0], "Still no answer") || !strings.Contains(shown[1], "Still no answer") {
		t.Errorf("pages: %q", shown)
	}
}

func TestWatchStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Watch(ctx, Config{
			URL:   "https://pivoice.example/",
			Check: func(context.Context, string) error { return errors.New("offline") },
			Show:  func(string) {},
			Open:  func() { t.Error("opened") },
			Every: time.Hour,
		})
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("still watching")
	}
}

func TestPageEscapesHost(t *testing.T) {
	if p := Page(`<script>x</script>`, false); strings.Contains(p, "<script>x") {
		t.Error("host not escaped")
	}
}
