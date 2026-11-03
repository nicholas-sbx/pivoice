package asr

import (
	"archive/tar"
	"archive/zip"
	"compress/bzip2"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

/*
Getting the files, and keeping them:

	<user cache>/pivoice/captions/
	  runtimes/<name>/    the libraries out of their makers' archive
	  models/<id>/        the model's files, put back together from the site's parts

Folders only you can read; each file written beside its place and renamed
in once its size and SHA-256 match the pin, so a file that's there is a
file that was right. The helper checks each one again before it loads it.
*/

// Dir is where captions keep their files (made if need be, only you can read it).
func Dir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(base, "pivoice", "captions")
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	return d, nil
}

func runtimeDir(root string, r Runtime) string { return filepath.Join(root, "runtimes", r.Name) }
func modelDir(root string, m Model) string     { return filepath.Join(root, "models", m.ID) }

// local turns a pinned path ("am/final.mdl") into one under dir, refusing anything that would leave it.
func local(dir, p string) (string, error) {
	clean := path.Clean(p)
	if clean != p || path.IsAbs(p) || strings.HasPrefix(p, "../") || p == ".." || strings.Contains(p, "\\") {
		return "", fmt.Errorf("%q isn't a plain path", p)
	}
	return filepath.Join(dir, filepath.FromSlash(clean)), nil
}

// Verify a file against its pin: size, then SHA-256.
func Verify(p string, f File) error {
	fh, err := os.Open(p)
	if err != nil {
		return err
	}
	defer fh.Close()
	st, err := fh.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Size() != f.Size {
		return fmt.Errorf("%s isn't the file it should be", f.Path)
	}
	h := sha256.New()
	if _, err := io.Copy(h, fh); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
		return fmt.Errorf("%s isn't the file it should be", f.Path)
	}
	return nil
}

// present: there, and the right size (Verify checks the rest, in the helper, before it's loaded).
func present(p string, f File) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Size() == f.Size
}

// ---- what's missing --------------------------------------------------------------

// Plan is what's still to download for a model, and how much.
type Plan struct {
	Model    Model
	Runtime  Runtime
	root     string
	needsLib bool
	missing  []manifestFile
	Bytes    int64
}

// Done: nothing to download.
func (p *Plan) Done() bool { return !p.needsLib && len(p.missing) == 0 }

// Look sees what of a model (and its runtime) is already here, and how much the rest is to download.
func Look(ctx context.Context, root, site string, m Model) (*Plan, error) {
	r, ok := runtimeFor(m.Engine)
	if !ok {
		return nil, fmt.Errorf("%s doesn't run on %s here", m.Title, platform())
	}
	p := &Plan{Model: m, Runtime: r, root: root}
	for _, f := range r.Files {
		if !present(filepath.Join(runtimeDir(root, r), f.Path), f.File) {
			p.needsLib = true
			p.Bytes += r.Size
			break
		}
	}
	var want []string
	for _, f := range m.Files {
		lp, err := local(modelDir(root, m), f.Path)
		if err != nil {
			return nil, err
		}
		if !present(lp, f) {
			want = append(want, f.Path)
		}
	}
	if len(want) > 0 {
		man, err := fetchManifest(ctx, site, m)
		if err != nil {
			return nil, err
		}
		for _, f := range man.Files {
			for _, w := range want {
				if f.Path == w {
					p.missing = append(p.missing, f)
					for _, part := range f.Parts {
						p.Bytes += part.Size
					}
				}
			}
		}
	}
	return p, nil
}

// Fetch downloads what Look found missing; progress gets the bytes so far.
func (p *Plan) Fetch(ctx context.Context, site string, progress func(int64)) error {
	var done int64
	count := func(n int64) {
		done += n
		progress(done)
	}
	if p.needsLib {
		if err := fetchRuntime(ctx, p.root, p.Runtime, count); err != nil {
			return err
		}
		p.needsLib = false
	}
	for len(p.missing) > 0 {
		if err := fetchModelFile(ctx, p.root, site, p.Model, p.missing[0], count); err != nil {
			return err
		}
		p.missing = p.missing[1:]
	}
	return nil
}

// Forget a model's files (the runtimes stay: they're shared and small next to it).
func Forget(root string, m Model) error {
	return os.RemoveAll(modelDir(root, m))
}

// ---- the network -----------------------------------------------------------------

var client = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 20 * time.Second}).DialContext,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		ForceAttemptHTTP2:     true,
	},
	// HTTPS all the way (GitHub's releases redirect to its file host); plain http only to this machine (a development site).
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too many redirects")
		}
		if !allowedURL(req.URL) {
			return fmt.Errorf("refusing to follow a redirect to %s", req.URL.Redacted())
		}
		return nil
	},
}

func allowedURL(u *url.URL) bool {
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	h := u.Hostname()
	ip := net.ParseIP(h)
	return strings.EqualFold(h, "localhost") || (ip != nil && ip.IsLoopback())
}

func get(ctx context.Context, raw string) (*http.Response, error) {
	u, err := url.Parse(raw)
	if err != nil || !allowedURL(u) {
		return nil, fmt.Errorf("refusing to fetch %s", raw)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("%s: HTTP %d", u.Redacted(), res.StatusCode)
	}
	return res, nil
}

// progressReader counts what's read.
type progressReader struct {
	r     io.Reader
	count func(int64)
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.count(int64(n))
	}
	return n, err
}

// writeVerified writes r to dst through a file beside it, renaming it in only if it's exactly the pinned file.
func writeVerified(dst string, r io.Reader, f File) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".part-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, f.Size+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != f.Size || hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
		return fmt.Errorf("%s isn't the file it should be", f.Path)
	}
	return os.Rename(tmp.Name(), dst)
}

