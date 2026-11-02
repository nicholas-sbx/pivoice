// Package audio is the sound card: one full-duplex stream, microphone in
// and speakers out in the same callback.
//
// That's the whole trick behind a pw-loopback-like round trip: one
// callback on one clock, with the smallest buffer the device will do
// (PortAudio's "low latency" parameters), so nothing queues between
// capture and playback, and we see each block of mic audio the moment the
// driver has it. In a browser, the mic and the speakers each come with
// buffers of their own that a page can't touch.
package audio

import "time"

const SampleRate = 48000

// MaxBlock is the biggest block (samples) a stream hands its callback;
// anything bigger plays silence. What the callback keeps per block is
// sized to it, so a big block never means an allocation on the audio thread.
const MaxBlock = 8192

// Times says when a callback's audio meets the air, as wall-clock ms since
// the epoch: when its first input sample was captured, and when its first
// output sample will be heard. That's how the app measures mouth to ear.
type Times struct {
	InputMs  float64
	OutputMs float64
}

// Callback gets one block: in is mono, out is interleaved stereo
// (len(out) == 2*len(in)). It runs on the audio thread: no blocking, no
// waiting on locks, as little allocation as possible.
type Callback func(in, out []float32, t Times)

type Info struct {
	Input  string `json:"input"`
	Output string `json:"output"`
	API    string `json:"api"`
	// What the driver reports for each direction, ms.
	InputLatencyMs  float64 `json:"inputLatencyMs"`
	OutputLatencyMs float64 `json:"outputLatencyMs"`
	// The block size the callback has been getting, samples.
	Block int `json:"block"`
	// How the host API is driving it, where that varies (WASAPI: "exclusive", "shared, raw", "shared").
	Mode string `json:"mode,omitempty"`
	// Glitches since the stream opened: the mic's buffer overflowing (samples lost
	// before we saw them), and the speakers running dry (we were late with a block).
	InputOverflows   int64 `json:"inputOverflows"`
	OutputUnderflows int64 `json:"outputUnderflows"`
	// What was asked for on top of the speakers' smallest buffer (Options.ExtraOutputMs).
	ExtraOutputMs float64 `json:"extraOutputMs"`
	// Whether the audio thread runs at realtime priority, and how ("rtkit,
	// SCHED_RR 18"), or why not ("no: …"); "" where it isn't asked for (not Linux), or not yet.
	Realtime string `json:"realtime,omitempty"`
}

// Options for opening a stream.
type Options struct {
	// Devices' IDs ("" for the default ones).
	InputID, OutputID string
	// More buffer for the speakers than the smallest they offer, ms: more
	// delay, more time for a late block to still make it.
	ExtraOutputMs float64
}

type DeviceDesc struct {
	// Stable across runs (the host API and the device's name), unlike PortAudio's indexes.
	ID      string `json:"id"`
	Name    string `json:"name"`
	Input   bool   `json:"input"`
	Output  bool   `json:"output"`
	Default bool   `json:"default"`
}

type Stream interface {
	Info() Info
	Close() error
}

// Backend opens streams; PortAudio for real, Fake for tests and headless runs.
type Backend interface {
	Devices() []DeviceDesc
	// Open a duplex stream.
	Open(o Options, cb Callback) (Stream, error)
	Close()
}

func epochMs(t time.Time) float64 { return float64(t.UnixNano()) / 1e6 }
