package proto

import (
	"encoding/json"
	"testing"
)

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

func TestCaptionSuppressionCompatibility(t *testing.T) {
	for _, tc := range []struct {
		payload string
		want    bool
	}{
		{`{"model":"canary-180m-flash"}`, false},
		{`{"suppressUnstableOutput":true}`, true},
		{`{"suppressUnstableOutput":false}`, false},
	} {
		var c Captions
		if err := json.Unmarshal([]byte(tc.payload), &c); err != nil {
			t.Fatal(err)
		}
		if c.Sanitize().SuppressUnstableOutput != tc.want {
			t.Fatalf("wrong suppression for %s", tc.payload)
		}
	}
}
