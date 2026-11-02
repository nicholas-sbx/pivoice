// Package offline is what the app's window shows when it can't reach the
// site. The site is loaded from the network each time, and the system
// webview's own answer to a failed load is a generic error page (and on
// Windows and macOS the app has no hook to replace it). So the app asks the
// network first, and only opens the site once it answers.
package offline

import (
	"context"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Blank is shown while the first check runs, so the window is the app's
// colour instead of a webview's white.
const Blank = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#313338">`

// Reachable says whether the server at u answers at all. Any HTTP answer
// counts, an error status included: the webview shows those itself, and
// they mean the network is fine. Only failing to get an answer (no
// network, no DNS, no route, a timeout) is being offline.
func Reachable(ctx context.Context, u string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<10))
	return res.Body.Close()
}

// Config is what Watch needs.
type Config struct {
	URL   string                              // the site
	Check func(context.Context, string) error // nil: Reachable
	Show  func(page string)                   // puts the offline page in the window
	Open  func()                              // the site is reachable: go there
	Retry <-chan struct{}                     // "try again" pressed
	Every time.Duration                       // between automatic checks (0: 5 s)
}

// Watch checks the site until it answers, then calls Open and returns (or
// returns early when ctx ends). The first failure shows the offline page;
// later automatic failures leave it alone, so it doesn't flicker, and a
// failure after "Try again" shows it again, saying so.
func Watch(ctx context.Context, c Config) {
	check := c.Check
	if check == nil {
		check = Reachable
	}
	every := c.Every
	if every <= 0 {
		every = 5 * time.Second
	}
	host := c.URL
	if u, err := url.Parse(c.URL); err == nil && u.Host != "" {
		host = u.Host
	}
	shown, manual := false, false
	for {
		err := check(ctx, c.URL)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			c.Open()
			return
		}
		if !shown || manual {
			c.Show(Page(host, manual))
			shown = true
		}
		t := time.NewTimer(every)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-c.Retry:
			manual = true
		case <-t.C:
			manual = false
		}
		t.Stop()
	}
}

// Page is the offline page: flat and sharp, in the site's own colours (see
// src/styles/tokens.css). Its button calls the app's __pivoiceRetry. again
// says the user already tried once.
func Page(host string, again bool) string {
	note := "Pivoice needs the internet to reach its servers. It will open by itself once you&rsquo;re back online."
	if again {
		note = "Still no answer. It will keep trying, and open by itself once you&rsquo;re back online."
	}
	return fmt.Sprintf(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pivoice</title>
<style>
html,body{height:100%%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#313338;color:#dbdee1;font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
main{box-sizing:border-box;width:100%%;max-width:420px;margin:16px;padding:24px;background:#2b2d31;border:1px solid #1e1f22}
h1{margin:0 0 8px;color:#f2f3f5;font-size:20px;font-weight:600}
p{margin:0 0 20px;color:#b5bac1}
code{color:#dbdee1}
button{font:inherit;font-weight:500;color:#fff;background:#5865f2;border:1px solid #5865f2;padding:8px 16px;cursor:pointer}
button:hover{background:#4752c4;border-color:#4752c4}
button:active{background:#3c45a5;border-color:#3c45a5}
button:disabled{background:#4e5058;border-color:#4e5058;cursor:default}
</style></head>
<body><main>
<h1>You&rsquo;re offline</h1>
<p>Can&rsquo;t reach <code>%s</code>. %s</p>
<button id="retry" type="button">Try again</button>
</main>
<script>
var b=document.getElementById('retry');
b.onclick=function(){b.disabled=true;b.textContent='Checking…';if(window.__pivoiceRetry)window.__pivoiceRetry();};
</script></body></html>`, html.EscapeString(host), note)
}
