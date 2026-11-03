package asr

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The app's catalog is the site's: the same models, the same pins.
func TestCatalogIsTheSites(t *testing.T) {
	site, err := os.ReadFile("../../../src/captions/models.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(site, modelsJSON) {
		t.Fatal("native/internal/asr/models.json isn't src/captions/models.json: copy it over")
	}
	for _, id := range []string{"vosk-small-en", "vosk-lgraph-en", "parakeet-ctc-110m-en", "fastconformer-ctc-80ms-en", "fastconformer-ctc-480ms-en", "fastconformer-ctc-1040ms-en"} {
		m, ok := ModelByID(id)
		if !ok || len(m.Files) == 0 {
			t.Fatalf("no %s", id)
		}
	}
}

// Every runtime pins its archive and each library in it, and loads only what it keeps.
func TestRuntimesArePinned(t *testing.T) {
	for engine, plats := range runtimes {
		for plat, r := range plats {
			if len(r.SHA256) != 64 || r.Size <= 0 || !strings.HasPrefix(r.URL, "https://github.com/") {
				t.Errorf("%s %s: archive not pinned", engine, plat)
			}
			kept := map[string]bool{}
			for _, f := range r.Files {
				if len(f.SHA256) != 64 || f.Size <= 0 {
					t.Errorf("%s %s: %s not pinned", engine, plat, f.Path)
				}
				kept[f.Path] = true
			}
			for _, l := range r.Load {
				if !kept[l] {
					t.Errorf("%s %s: loads %s, which it doesn't keep", engine, plat, l)
				}
			}
		}
	}
}

func TestLocalPaths(t *testing.T) {
	for _, bad := range []string{"../x", "a/../../x", "/etc/passwd", "a//b", "a\\b", ".."} {
		if _, err := local("/root", bad); err == nil {
			t.Errorf("%q allowed", bad)
		}
	}
	if p, err := local("/root", "graph/phones/word_boundary.int"); err != nil || p != filepath.Join("/root", "graph", "phones", "word_boundary.int") {
		t.Errorf("good path refused: %v %v", p, err)
	}
}

func hash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// A pretend site and a pretend release, to fetch a model and a runtime from.
type fakeWorld struct {
	model   Model
	files   map[string][]byte
	srv     *httptest.Server
	tamper  string
	runtime Runtime
}

func newFakeWorld(t *testing.T) *fakeWorld {
	w := &fakeWorld{files: map[string][]byte{
		"am/final.mdl":    bytes.Repeat([]byte("acoustic "), 50_000),
		"conf/model.conf": []byte("--beam=10\n"),
	}}
	w.model = Model{ID: "test-model", Engine: "test", Title: "Test"}
	for _, p := range []string{"am/final.mdl", "conf/model.conf"} {
		w.model.Files = append(w.model.Files, File{Path: p, SHA256: hash(w.files[p]), Size: int64(len(w.files[p]))})
	}
	// The site's layout: the big file gzipped and in two parts, the small one as it is.
	parts := map[string][]byte{}
	var zipped bytes.Buffer
	zw := gzip.NewWriter(&zipped)
	_, _ = zw.Write(w.files["am/final.mdl"])
	_ = zw.Close()
	half := zipped.Len() / 2
	parts["am/final.mdl.gz.0"] = zipped.Bytes()[:half]
	parts["am/final.mdl.gz.1"] = zipped.Bytes()[half:]
	parts["conf/model.conf.0"] = w.files["conf/model.conf"]
	man := map[string]any{"v": 1, "id": "test-model", "files": []any{
		map[string]any{"path": "am/final.mdl", "size": len(w.files["am/final.mdl"]), "sha256": hash(w.files["am/final.mdl"]), "encoding": "gzip",
			"parts": []any{map[string]any{"name": "am/final.mdl.gz.0", "size": half}, map[string]any{"name": "am/final.mdl.gz.1", "size": zipped.Len() - half}}},
		map[string]any{"path": "conf/model.conf", "size": len(w.files["conf/model.conf"]), "sha256": hash(w.files["conf/model.conf"]), "encoding": "identity",
			"parts": []any{map[string]any{"name": "conf/model.conf.0", "size": len(w.files["conf/model.conf"])}}},
	}}
	manJSON, _ := json.Marshal(man)
	// A runtime: a zip with a library in it (and something we don't keep).
	var zbuf bytes.Buffer
	zz := zip.NewWriter(&zbuf)
	lib := bytes.Repeat([]byte{0x7f, 'E', 'L', 'F'}, 1000)
	f, _ := zz.Create("pack/libtest.so")
	_, _ = f.Write(lib)
	f, _ = zz.Create("pack/README")
	_, _ = f.Write([]byte("hi"))
	_ = zz.Close()
	w.srv = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		var body []byte
		switch {
		case p == "captions/test-model/manifest.json":
			body = manJSON
		case strings.HasPrefix(p, "captions/test-model/"):
			body = parts[strings.TrimPrefix(p, "captions/test-model/")]
			if p == w.tamper {
				body = append([]byte{}, body...)
				body[len(body)/2] ^= 1
			}
		case p == "release/runtime.zip":
			body = zbuf.Bytes()
		case p == "release/runtime.tar.bz2":
			body, _ = os.ReadFile("testdata/runtime.tar.bz2")
		}
		if body == nil {
			http.NotFound(rw, r)
			return
		}
		_, _ = rw.Write(body)
	}))
	t.Cleanup(w.srv.Close)
	w.runtime = Runtime{
		Name: "test-1", URL: w.srv.URL + "/release/runtime.zip", SHA256: hash(zbuf.Bytes()), Size: int64(zbuf.Len()), Archive: "zip",
		Files: []Member{{"pack/libtest.so", File{"libtest.so", hash(lib), int64(len(lib))}}},
		Load:  []string{"libtest.so"},
	}
	runtimes["test"] = map[string]Runtime{platform(): w.runtime}
	t.Cleanup(func() { delete(runtimes, "test") })
	return w
}

