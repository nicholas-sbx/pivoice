// Package proto is what the app and the page say to each other over the
// bridge (see internal/bridge, and src/native/protocol.ts on the page's
// side, which must match). JSON objects, each with a "t".
//
// The page stays the UI and keeps the room's WebSocket; the app does
// everything with audio in it: the sound card, the WebRTC connections to
// everyone, encoding, decoding and mixing. Signalling goes through the
// page, which hands the app's offers, answers and candidates to the room
// and the room's to the app.
package proto

import "encoding/json"

// Protocol is bumped whenever the app and the page stop understanding
// each other. The page refuses an app on a different one, and says which
// of the two needs updating.
const Protocol = 1

// In is anything the page sends; T says which fields mean anything.
type In struct {
	T string `json:"t"`

	// hello: the token the app gave the page, and the page's own versions.
	Token    string `json:"token,omitempty"`
	Site     string `json:"site,omitempty"`
	Protocol int    `json:"protocol,omitempty"`

	// config
	Config *Config `json:"config,omitempty"`

	// self
	Muted    bool `json:"muted,omitempty"`
	Deafened bool `json:"deafened,omitempty"`

	// members: who's deafened (nobody sends to them).
	Members []Member `json:"members,omitempty"`

	// peer: someone's volume and seat (for you only).
	ID       string   `json:"id,omitempty"`
	Volume   *float64 `json:"volume,omitempty"`
	Silenced *bool    `json:"silenced,omitempty"`
	Angle    *float64 `json:"angle,omitempty"`

	// link
	Op         string          `json:"op,omitempty"`
	Link       string          `json:"link,omitempty"`
	Peer       string          `json:"peer,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	Offerer    bool            `json:"offerer,omitempty"`
	IceServers []IceServer     `json:"iceServers,omitempty"`
	Signal     json.RawMessage `json:"signal,omitempty"`

	// audio: open or close the sound card.
	On bool `json:"on,omitempty"`

	// test: the mic test's path, or "" to stop.
	Path string `json:"path,omitempty"`

	// open: a link to open in the system's browser (the window doesn't
	// open new ones). Understood whatever the protocol, so a page can always
	// send people to download a newer app.
	URL string `json:"url,omitempty"`
}

type Member struct {
	ID       string `json:"id"`
	Deafened bool   `json:"deafened"`
}

type IceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// Config is the page's settings that the app acts on. LL has the same
// fields as LLConfig in src/audio/ll/config.ts.
type Config struct {
	LL      LLConfig `json:"ll"`
	Spatial string   `json:"spatial"`
	// Ask the people calling us to pause while they're quiet (Opus DTX in our SDP).
	DTX      bool   `json:"dtx"`
	InputID  string `json:"inputId"`
	OutputID string `json:"outputId"`
	// Windows: WASAPI exclusive mode, the device to ourselves for its smallest buffers.
	Exclusive bool `json:"exclusive"`
	// What the app does to the mic before it goes out (all off: nothing at all).
	Processing Processing `json:"processing"`
}

// Processing is ProcessingConfig in src/native/protocol.ts.
type Processing struct {
	Echo  bool `json:"echo"`
	Noise bool `json:"noise"`
	Gain  bool `json:"gain"`
	// Noise suppression's voice gate: 0–1 (0 is off), and how long it stays open after the last voice.
	GateThreshold float64 `json:"gateThreshold"`
	GateGraceMs   float64 `json:"gateGraceMs"`
	// RNNoise's lookahead: 10 ms more delay, cleaner starts of words.
	NoiseLookahead bool `json:"noiseLookahead"`
	// Automatic gain: the level it aims for (dBFS RMS) and the most it may boost (dB). 0, 0: the app's defaults.
	GainTargetDb float64 `json:"gainTargetDb"`
	GainMaxDb    float64 `json:"gainMaxDb"`
}

type LLConfig struct {
	Codec            string  `json:"codec"`
	FrameMs          float64 `json:"frameMs"`
	Application      string  `json:"application"`
	BitrateKbps      float64 `json:"bitrateKbps"`
	Complexity       float64 `json:"complexity"`
	DTX              bool    `json:"dtx"`
	DTXThresholdDb   float64 `json:"dtxThresholdDb"`
	DTXHangoverMs    float64 `json:"dtxHangoverMs"`
	Redundancy       int     `json:"redundancy"`
	MinBufferMs      float64 `json:"minBufferMs"`
	MaxBufferMs      float64 `json:"maxBufferMs"`
	MarginMs         float64 `json:"marginMs"`
	JitterMultiplier float64 `json:"jitterMultiplier"`
	JitterPercentile float64 `json:"jitterPercentile"`
	JitterWindowSec  float64 `json:"jitterWindowSec"`
	StretchPct       float64 `json:"stretchPct"`
	ConcealMs        float64 `json:"concealMs"`
}

// DefaultLL is LL_DEFAULTS in src/audio/ll/config.ts.
var DefaultLL = LLConfig{
	Codec: "pcm", FrameMs: 5, Application: "lowdelay", BitrateKbps: 64, Complexity: 8,
	DTX: true, DTXThresholdDb: -70, DTXHangoverMs: 400, Redundancy: 1,
	MinBufferMs: 0, MaxBufferMs: 80, MarginMs: 3, JitterMultiplier: 1, JitterPercentile: 99,
	JitterWindowSec: 3, StretchPct: 2, ConcealMs: 12,
}

// What the app sends.

type Hello struct {
	T        string `json:"t"` // "hello"
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	// Whether this build can do noise suppression (it's built without RNNoise where that won't link).
	Noise bool `json:"noise"`
}

// SignalOut: our side of setting up a link, for the page to pass to the room.
type SignalOut struct {
	T      string `json:"t"` // "signal"
	Link   string `json:"link"`
	Signal any    `json:"signal"`
}

// LinkState: "connected", "closed", "ll-up", "ll-down".
type LinkState struct {
	T     string `json:"t"` // "link"
	Link  string `json:"link"`
	State string `json:"state"`
}

// Levels: RMS of everyone's audio (and your mic) since the last one, ~20 a second, for the speaking rings and the meter.
type Levels struct {
	T       string             `json:"t"` // "levels"
	Self    float64            `json:"self"`
	Remotes map[string]float64 `json:"remotes"`
}

type AudioState struct {
	T     string `json:"t"` // "audio"
	On    bool   `json:"on"`
	Error string `json:"error,omitempty"`
	// "missing" when there's no microphone (listen only).
	MicProblem string `json:"micProblem,omitempty"`
	Info       any    `json:"info,omitempty"`
}

type Devices struct {
	T       string `json:"t"` // "devices"
	Devices any    `json:"devices"`
}
