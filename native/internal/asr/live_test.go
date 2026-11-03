package asr

import (
	"context"
	"encoding/binary"
	"os"
	"regexp"
	"testing"
	"time"
)

// The helper is this test binary again (as it's the app's binary in the app).
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "--captions-helper" {
		os.Exit(HelperMain())
	}
	os.Exit(m.Run())
}

// The real thing, end to end: the pinned recognisers from their makers'
// releases, the models from a site (PIVOICE_SITE, e.g. `npm run dev`'s
// http://localhost:5173/ after `npm run captions:models`), into a cache folder
// of its own, and someone reading digits (tests/fixtures/speech.wav) through
// the helper. Opt in with PIVOICE_ASR_LIVE=1: it downloads ~200 MB.
func TestLiveRecognisers(t *testing.T) {
	if os.Getenv("PIVOICE_ASR_LIVE") != "1" {
		t.Skip("set PIVOICE_ASR_LIVE=1 (and PIVOICE_SITE) to run the real recognisers")
	}
	site := os.Getenv("PIVOICE_SITE")
	if site == "" {
		site = "http://localhost:5173/"
	}
	wav, err := os.ReadFile("../../../tests/fixtures/speech.wav")
	if err != nil {
		t.Fatal(err)
	}
	// 16 kHz mono 16-bit after a 44-byte header.
	pcm := make([]float32, (len(wav)-44)/2)
	for i := range pcm {
		pcm[i] = float32(int16(binary.LittleEndian.Uint16(wav[44+2*i:]))) / 32768
	}
	root := os.Getenv("PIVOICE_ASR_CACHE")
	if root == "" {
		root = t.TempDir()
	}
	digits := regexp.MustCompile(`(?i)\b(zero|one|two|three|four|five|six|seven|eight|nine)\b`)
	for _, id := range Supported() {
		t.Run(id, func(t *testing.T) {
			m, _ := ModelByID(id)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			p, err := Look(ctx, root, site, m)
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Fetch(ctx, site, func(int64) {}); err != nil {
				t.Fatal(err)
			}
			t0 := time.Now()
			h, err := StartHelper(root, m, HelperOptions{Threads: 2})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			t.Logf("loaded in %v", time.Since(t0).Round(time.Millisecond))
			var said []string
			t0 = time.Now()
			for at := 0; at < len(pcm); at += 1600 {
				text, ended, err := h.Accept(pcm[at:min(len(pcm), at+1600)])
				if err != nil {
					t.Fatal(err)
				}
				if ended && text != "" {
					said = append(said, text)
				}
			}
			partial, err := h.Partial()
			if err != nil {
				t.Fatal(err)
			}
			text, err := h.Finish()
			if err != nil {
				t.Fatal(err)
			}
			said = append(said, text)
			took := time.Since(t0)
			t.Logf("partial before the end: %q", partial)
			t.Logf("heard: %q (%.2f× real time)", said, took.Seconds()/(float64(len(pcm))/16000))
			if n := len(digits.FindAllString(joined(said), -1)); n < 5 {
				t.Fatalf("expected the digits read out, got %q", said)
			}
		})
	}
}

func joined(s []string) string {
	out := ""
	for _, x := range s {
		out += x + " "
	}
	return out
}