func TestFetchModelAndRuntime(t *testing.T) {
	w := newFakeWorld(t)
	root := t.TempDir()
	ctx := context.Background()
	p, err := Look(ctx, root, w.srv.URL+"/", w.model)
	if err != nil {
		t.Fatal(err)
	}
	if p.Done() || p.Bytes <= w.runtime.Size {
		t.Fatalf("nothing to do? %+v", p)
	}
	var last int64
	if err := p.Fetch(ctx, w.srv.URL+"/", func(n int64) { last = n }); err != nil {
		t.Fatal(err)
	}
	if last != p.Bytes {
		t.Errorf("progress ended at %d of %d", last, p.Bytes)
	}
	for _, f := range w.model.Files {
		if err := Verify(filepath.Join(modelDir(root, w.model), filepath.FromSlash(f.Path)), f); err != nil {
			t.Error(err)
		}
	}
	if err := Verify(filepath.Join(runtimeDir(root, w.runtime), "libtest.so"), w.runtime.Files[0].File); err != nil {
		t.Error(err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir(root, w.runtime), "README")); err == nil {
		t.Error("kept a file it wasn't asked for")
	}
	// All here now: nothing more to do.
	if p, err := Look(ctx, root, w.srv.URL+"/", w.model); err != nil || !p.Done() {
		t.Fatalf("still something to do: %v %+v", err, p)
	}
}

// A part that's been changed on the way never makes it into the cache.
func TestFetchRefusesWhatDoesntMatch(t *testing.T) {
	w := newFakeWorld(t)
	w.tamper = "captions/test-model/am/final.mdl.gz.1"
	root := t.TempDir()
	p, err := Look(context.Background(), root, w.srv.URL+"/", w.model)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Fetch(context.Background(), w.srv.URL+"/", func(int64) {}); err == nil {
		t.Fatal("took a tampered file")
	}
	if _, err := os.Stat(filepath.Join(modelDir(root, w.model), "am", "final.mdl")); err == nil {
		t.Fatal("kept a tampered file")
	}
	leftovers, _ := filepath.Glob(filepath.Join(modelDir(root, w.model), "am", ".part-*"))
	if len(leftovers) > 0 {
		t.Fatalf("left %v behind", leftovers)
	}
}

func TestRuntimeFromTarBz2(t *testing.T) {
	w := newFakeWorld(t)
	r := Runtime{
		Name: "tar-1", URL: w.srv.URL + "/release/runtime.tar.bz2",
		SHA256: "defef64bf6d7051115aed60ac3fa227e92efd66c8600953442dbea5f9f211422", Size: 212, Archive: "tar.bz2",
		Files: []Member{
			{"pack/lib/liba.so", File{"liba.so", "a3600f11d6dfee1ba77e5e3c08ee5da9d6ea991cd74131c0aa84c8b2530f6f22", 1000}},
			{"pack/lib/libb.so", File{"libb.so", "87fccfd05e6271bac69bd808f3fd94d569bb3effefcb46d5982f94035f5d6749", 500}},
		},
	}
	root := t.TempDir()
	if err := fetchRuntime(context.Background(), root, r, func(int64) {}); err != nil {
		t.Fatal(err)
	}
	for _, m := range r.Files {
		if err := Verify(filepath.Join(runtimeDir(root, r), m.Path), m.File); err != nil {
			t.Error(err)
		}
	}
	// The wrong archive is refused before anything in it is opened.
	r.SHA256 = strings.Repeat("0", 64)
	if err := fetchRuntime(context.Background(), t.TempDir(), r, func(int64) {}); err == nil {
		t.Fatal("took an archive that isn't the pinned one")
	}
}

