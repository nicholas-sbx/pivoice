// Package asr is live captions' speech recognition in the app: native
// recognisers, in a process of their own, fed only while your ring is lit.
//
//   - The models are the website's (models.json is src/captions/models.json,
//     checked to be the same): fetched from the site the first time they're
//     wanted, in its parts, and checked file by file against the SHA-256
//     pinned here before anything reads them.
//   - The recognisers are the libraries their makers publish: Vosk's
//     libvosk (Kaldi) and k2-fsa's sherpa-onnx with ONNX Runtime (for
//     Parakeet), their CPU builds (nothing here needs a GPU), fetched from
//     their GitHub releases the first time they're wanted, each archive and
//     each library in it pinned by SHA-256 below.
//   - Both are kept in the user's cache folder (os.UserCacheDir: ~/.cache
//     on Linux, %LocalAppData% on Windows), never shipped with the app.
//   - They run in a helper process (this same binary, --captions-helper),
//     never in the app's: the libraries are loaded only there, by full path
//     from that folder and only after their hashes check out, so the audio
//     process holds none of their code, threads or memory, and a crash in
//     one costs the captions, not the call. It runs at normal priority; the
//     audio thread is realtime and stays ahead of it.
//   - It's given audio only between the ring lighting and going out (plus
//     the pre-roll and post-roll): nothing to recognise is nothing to do,
//     which saves the CPU as well as keeping what you didn't say to the
//     call out of the captions.
package asr

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"runtime"
	"sort"
)

//go:embed models.json
var modelsJSON []byte

// File is one file of a model or runtime, pinned.
type File struct {
	Path   string
	SHA256 string
	Size   int64
}

// Model is one of models.json's.
type Model struct {
	ID     string
	Engine string
	Title  string
	Files  []File
}

var models = loadModels()

func loadModels() map[string]Model {
	var raw map[string]struct {
		Engine string   `json:"engine"`
		Title  string   `json:"title"`
		Files  [][3]any `json:"files"`
	}
	d := json.NewDecoder(bytesReader(modelsJSON))
	d.UseNumber()
	if err := d.Decode(&raw); err != nil {
		panic(fmt.Sprintf("asr: models.json: %v", err))
	}
	out := map[string]Model{}
	for id, m := range raw {
		mm := Model{ID: id, Engine: m.Engine, Title: m.Title}
		for _, f := range m.Files {
			path, _ := f[0].(string)
			sha, _ := f[1].(string)
			num, _ := f[2].(json.Number)
			size, err := num.Int64()
			if path == "" || len(sha) != 64 || err != nil || size <= 0 {
				panic(fmt.Sprintf("asr: models.json: %s: a file isn't [path, sha256, size]", id))
			}
			mm.Files = append(mm.Files, File{Path: path, SHA256: sha, Size: size})
		}
		out[id] = mm
	}
	return out
}

// ModelByID finds a model.
func ModelByID(id string) (Model, bool) {
	m, ok := models[id]
	return m, ok
}