// ---- runtimes: the makers' archives ------------------------------------------------

func fetchRuntime(ctx context.Context, root string, r Runtime, count func(int64)) error {
	res, err := get(ctx, r.URL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	dir := filepath.Join(root, "runtimes")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// The archive whole first: its own hash is checked before anything in it is opened.
	tmp, err := os.CreateTemp(dir, ".archive-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), progressReader{io.LimitReader(res.Body, r.Size+1), count})
	if err != nil {
		return err
	}
	if n != r.Size || hex.EncodeToString(h.Sum(nil)) != r.SHA256 {
		return fmt.Errorf("%s isn't the archive it should be", r.URL)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	want := map[string]File{}
	for _, m := range r.Files {
		want[m.In] = m.File
	}
	got := 0
	take := func(name string, body io.Reader) error {
		f, ok := want[name]
		if !ok {
			return nil
		}
		delete(want, name)
		got++
		return writeVerified(filepath.Join(runtimeDir(root, r), f.Path), body, f)
	}
	switch r.Archive {
	case "zip":
		zr, err := zip.NewReader(tmp, n)
		if err != nil {
			return err
		}
		for _, zf := range zr.File {
			if _, ok := want[zf.Name]; !ok {
				continue
			}
			rc, err := zf.Open()
			if err != nil {
				return err
			}
			err = take(zf.Name, rc)
			rc.Close()
			if err != nil {
				return err
			}
		}
	case "tar.bz2":
		tr := tar.NewReader(bzip2.NewReader(tmp))
		for len(want) > 0 {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if hdr.Typeflag == tar.TypeReg {
				if err := take(strings.TrimPrefix(hdr.Name, "./"), tr); err != nil {
					return err
				}
			}
		}
	default:
		return fmt.Errorf("unknown archive %q", r.Archive)
	}
	if len(want) > 0 {
		return fmt.Errorf("%s is missing from %s", firstKey(want), r.URL)
	}
	return nil
}

func firstKey(m map[string]File) string {
	for k := range m {
		return k
	}
	return ""
}

// ---- models: the site's parts ------------------------------------------------------

// The site's manifest (scripts/captions-models.mjs): how each pinned file is laid out in parts.
type manifestFile struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
	Encoding string `json:"encoding"`
	Parts    []struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	} `json:"parts"`
}

type manifest struct {
	V     int            `json:"v"`
	ID    string         `json:"id"`
	Files []manifestFile `json:"files"`
}

func modelURL(site string, m Model, name string) (string, error) {
	base, err := url.Parse(site)
	if err != nil {
		return "", err
	}
	return base.JoinPath("captions", m.ID, name).String(), nil
}

// fetchManifest gets the site's manifest and takes it only if it matches the pins (as src/captions/models.ts's checkManifest).
func fetchManifest(ctx context.Context, site string, m Model) (*manifest, error) {
	u, err := modelURL(site, m, "manifest.json")
	if err != nil {
		return nil, err
	}
	res, err := get(ctx, u)
	if err != nil {
		return nil, fmt.Errorf("couldn't get the %s model's list: %w", m.Title, err)
	}
	defer res.Body.Close()
	var man manifest
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&man); err != nil {
		return nil, fmt.Errorf("the %s model's list: %w", m.Title, err)
	}
	if err := checkManifest(m, &man); err != nil {
		return nil, err
	}
	return &man, nil
}

func checkManifest(m Model, man *manifest) error {
	bad := fmt.Errorf("the site's list of the %s model's files isn't the one this app knows", m.Title)
	if man.V != 1 || man.ID != m.ID || len(man.Files) != len(m.Files) {
		return bad
	}
	for i, f := range man.Files {
		pin := m.Files[i]
		if f.Path != pin.Path || f.SHA256 != pin.SHA256 || f.Size != pin.Size || (f.Encoding != "gzip" && f.Encoding != "identity") || len(f.Parts) == 0 || len(f.Parts) > 64 {
			return bad
		}
		ext := ""
		if f.Encoding == "gzip" {
			ext = ".gz"
		}
		for n, p := range f.Parts {
			if p.Name != fmt.Sprintf("%s%s.%d", f.Path, ext, n) || p.Size <= 0 || p.Size > 32<<20 {
				return bad
			}
		}
	}
	return nil
}

// fetchModelFile streams a file's parts one after another, gunzips them if need be, and keeps the result if it's the pinned file.
func fetchModelFile(ctx context.Context, root, site string, m Model, f manifestFile, count func(int64)) error {
	pr, pw := io.Pipe()
	go func() {
		for _, p := range f.Parts {
			u, err := modelURL(site, m, p.Name)
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			res, err := get(ctx, u)
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			n, err := io.Copy(pw, progressReader{io.LimitReader(res.Body, p.Size), count})
			res.Body.Close()
			if err == nil && n != p.Size {
				err = fmt.Errorf("%s came short", p.Name)
			}
			if err != nil {
				pw.CloseWithError(err)
				return
			}
		}
		pw.Close()
	}()
	defer pr.Close()
	var body io.Reader = pr
	if f.Encoding == "gzip" {
		zr, err := gzip.NewReader(pr)
		if err != nil {
			return err
		}
		defer zr.Close()
		body = zr
	}
	pin := File{Path: f.Path, SHA256: f.SHA256, Size: f.Size}
	dst, err := local(modelDir(root, m), f.Path)
	if err != nil {
		return err
	}
	return writeVerified(dst, body, pin)
}
