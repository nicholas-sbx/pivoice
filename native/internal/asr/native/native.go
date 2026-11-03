//go:build cgo

// Package native is the C side of the captions helper: it loads a
// recogniser's libraries by full path (never by name, never from anywhere
// a search would look) and calls their C APIs: Vosk's (vosk_api.h, 0.3.45)
// and sherpa-onnx's (sherpa-onnx-c-api.h, 1.13.8, vendored here for its
// structs' layout). Only ever used in the helper process (internal/asr),
// after the libraries' and models' hashes have been checked.
package native

/*
#cgo linux LDFLAGS: -ldl
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sherpa-onnx-c-api.h"

#ifdef _WIN32
#include <windows.h>
// LoadLibraryExW with the DLL's own folder then System32 for what it needs:
// never the current folder, the exe's, or PATH.
static void *pv_open(const char *path, char *err, int n) {
	int wn = MultiByteToWideChar(CP_UTF8, 0, path, -1, NULL, 0);
	if (wn <= 0) { snprintf(err, n, "bad path"); return NULL; }
	wchar_t *w = (wchar_t *)malloc(wn * sizeof(wchar_t));
	if (!w) { snprintf(err, n, "out of memory"); return NULL; }
	MultiByteToWideChar(CP_UTF8, 0, path, -1, w, wn);
	HMODULE h = LoadLibraryExW(w, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
	free(w);
	if (!h) snprintf(err, n, "LoadLibraryEx failed (error %lu)", (unsigned long)GetLastError());
	return (void *)h;
}
static void *pv_sym(void *h, const char *name) { return (void *)GetProcAddress((HMODULE)h, name); }
#else
#include <dlfcn.h>
static void *pv_open(const char *path, char *err, int n) {
	void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
	if (!h) snprintf(err, n, "%s", dlerror());
	return h;
}
static void *pv_sym(void *h, const char *name) { return dlsym(h, name); }
#endif

// Function pointers are filled from the library by name; a missing one is an error, never a crash later.
#define PV_BIND(table, field, name) do { void *p_ = pv_sym(h, name); if (!p_) return name; memcpy(&table.field, &p_, sizeof p_); } while (0)

// ---- Vosk -------------------------------------------------------------------

typedef struct VoskModel VoskModel;
typedef struct VoskRecognizer VoskRecognizer;
static struct {
	void (*set_log_level)(int);
	VoskModel *(*model_new)(const char *);
	void (*model_free)(VoskModel *);
	VoskRecognizer *(*rec_new)(VoskModel *, float);
	void (*rec_free)(VoskRecognizer *);
	void (*set_words)(VoskRecognizer *, int);
	int (*accept_f)(VoskRecognizer *, const float *, int);
	const char *(*result)(VoskRecognizer *);
	const char *(*partial)(VoskRecognizer *);
	const char *(*final_result)(VoskRecognizer *);
} pv_vosk;

static const char *pv_vosk_bind(void *h) {
	PV_BIND(pv_vosk, set_log_level, "vosk_set_log_level");
	PV_BIND(pv_vosk, model_new, "vosk_model_new");
	PV_BIND(pv_vosk, model_free, "vosk_model_free");
	PV_BIND(pv_vosk, rec_new, "vosk_recognizer_new");
	PV_BIND(pv_vosk, rec_free, "vosk_recognizer_free");
	PV_BIND(pv_vosk, set_words, "vosk_recognizer_set_words");
	PV_BIND(pv_vosk, accept_f, "vosk_recognizer_accept_waveform_f");
	PV_BIND(pv_vosk, result, "vosk_recognizer_result");
	PV_BIND(pv_vosk, partial, "vosk_recognizer_partial_result");
	PV_BIND(pv_vosk, final_result, "vosk_recognizer_final_result");
	return NULL;
}
static void pv_vosk_quiet(void) { pv_vosk.set_log_level(-1); }
static VoskModel *pv_vosk_model(const char *dir) { return pv_vosk.model_new(dir); }
static void pv_vosk_model_free(VoskModel *m) { pv_vosk.model_free(m); }
static VoskRecognizer *pv_vosk_rec(VoskModel *m, float rate) { return pv_vosk.rec_new(m, rate); }
static void pv_vosk_rec_free(VoskRecognizer *r) { pv_vosk.rec_free(r); }
static void pv_vosk_words(VoskRecognizer *r, int on) { pv_vosk.set_words(r, on); }
static int pv_vosk_accept(VoskRecognizer *r, const float *x, int n) { return pv_vosk.accept_f(r, x, n); }
static const char *pv_vosk_result(VoskRecognizer *r) { return pv_vosk.result(r); }
static const char *pv_vosk_partial(VoskRecognizer *r) { return pv_vosk.partial(r); }
static const char *pv_vosk_final(VoskRecognizer *r) { return pv_vosk.final_result(r); }

// ---- sherpa-onnx (offline: a phrase at a time) --------------------------------------------

static struct {
	const SherpaOnnxOfflineRecognizer *(*create)(const SherpaOnnxOfflineRecognizerConfig *);
	void (*destroy)(const SherpaOnnxOfflineRecognizer *);
	const SherpaOnnxOfflineStream *(*stream)(const SherpaOnnxOfflineRecognizer *);
	void (*stream_free)(const SherpaOnnxOfflineStream *);
	void (*accept)(const SherpaOnnxOfflineStream *, int32_t, const float *, int32_t);
	void (*decode)(const SherpaOnnxOfflineRecognizer *, const SherpaOnnxOfflineStream *);
	const SherpaOnnxOfflineRecognizerResult *(*result)(const SherpaOnnxOfflineStream *);
	void (*result_free)(const SherpaOnnxOfflineRecognizerResult *);
} pv_sherpa;

static const char *pv_sherpa_bind(void *h) {
	PV_BIND(pv_sherpa, create, "SherpaOnnxCreateOfflineRecognizer");
	PV_BIND(pv_sherpa, destroy, "SherpaOnnxDestroyOfflineRecognizer");
	PV_BIND(pv_sherpa, stream, "SherpaOnnxCreateOfflineStream");
	PV_BIND(pv_sherpa, stream_free, "SherpaOnnxDestroyOfflineStream");
	PV_BIND(pv_sherpa, accept, "SherpaOnnxAcceptWaveformOffline");
	PV_BIND(pv_sherpa, decode, "SherpaOnnxDecodeOfflineStream");
	PV_BIND(pv_sherpa, result, "SherpaOnnxGetOfflineStreamResult");
	PV_BIND(pv_sherpa, result_free, "SherpaOnnxDestroyOfflineRecognizerResult");
	return NULL;
}

// A NeMo CTC model (Parakeet), on the CPU. Everything not set is zero,
// which sherpa-onnx reads as its default.
static const SherpaOnnxOfflineRecognizer *pv_sherpa_ctc(const char *model, const char *tokens, int threads) {
	SherpaOnnxOfflineRecognizerConfig c;
	memset(&c, 0, sizeof c);
	c.feat_config.sample_rate = 16000;
	c.feat_config.feature_dim = 80;
	c.model_config.nemo_ctc.model = model;
	c.model_config.tokens = tokens;
	c.model_config.num_threads = threads;
	c.model_config.provider = "cpu";
	c.model_config.debug = 0;
	c.decoding_method = "greedy_search";
	return pv_sherpa.create(&c);
}
static void pv_sherpa_free(const SherpaOnnxOfflineRecognizer *r) { pv_sherpa.destroy(r); }

// One phrase in, its text out (copied into out, at most n-1 bytes).
static int pv_sherpa_decode(const SherpaOnnxOfflineRecognizer *r, const float *x, int32_t len, char *out, int n) {
	out[0] = 0;
	const SherpaOnnxOfflineStream *s = pv_sherpa.stream(r);
	if (!s) return -1;
	pv_sherpa.accept(s, 16000, x, len);
	pv_sherpa.decode(r, s);
	const SherpaOnnxOfflineRecognizerResult *res = pv_sherpa.result(s);
	if (res && res->text) {
		strncpy(out, res->text, n - 1);
		out[n - 1] = 0;
	}
	if (res) pv_sherpa.result_free(res);
	pv_sherpa.stream_free(s);
	return 0;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

func open(path string) (unsafe.Pointer, error) {
	cp := C.CString(osPath(path))
	defer C.free(unsafe.Pointer(cp))
	var buf [512]C.char
	h := C.pv_open(cp, &buf[0], C.int(len(buf)))
	if h == nil {
		return nil, fmt.Errorf("loading %s: %s", path, C.GoString(&buf[0]))
	}
	return h, nil
}

// load each library in order, and bind the last one's API.
func load(paths []string, bind func(unsafe.Pointer) *C.char) error {
	if len(paths) == 0 {
		return errors.New("no libraries")
	}
	var h unsafe.Pointer
	for _, p := range paths {
		var err error
		if h, err = open(p); err != nil {
			return err
		}
	}
	if missing := bind(h); missing != nil {
		return fmt.Errorf("%s has no %s", paths[len(paths)-1], C.GoString(missing))
	}
	return nil
}

// LoadVosk loads libvosk (and, on Windows, its MinGW runtime first).
func LoadVosk(paths []string) error {
	if err := load(paths, func(h unsafe.Pointer) *C.char { return C.pv_vosk_bind(h) }); err != nil {
		return err
	}
	C.pv_vosk_quiet()
	return nil
}

// LoadSherpa loads ONNX Runtime and then sherpa-onnx's C API.
func LoadSherpa(paths []string) error {
	return load(paths, func(h unsafe.Pointer) *C.char { return C.pv_sherpa_bind(h) })
}

// Vosk is a streaming recogniser.
type Vosk struct {
	model *C.VoskModel
	rec   *C.VoskRecognizer
}

// NewVosk loads a model folder; rate is the audio's.
func NewVosk(dir string, rate float32, words bool) (*Vosk, error) {
	cd := C.CString(osPath(dir))
	defer C.free(unsafe.Pointer(cd))
	m := C.pv_vosk_model(cd)
	if m == nil {
		return nil, errors.New("vosk couldn't load the model")
	}
	r := C.pv_vosk_rec(m, C.float(rate))
	if r == nil {
		C.pv_vosk_model_free(m)
		return nil, errors.New("vosk couldn't make a recogniser")
	}
	v := &Vosk{model: m, rec: r}
	v.SetWords(words)
	return v, nil
}

// SetWords: per-word confidences in results (for leaving out unsure words).
func (v *Vosk) SetWords(on bool) {
	w := C.int(0)
	if on {
		w = 1
	}
	C.pv_vosk_words(v.rec, w)
}

// Accept samples in 16-bit range; true when Vosk finished a phrase by itself (read it with Result).
func (v *Vosk) Accept(pcm []float32) bool {
	if len(pcm) == 0 {
		return false
	}
	return C.pv_vosk_accept(v.rec, (*C.float)(unsafe.Pointer(&pcm[0])), C.int(len(pcm))) != 0
}

func (v *Vosk) Result() string  { return C.GoString(C.pv_vosk_result(v.rec)) }
func (v *Vosk) Partial() string { return C.GoString(C.pv_vosk_partial(v.rec)) }
func (v *Vosk) Final() string   { return C.GoString(C.pv_vosk_final(v.rec)) }

func (v *Vosk) Close() {
	C.pv_vosk_rec_free(v.rec)
	C.pv_vosk_model_free(v.model)
}

// Sherpa is a phrase-at-a-time recogniser (Parakeet's CTC model).
type Sherpa struct {
	rec *C.SherpaOnnxOfflineRecognizer
	out []C.char
}

// NewSherpaCTC loads a NeMo CTC model on the CPU with this many threads.
func NewSherpaCTC(model, tokens string, threads int) (*Sherpa, error) {
	cm, ct := C.CString(osPath(model)), C.CString(osPath(tokens))
	defer C.free(unsafe.Pointer(cm))
	defer C.free(unsafe.Pointer(ct))
	r := C.pv_sherpa_ctc(cm, ct, C.int(max(1, threads)))
	if r == nil {
		return nil, errors.New("sherpa-onnx couldn't load the model")
	}
	return &Sherpa{rec: r, out: make([]C.char, 8192)}, nil
}

// Decode a whole phrase, 16 kHz, [-1, 1].
func (s *Sherpa) Decode(pcm []float32) string {
	if len(pcm) == 0 {
		return ""
	}
	C.pv_sherpa_decode(s.rec, (*C.float)(unsafe.Pointer(&pcm[0])), C.int32_t(len(pcm)), &s.out[0], C.int(len(s.out)))
	return C.GoString(&s.out[0])
}

func (s *Sherpa) Close() { C.pv_sherpa_free(s.rec) }
