package asr

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
)

/*
The helper: this binary again (pivoice --captions-helper), started by the
app with pipes for its stdin and stdout, the recogniser's libraries loaded
into it and nothing else. One request at a time, each answered:

	app → helper                         helper → app
	'I' init (JSON)                      'R' ready, or 'X' why not
	'A' audio: float32 LE, 16 kHz        'K' taken, or 'F' text (Vosk finished a phrase by itself)
	'P' the phrase so far?               'P' text
	'E' end of the phrase                'F' text
	'C' config (JSON)                    'K'
	'Q' quit                             (exits)

Every frame is a type byte, a uint32 LE length and that many bytes. The
helper's own stdout is kept for this alone: whatever else writes to fd 1
(a library's chatter) goes to stderr instead.
*/

const maxFrame = 16 << 20

func writeFrame(w io.Writer, kind byte, body []byte) error {
	var head [5]byte
	head[0] = kind
	binary.LittleEndian.PutUint32(head[1:], uint32(len(body)))
	if _, err := w.Write(head[:]); err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	_, err := w.Write(body)
	return err
}

func readFrame(r io.Reader, buf []byte) (byte, []byte, error) {
	var head [5]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	n := binary.LittleEndian.Uint32(head[1:])
	if n > maxFrame {
		return 0, nil, fmt.Errorf("frame of %d bytes", n)
	}
	if cap(buf) < int(n) {
		buf = make([]byte, n)
	}
	buf = buf[:n]
	_, err := io.ReadFull(r, buf)
	return head[0], buf, err
}

// helperInit is everything the helper needs: what to load, from where, and what each must hash to.
type helperInit struct {
	Engine        string   `json:"engine"`
	LibDir        string   `json:"libDir"`
	Libs          []File   `json:"libs"`
	Load          []string `json:"load"`
	ModelDir      string   `json:"modelDir"`
	Files         []File   `json:"files"`
	Threads       int      `json:"threads"`
	MinConfidence float64  `json:"minConfidence"`
}

type helperConfig struct {
	MinConfidence float64 `json:"minConfidence"`
}

// recogniser is the helper's view of an engine.
type recogniser interface {
	// accept more of the phrase (16 kHz, [-1, 1]); a finished phrase if the engine ended one by itself.
	accept(pcm []float32) (string, bool)
	partial() string
	finish() string
	configure(helperConfig)
	close()
}

// newRecogniser loads the engine's libraries and the model; set by engines.go (it needs cgo).
var newRecogniser func(init helperInit) (recogniser, error)

// HelperMain is the helper process: it serves the app on stdin/stdout until told to quit or the app goes.
func HelperMain() int {
	out, err := protocolOut()
	if err != nil {
		log.Printf("captions helper: %v", err)
		return 1
	}
	if err := serve(os.Stdin, out); err != nil && !errors.Is(err, io.EOF) {
		log.Printf("captions helper: %v", err)
		return 1
	}
	return 0
}

func serve(in io.Reader, out io.Writer) error {
	r := bufio.NewReaderSize(in, 64<<10)
	w := bufio.NewWriter(out)
	reply := func(kind byte, body []byte) error {
		if err := writeFrame(w, kind, body); err != nil {
			return err
		}
		return w.Flush()
	}
	var rec recogniser
	defer func() {
		if rec != nil {
			rec.close()
		}
	}()
	var buf []byte
	var pcm []float32
	for {
		kind, body, err := readFrame(r, buf)
		if err != nil {
			return err
		}
		buf = body[:0]
		switch {
		case kind == 'I' && rec == nil:
			var in helperInit
			if err := json.Unmarshal(body, &in); err != nil {
				return reply('X', []byte(err.Error()))
			}
			if rec, err = start(in); err != nil {
				_ = reply('X', []byte(err.Error()))
				return err
			}
			err = reply('R', nil)
		case kind == 'Q':
			return nil
		case rec == nil:
			return errors.New("asked to recognise before init")
		case kind == 'A':
			if len(body)%4 != 0 {
				return errors.New("audio isn't whole samples")
			}
			n := len(body) / 4
			if cap(pcm) < n {
				pcm = make([]float32, n)
			}
			pcm = pcm[:n]
			for i := range pcm {
				pcm[i] = math.Float32frombits(binary.LittleEndian.Uint32(body[4*i:]))
			}
			if text, ended := rec.accept(pcm); ended {
				err = reply('F', []byte(text))
			} else {
				err = reply('K', nil)
			}
		case kind == 'P':
			err = reply('P', []byte(rec.partial()))
		case kind == 'E':
			err = reply('F', []byte(rec.finish()))
		case kind == 'C':
			var c helperConfig
			if json.Unmarshal(body, &c) == nil {
				rec.configure(c)
			}
			err = reply('K', nil)
		default:
			return fmt.Errorf("unknown request %q", kind)
		}
		if err != nil {
			return err
		}
	}
}

// start checks every library and model file against its pin, then loads them.
func start(in helperInit) (recogniser, error) {
	if newRecogniser == nil {
		return nil, errors.New("this build has no recognisers")
	}
	for _, f := range in.Libs {
		if err := Verify(filepath.Join(in.LibDir, f.Path), f); err != nil {
			return nil, fmt.Errorf("recogniser library: %w", err)
		}
	}
	for _, f := range in.Files {
		p, err := local(in.ModelDir, f.Path)
		if err != nil {
			return nil, err
		}
		if err := Verify(p, f); err != nil {
			return nil, fmt.Errorf("model: %w", err)
		}
	}
	return newRecogniser(in)
}

// voskWords is a finished phrase's words from Vosk's JSON, without those it was less sure of than min.
func voskWords(js string, min float64) string {
	var r struct {
		Text   string `json:"text"`
		Result []struct {
			Word string  `json:"word"`
			Conf float64 `json:"conf"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(js), &r) != nil {
		return ""
	}
	if min <= 0 || r.Result == nil {
		return r.Text
	}
	var keep []string
	for _, w := range r.Result {
		if w.Conf >= min {
			keep = append(keep, w.Word)
		}
	}
	return strings.Join(keep, " ")
}

func voskPartial(js string) string {
	var r struct {
		Partial string `json:"partial"`
	}
	_ = json.Unmarshal([]byte(js), &r)
	return r.Partial
}
