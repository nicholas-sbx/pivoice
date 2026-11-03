//go:build cgo

// Package native is the C side of the captions helper: it loads a
// recogniser's libraries by full path (never by name, never from anywhere
// a search would look) and calls their C APIs: Vosk's (vosk_api.h, 0.3.45),
// sherpa-onnx's (sherpa-onnx-c-api.h, 1.13.8) and the ONNX Runtime's under
// it (onnxruntime_c_api.h, 1.28.2, MIT, Microsoft), both vendored here for
// their structs' layout. Only ever used in the helper process
// (internal/asr), after the libraries' and models' hashes have been checked.
package native

/*
#cgo linux LDFLAGS: -ldl
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sherpa-onnx-c-api.h"
#include "onnxruntime_c_api.h"

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
#define PV_BIND_FN(fn, name) do { void *p_ = pv_sym(h, name); if (!p_) return name; memcpy(&fn, &p_, sizeof p_); } while (0)
#define PV_STR_(x) #x
#define PV_STR(x) PV_STR_(x)

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

// ---- ONNX Runtime (the streaming FastConformer, driven directly) ---------------------------

static const OrtApi *pv_ort;

static const char *pv_ort_bind(void *h) {
	const OrtApiBase *(*base)(void) = NULL;
	PV_BIND_FN(base, "OrtGetApiBase");
	pv_ort = base()->GetApi(ORT_API_VERSION);
	return pv_ort ? NULL : "OrtApi " PV_STR(ORT_API_VERSION);
}

// A streaming CTC model's session: its input (one window of frames, ours,
// copied in), its caches (empty to start, then the model's own output), and
// the names to run it by.
typedef struct {
	OrtEnv *env;
	OrtSession *sess;
	OrtMemoryInfo *mem;
	OrtAllocator *alloc;
	char *in[5], *out[5];
	float *x, *zc, *zt;
	int64_t win, zl;
	OrtValue *xv, *lenv, *zero[3], *cache[3];
	int bins, window, vocab;
} pv_ctc;

static int pv_ok(OrtStatus *st, char *err, int n) {
	if (!st) return 1;
	snprintf(err, n, "%s", pv_ort->GetErrorMessage(st));
	pv_ort->ReleaseStatus(st);
	return 0;
}

static void pv_ctc_drop(pv_ctc *c) {
	for (int i = 0; i < 3; i++) {
		if (c->cache[i] && c->cache[i] != c->zero[i]) pv_ort->ReleaseValue(c->cache[i]);
		c->cache[i] = c->zero[i];
	}
}

static void pv_ctc_free(pv_ctc *c) {
	if (!c) return;
	pv_ctc_drop(c);
	for (int i = 0; i < 3; i++) if (c->zero[i]) pv_ort->ReleaseValue(c->zero[i]);
	if (c->xv) pv_ort->ReleaseValue(c->xv);
	if (c->lenv) pv_ort->ReleaseValue(c->lenv);
	for (int i = 0; i < 5; i++) {
		OrtStatus *st = NULL;
		if (c->in[i] && (st = pv_ort->AllocatorFree(c->alloc, c->in[i]))) pv_ort->ReleaseStatus(st);
		if (c->out[i] && (st = pv_ort->AllocatorFree(c->alloc, c->out[i]))) pv_ort->ReleaseStatus(st);
	}
	if (c->sess) pv_ort->ReleaseSession(c->sess);
	if (c->mem) pv_ort->ReleaseMemoryInfo(c->mem);
	if (c->env) pv_ort->ReleaseEnv(c->env);
	free(c->x);
	free(c->zc);
	free(c->zt);
	free(c);
}

// The model from memory (its file, already checked), on the CPU with this
// many threads that don't spin while there's nothing to do.
static pv_ctc *pv_ctc_new(const void *model, size_t size, int threads, int bins, int window, int vocab,
		const int64_t *ch, const int64_t *tm, char *err, int n) {
	pv_ctc *c = (pv_ctc *)calloc(1, sizeof *c);
	if (!c) { snprintf(err, n, "out of memory"); return NULL; }
	c->bins = bins; c->window = window; c->vocab = vocab; c->win = window;
	OrtSessionOptions *o = NULL;
	if (!pv_ok(pv_ort->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "pivoice-captions", &c->env), err, n) ||
		!pv_ok(pv_ort->CreateSessionOptions(&o), err, n) ||
		!pv_ok(pv_ort->SetIntraOpNumThreads(o, threads), err, n) ||
		!pv_ok(pv_ort->SetInterOpNumThreads(o, 1), err, n) ||
		!pv_ok(pv_ort->SetSessionExecutionMode(o, ORT_SEQUENTIAL), err, n) ||
		!pv_ok(pv_ort->SetSessionGraphOptimizationLevel(o, ORT_ENABLE_ALL), err, n) ||
		!pv_ok(pv_ort->AddSessionConfigEntry(o, "session.intra_op.allow_spinning", "0"), err, n) ||
		!pv_ok(pv_ort->CreateSessionFromArray(c->env, model, size, o, &c->sess), err, n)) {
		if (o) pv_ort->ReleaseSessionOptions(o);
		pv_ctc_free(c);
		return NULL;
	}
	pv_ort->ReleaseSessionOptions(o);
	size_t ni = 0, no = 0;
	if (!pv_ok(pv_ort->GetAllocatorWithDefaultOptions(&c->alloc), err, n) ||
		!pv_ok(pv_ort->SessionGetInputCount(c->sess, &ni), err, n) ||
		!pv_ok(pv_ort->SessionGetOutputCount(c->sess, &no), err, n)) {
		pv_ctc_free(c);
		return NULL;
	}
	if (ni != 5 || no != 5) {
		snprintf(err, n, "model has %d inputs and %d outputs, not 5 and 5", (int)ni, (int)no);
		pv_ctc_free(c);
		return NULL;
	}
	for (size_t i = 0; i < 5; i++) {
		if (!pv_ok(pv_ort->SessionGetInputName(c->sess, i, c->alloc, &c->in[i]), err, n) ||
			!pv_ok(pv_ort->SessionGetOutputName(c->sess, i, c->alloc, &c->out[i]), err, n)) {
			pv_ctc_free(c);
			return NULL;
		}
	}
	size_t nc = (size_t)(ch[0] * ch[1] * ch[2] * ch[3]), nt = (size_t)(tm[0] * tm[1] * tm[2] * tm[3]);
	c->x = (float *)calloc((size_t)bins * window, sizeof(float));
	c->zc = (float *)calloc(nc, sizeof(float));
	c->zt = (float *)calloc(nt, sizeof(float));
	if (!c->x || !c->zc || !c->zt) { snprintf(err, n, "out of memory"); pv_ctc_free(c); return NULL; }
	int64_t xs[3] = {1, bins, window}, one = 1;
	if (!pv_ok(pv_ort->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &c->mem), err, n) ||
		!pv_ok(pv_ort->CreateTensorWithDataAsOrtValue(c->mem, c->x, (size_t)bins * window * sizeof(float), xs, 3, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &c->xv), err, n) ||
		!pv_ok(pv_ort->CreateTensorWithDataAsOrtValue(c->mem, &c->win, sizeof c->win, &one, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &c->lenv), err, n) ||
		!pv_ok(pv_ort->CreateTensorWithDataAsOrtValue(c->mem, c->zc, nc * sizeof(float), ch, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &c->zero[0]), err, n) ||
		!pv_ok(pv_ort->CreateTensorWithDataAsOrtValue(c->mem, c->zt, nt * sizeof(float), tm, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &c->zero[1]), err, n) ||
		!pv_ok(pv_ort->CreateTensorWithDataAsOrtValue(c->mem, &c->zl, sizeof c->zl, &one, 1, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &c->zero[2]), err, n)) {
		pv_ctc_free(c);
		return NULL;
	}
	pv_ctc_drop(c);
	return c;
}

// One chunk: x (bins × window) in, its log-probabilities (frames × vocab) to out, the caches kept.
static int pv_ctc_run(pv_ctc *c, const float *x, float *out, int out_len, int *frames, char *err, int n) {
	memcpy(c->x, x, (size_t)c->bins * c->window * sizeof(float));
	const OrtValue *in[5] = {c->xv, c->lenv, c->cache[0], c->cache[1], c->cache[2]};
	OrtValue *res[5] = {NULL, NULL, NULL, NULL, NULL};
	if (!pv_ok(pv_ort->Run(c->sess, NULL, (const char *const *)c->in, in, 5, (const char *const *)c->out, 5, res), err, n)) return -1;
	int rc = -1;
	OrtTensorTypeAndShapeInfo *info = NULL;
	int64_t dims[3] = {0, 0, 0};
	size_t nd = 0;
	float *lp = NULL;
	if (pv_ok(pv_ort->GetTensorTypeAndShape(res[0], &info), err, n) &&
		pv_ok(pv_ort->GetDimensionsCount(info, &nd), err, n) && nd == 3 &&
		pv_ok(pv_ort->GetDimensions(info, dims, 3), err, n) &&
		pv_ok(pv_ort->GetTensorMutableData(res[0], (void **)&lp), err, n)) {
		if (dims[0] != 1 || dims[2] != c->vocab || dims[1] * dims[2] > out_len) {
			snprintf(err, n, "model output of [%lld %lld %lld]", (long long)dims[0], (long long)dims[1], (long long)dims[2]);
		} else {
			memcpy(out, lp, (size_t)(dims[1] * dims[2]) * sizeof(float));
			*frames = (int)dims[1];
			rc = 0;
		}
	} else if (nd != 3 && !err[0]) {
		snprintf(err, n, "model output has %d dimensions", (int)nd);
	}
	if (info) pv_ort->ReleaseTensorTypeAndShapeInfo(info);
	pv_ort->ReleaseValue(res[0]);
	pv_ort->ReleaseValue(res[1]);
	if (rc == 0) {
		pv_ctc_drop(c);
		for (int i = 0; i < 3; i++) c->cache[i] = res[2 + i];
	} else {
		for (int i = 2; i < 5; i++) pv_ort->ReleaseValue(res[i]);
	}
	return rc;
}

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
	"strings"
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
	// Cut at the buffer's end, a character may have lost its last bytes.
	return strings.ToValidUTF8(C.GoString(&s.out[0]), "")
}

func (s *Sherpa) Close() { C.pv_sherpa_free(s.rec) }

// LoadORT loads ONNX Runtime by itself, for a model this drives directly.
func LoadORT(paths []string) error {
	return load(paths, func(h unsafe.Pointer) *C.char { return C.pv_ort_bind(h) })
}

// StreamCTC is a cache-aware streaming CTC model's session (NeMo's
// FastConformer, as sherpa-onnx exports it), one chunk at a time; its
// caches stay on the C side between chunks.
type StreamCTC struct {
	c   *C.pv_ctc
	err [512]C.char
}

// NewStreamCTC loads the model from its file's bytes: frames of bins, window
// of them a chunk, vocab outputs a frame, the caches' shapes as its metadata
// gives them.
func NewStreamCTC(model []byte, threads, bins, window, vocab int, channel, time [4]int64) (*StreamCTC, error) {
	if len(model) == 0 {
		return nil, errors.New("no model")
	}
	s := &StreamCTC{}
	ch := [4]C.int64_t{C.int64_t(channel[0]), C.int64_t(channel[1]), C.int64_t(channel[2]), C.int64_t(channel[3])}
	tm := [4]C.int64_t{C.int64_t(time[0]), C.int64_t(time[1]), C.int64_t(time[2]), C.int64_t(time[3])}
	s.c = C.pv_ctc_new(unsafe.Pointer(&model[0]), C.size_t(len(model)), C.int(max(1, threads)), C.int(bins), C.int(window), C.int(vocab),
		&ch[0], &tm[0], &s.err[0], C.int(len(s.err)))
	if s.c == nil {
		return nil, fmt.Errorf("onnxruntime: %s", C.GoString(&s.err[0]))
	}
	return s, nil
}

// Run one chunk: x is bins × window, bin-major; the log-probabilities (frames × vocab) go to out.
func (s *StreamCTC) Run(x, out []float32) (int, error) {
	if len(x) == 0 || len(out) == 0 {
		return 0, errors.New("nothing to run")
	}
	s.err[0] = 0
	var frames C.int
	if C.pv_ctc_run(s.c, (*C.float)(unsafe.Pointer(&x[0])), (*C.float)(unsafe.Pointer(&out[0])), C.int(len(out)), &frames, &s.err[0], C.int(len(s.err))) != 0 {
		return 0, fmt.Errorf("onnxruntime: %s", C.GoString(&s.err[0]))
	}
	return int(frames), nil
}

// Reset empties the caches, for the next segment.
func (s *StreamCTC) Reset() { C.pv_ctc_drop(s.c) }

func (s *StreamCTC) Close() { C.pv_ctc_free(s.c) }