// Supported is the models this app can run here: those whose engine has a runtime for this OS and CPU.
func Supported() []string {
	var ids []string
	for id, m := range models {
		if _, ok := runtimeFor(m.Engine); ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// Runtime is a recogniser library, as its makers publish it for one platform.
type Runtime struct {
	Name    string
	URL     string
	SHA256  string
	Size    int64
	Archive string // "zip" or "tar.bz2"
	// Files: the archive's members we keep, by path in the archive, each pinned
	// (Path is the name it's kept under). Load: the order they're loaded in.
	Files []Member
	Load  []string
}

// Member is one file out of a runtime's archive.
type Member struct {
	In string
	File
}

// The recognisers, by engine and platform. Vosk 0.3.45 (libvosk: Kaldi and
// OpenBLAS inside, CPU); sherpa-onnx 1.13.8 with its ONNX Runtime (the CPU
// build; on Windows the static-CRT one, so no Visual C++ runtime is needed).
var runtimes = map[string]map[string]Runtime{
	"vosk": {
		"linux/amd64": {
			Name:    "vosk-0.3.45",
			URL:     "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-linux-x86_64-0.3.45.zip",
			SHA256:  "bbdc8ed85c43979f6443142889770ea95cbfbc56cffb5c5dcd73afa875c5fbb2",
			Size:    7185065,
			Archive: "zip",
			Files: []Member{
				{"vosk-linux-x86_64-0.3.45/libvosk.so", File{"libvosk.so", "85c4654de3acdeb99abab86eeb2a6e603927d37089597c0fcc33d8638dc2ccaf", 25986496}},
			},
			Load: []string{"libvosk.so"},
		},
		"windows/amd64": {
			Name:    "vosk-0.3.45",
			URL:     "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip",
			SHA256:  "f1dcc9cca460630f81ea8f71794f69c80bed6556d2a4e6237b5785e1d2dff34b",
			Size:    14882445,
			Archive: "zip",
			Files: []Member{
				{"vosk-win64-0.3.45/libgcc_s_seh-1.dll", File{"libgcc_s_seh-1.dll", "201bf8a54ebb490f93ea4beb20740a483bf67036b90b5720f32d0c746a72d1e9", 606425}},
				{"vosk-win64-0.3.45/libwinpthread-1.dll", File{"libwinpthread-1.dll", "92caeb8a4ea281c674003462a233f3b445b685b0a6f93eb11254feda2dda9cde", 366907}},
				{"vosk-win64-0.3.45/libstdc++-6.dll", File{"libstdc++-6.dll", "a1d96a848a567d7657e152cfe92e2fd62da412968cc11ec8bdb04bf20ebc5747", 26619146}},
				{"vosk-win64-0.3.45/libvosk.dll", File{"libvosk.dll", "9331c2f6a32cf77141af27c9750e79532718f51bbc2e3cea3c60f14ca4251e4e", 26447872}},
			},
			// Its MinGW runtime first, by full path, so libvosk.dll finds those and no others.
			Load: []string{"libgcc_s_seh-1.dll", "libwinpthread-1.dll", "libstdc++-6.dll", "libvosk.dll"},
		},
	},
	"nemo-ctc": {
		"linux/amd64": {
			Name:    "sherpa-onnx-1.13.8",
			URL:     "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2",
			SHA256:  "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4",
			Size:    28156791,
			Archive: "tar.bz2",
			Files: []Member{
				{"sherpa-onnx-v1.13.8-linux-x64-shared/lib/libonnxruntime.so", File{"libonnxruntime.so", "4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e", 27026609}},
				{"sherpa-onnx-v1.13.8-linux-x64-shared/lib/libsherpa-onnx-c-api.so", File{"libsherpa-onnx-c-api.so", "b8351ca1632571ac108adbb317bcc4bf7cfe84b72690e3017316b0da3e1e344f", 5124192}},
			},
			Load: []string{"libonnxruntime.so", "libsherpa-onnx-c-api.so"},
		},
		"windows/amd64": {
			Name:    "sherpa-onnx-1.13.8",
			URL:     "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2",
			SHA256:  "6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df",
			Size:    24805859,
			Archive: "tar.bz2",
			Files: []Member{
				{"sherpa-onnx-v1.13.8-win-x64-shared-MT-Release/lib/onnxruntime.dll", File{"onnxruntime.dll", "7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25", 17799168}},
				{"sherpa-onnx-v1.13.8-win-x64-shared-MT-Release/lib/sherpa-onnx-c-api.dll", File{"sherpa-onnx-c-api.dll", "300e0c88400903fc4cfc88be88a8ae587a24cc658653e0e1fd1c2b8dbbc68557", 4605952}},
			},
			// Ours first, by full path: Windows 11 has an onnxruntime.dll of its own in System32, which isn't this one.
			Load: []string{"onnxruntime.dll", "sherpa-onnx-c-api.dll"},
		},
	},
}

func platform() string { return runtime.GOOS + "/" + runtime.GOARCH }

func runtimeFor(engine string) (Runtime, bool) {
	r, ok := runtimes[engine][platform()]
	return r, ok
}
