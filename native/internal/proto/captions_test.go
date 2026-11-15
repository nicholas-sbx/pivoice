package proto

import "testing"

func TestCaptionLanguage(t *testing.T) {
	for _, language := range []string{"en", "de", "es", "fr"} {
		if got := (Captions{Language: language}).Sanitize().Language; got != language {
			t.Fatalf("language %q became %q", language, got)
		}
	}
	for _, language := range []string{"", "auto", "it"} {
		if got := (Captions{Language: language}).Sanitize().Language; got != "en" {
			t.Fatalf("language %q became %q, want English", language, got)
		}
	}
}
