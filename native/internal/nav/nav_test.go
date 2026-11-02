package nav

import "testing"

func TestAllow(t *testing.T) {
	const site = "https://pivoice.example"
	for uri, want := range map[string]bool{
		"https://pivoice.example/":                  true,
		"https://pivoice.example/#ABC123":           true,
		"https://pivoice.example/overlay.html?x":    true,
		"about:blank":                               true,
		"http://pivoice.example/":                   false,
		"https://pivoice.example.evil.com/":         false,
		"https://evil.com/?https://pivoice.example": false,
		"https://user@evil.com/":                    false,
		"file:///etc/passwd":                        false,
		"javascript:alert(1)":                       false,
		"data:text/html,hi":                         false,
		"":                                          false,
	} {
		if got := Allow(site, uri); got != want {
			t.Errorf("%q: %v, want %v", uri, got, want)
		}
	}
}
