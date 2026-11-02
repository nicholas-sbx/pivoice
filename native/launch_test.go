package main

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLauncher(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	page := `https://pivoice.example/#ABC123&native=1234.s3cret"</script><x>`
	addr, done, err := launcher(page)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(addr, "s3cret") {
		t.Fatalf("the token is in the launcher's address: %s", addr)
	}
	u, err := url.Parse(addr)
	if err != nil || u.Scheme != "file" {
		t.Fatalf("not a file address: %s", addr)
	}
	file := filepath.FromSlash(strings.TrimPrefix(u.Path, "/"))
	if runtime.GOOS != "windows" {
		file = u.Path
	}
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `location.replace("https://pivoice.example/#ABC123\u0026native=1234.s3cret\"\u003c/script\u003e\u003cx\u003e")`) {
		t.Fatalf("the page doesn't send the browser on safely:\n%s", body)
	}
	if runtime.GOOS != "windows" {
		for _, p := range []string{file, filepath.Dir(file)} {
			if st, err := os.Stat(p); err != nil || st.Mode().Perm()&0o077 != 0 {
				t.Fatalf("%s is readable by others: %v", p, st.Mode())
			}
		}
	}
	done()
	if _, err := os.Stat(filepath.Dir(file)); !os.IsNotExist(err) {
		t.Fatalf("still there after done: %v", err)
	}
}
