package asr

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// Helper is the app's end of a captions helper process (see helper.go).
// One goroutine uses it at a time.
type Helper struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	w   *bufio.Writer
	out *bufio.Reader
	buf []byte
	// Audio's bytes, reused.
	raw  []byte
	done chan struct{}
	// Answers, read by one goroutine for the helper's life; a timer reused for each wait.
	answers chan answer
	timer   *time.Timer
}

type answer struct {
	kind byte
	text string
	err  error
}

// HelperOptions is what to run and how.
type HelperOptions struct {
	Threads       int
	MinConfidence float64
}

// StartHelper starts a helper for a model whose files and runtime are all
// here (Look said so), and waits until it has loaded them (it checks every
// file's hash first).
func StartHelper(root string, m Model, o HelperOptions) (*Helper, error) {
	r, ok := runtimeFor(m.Engine)
	if !ok {
		return nil, fmt.Errorf("%s doesn't run here", m.Title)
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	threads := max(1, min(8, o.Threads))
	cmd := exec.Command(exe, "--captions-helper")
	// Only as many threads as asked for, in every library's thread pool (OpenBLAS inside Vosk among them).
	cmd.Env = append(os.Environ(), "OPENBLAS_NUM_THREADS="+strconv.Itoa(threads), "OMP_NUM_THREADS="+strconv.Itoa(threads))
	cmd.Stderr = os.Stderr
	helperProcAttr(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	h := &Helper{cmd: cmd, in: in, w: bufio.NewWriterSize(in, 64<<10), out: bufio.NewReaderSize(out, 64<<10), done: make(chan struct{}), answers: make(chan answer, 1), timer: time.NewTimer(time.Hour)}
	h.timer.Stop()
	go func() {
		_ = cmd.Wait()
		close(h.done)
	}()
	go h.read()
	init := helperInit{
		Engine:        m.Engine,
		LibDir:        runtimeDir(root, r),
		Load:          r.Load,
		ModelDir:      modelDir(root, m),
		Files:         m.Files,
		Threads:       threads,
		MinConfidence: o.MinConfidence,
	}
	for _, f := range r.Files {
		init.Libs = append(init.Libs, f.File)
	}
	body, _ := json.Marshal(init)
	// Hashing and loading a model can take a while on a slow machine.
	kind, reply, err := h.ask('I', body, 2*time.Minute)
	if err == nil && kind != 'R' {
		err = fmt.Errorf("%s", reply)
	}
	if err != nil {
		h.Close()
		return nil, err
	}
	return h, nil
}

// read the helper's answers, one at a time, for as long as it lives.
func (h *Helper) read() {
	for {
		k, b, err := readFrame(h.out, h.buf)
		h.buf = b[:0]
		a := answer{kind: k, err: err}
		if len(b) > 0 {
			a.text = string(b)
		}
		select {
		case h.answers <- a:
		case <-h.done:
			return
		}
		if err != nil {
			return
		}
	}
}

// ask sends one request and waits for its answer (or the helper's end, or the timeout).
func (h *Helper) ask(kind byte, body []byte, timeout time.Duration) (byte, string, error) {
	if err := writeFrame(h.w, kind, body); err != nil {
		return 0, "", err
	}
	if err := h.w.Flush(); err != nil {
		return 0, "", err
	}
	h.timer.Reset(timeout)
	defer h.timer.Stop()
	select {
	case a := <-h.answers:
		return a.kind, a.text, a.err
	case <-h.done:
		return 0, "", errors.New("the recogniser stopped")
	case <-h.timer.C:
		h.Close()
		return 0, "", errors.New("the recogniser stopped answering")
	}
}

// Accept more of the phrase (16 kHz, [-1, 1]); ended is true when the
// recogniser finished a phrase by itself (Vosk, at a pause), with its text.
func (h *Helper) Accept(pcm []float32) (text string, ended bool, err error) {
	if cap(h.raw) < 4*len(pcm) {
		h.raw = make([]byte, 4*len(pcm))
	}
	b := h.raw[:4*len(pcm)]
	for i, v := range pcm {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(v))
	}
	kind, text, err := h.ask('A', b, 30*time.Second)
	return text, kind == 'F', err
}

// Partial is the phrase so far (Parakeet reads it all again).
func (h *Helper) Partial() (string, error) {
	_, text, err := h.ask('P', nil, time.Minute)
	return text, err
}

// Finish ends the phrase: its text.
func (h *Helper) Finish() (string, error) {
	_, text, err := h.ask('E', nil, time.Minute)
	return text, err
}

// Configure what can change without starting again.
func (h *Helper) Configure(minConfidence float64) error {
	body, _ := json.Marshal(helperConfig{MinConfidence: minConfidence})
	_, _, err := h.ask('C', body, 10*time.Second)
	return err
}

// Close asks the helper to go, and makes sure it has.
func (h *Helper) Close() {
	_ = writeFrame(h.w, 'Q', nil)
	_ = h.w.Flush()
	_ = h.in.Close()
	select {
	case <-h.done:
	case <-time.After(2 * time.Second):
		_ = h.cmd.Process.Kill()
		<-h.done
	}
}

// Exited says whether the helper has gone (crashed, say).
func (h *Helper) Exited() bool {
	select {
	case <-h.done:
		return true
	default:
		return false
	}
}

// ModelPath is where a model's files are kept (for the settings to say).
func ModelPath(root string, m Model) string { return filepath.Clean(modelDir(root, m)) }