func TestManifestMustMatchThePins(t *testing.T) {
	m, _ := ModelByID("parakeet-ctc-110m-en")
	good := func() *manifest {
		man := &manifest{V: 1, ID: m.ID}
		for _, f := range m.Files {
			mf := manifestFile{Path: f.Path, Size: f.Size, SHA256: f.SHA256, Encoding: "gzip"}
			mf.Parts = append(mf.Parts, struct {
				Name string `json:"name"`
				Size int64  `json:"size"`
			}{f.Path + ".gz.0", 100})
			man.Files = append(man.Files, mf)
		}
		return man
	}
	if err := checkManifest(m, good()); err != nil {
		t.Fatal(err)
	}
	for name, spoil := range map[string]func(*manifest){
		"another hash":    func(x *manifest) { x.Files[0].SHA256 = strings.Repeat("0", 64) },
		"a path outside":  func(x *manifest) { x.Files[0].Parts[0].Name = "../../evil" },
		"a huge part":     func(x *manifest) { x.Files[0].Parts[0].Size = 1 << 40 },
		"another model":   func(x *manifest) { x.ID = "vosk-small-en" },
		"an odd encoding": func(x *manifest) { x.Files[0].Encoding = "br" },
	} {
		x := good()
		spoil(x)
		if checkManifest(m, x) == nil {
			t.Errorf("took a manifest with %s", name)
		}
	}
}

// The helper's side of the pipe, with a pretend recogniser: requests answered in order, files checked first.
type fakeRec struct{ heard int }

func (f *fakeRec) accept(pcm []float32) (string, bool, error) {
	f.heard += len(pcm)
	if f.heard >= 3200 {
		f.heard = 0
		return "a pause", true, nil
	}
	return "", false, nil
}
func (f *fakeRec) partial() string         { return fmt.Sprintf("heard %d", f.heard) }
func (f *fakeRec) finish() (string, error) { return "the end", nil }
func (f *fakeRec) configure(helperConfig)  {}
func (f *fakeRec) close()                  {}

func TestHelperProtocol(t *testing.T) {
	old := newRecogniser
	newRecogniser = func(helperInit) (recogniser, error) { return &fakeRec{}, nil }
	t.Cleanup(func() { newRecogniser = old })
	dir := t.TempDir()
	lib := []byte("lib")
	if err := os.WriteFile(filepath.Join(dir, "lib.so"), lib, 0o600); err != nil {
		t.Fatal(err)
	}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- serve(inR, outW) }()
	ask := func(kind byte, body []byte) (byte, string) {
		if err := writeFrame(inW, kind, body); err != nil {
			t.Fatal(err)
		}
		k, b, err := readFrame(outR, nil)
		if err != nil {
			t.Fatal(err)
		}
		return k, string(b)
	}
	init, _ := json.Marshal(helperInit{Engine: "fake", LibDir: dir, Libs: []File{{"lib.so", hash(lib), 3}}, ModelDir: dir})
	if k, msg := ask('I', init); k != 'R' {
		t.Fatalf("init: %c %s", k, msg)
	}
	audio := make([]byte, 4*1600)
	if k, _ := ask('A', audio); k != 'K' {
		t.Fatalf("audio: %c", k)
	}
	if k, text := ask('P', nil); k != 'P' || text != "heard 1600" {
		t.Fatalf("partial: %c %q", k, text)
	}
	if k, text := ask('A', audio); k != 'F' || text != "a pause" {
		t.Fatalf("endpoint: %c %q", k, text)
	}
	if k, text := ask('E', nil); k != 'F' || text != "the end" {
		t.Fatalf("finish: %c %q", k, text)
	}
	_ = writeFrame(inW, 'Q', nil)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A library that isn't the pinned one is never loaded.
func TestHelperRefusesUnpinnedLibraries(t *testing.T) {
	old := newRecogniser
	loaded := false
	newRecogniser = func(helperInit) (recogniser, error) { loaded = true; return &fakeRec{}, nil }
	t.Cleanup(func() { newRecogniser = old })
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "lib.so"), []byte("not it"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := start(helperInit{LibDir: dir, Libs: []File{{"lib.so", hash([]byte("lib")), 3}}}); err == nil || loaded {
		t.Fatal("loaded a library that doesn't match its pin")
	}
}

func TestVoskWords(t *testing.T) {
	js := `{"result":[{"conf":0.9,"word":"hello"},{"conf":0.3,"word":"uh"},{"conf":0.8,"word":"there"}],"text":"hello uh there"}`
	if got := voskWords(js, 0); got != "hello uh there" {
		t.Errorf("all: %q", got)
	}
	if got := voskWords(js, 0.5); got != "hello there" {
		t.Errorf("sure ones: %q", got)
	}
	if got := voskPartial(`{"partial":"hel"}`); got != "hel" {
		t.Errorf("partial: %q", got)
	}
}
