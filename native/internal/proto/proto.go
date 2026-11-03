// Package proto is what the app and the page say to each other over the
// bridge (see internal/bridge, and src/native/protocol.ts on the page's
// side, which must match). JSON objects, each with a "t".
//
// The page stays the UI and keeps the room's WebSocket; the app does
// everything with audio in it: the sound card, the WebRTC connections to
// everyone, and mixing. Signalling goes through the
// page, which hands the app's offers, answers and candidates to the room
// and the room's to the app.
package proto

import "encoding/json"

// Protocol is bumped whenever the app and the page stop understanding
// each other. The page refuses an app on a different one, and says which
// of the two needs updating. 2: no more Opus calls, only the low-latency
// engine's raw PCM; every message after hello carries the token.
const Protocol = 2

// In is anything the page sends; T says which fields mean anything.
type In struct {
	T string `json:"t"`

	// The token the app gave the page: on hello, and on everything after it.
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

	// overlay (op "show", "hide", "state", "look"): where to put it, and
	// what to draw in it, passed on to its page as it is (src/overlay).
	Place *OverlayPlace   `json:"place,omitempty"`
	State json.RawMessage `json:"state,omitempty"`
	Look  json.RawMessage `json:"look,omitempty"`
}

// OverlayPlace is where the overlay goes (OverlayPlace in
// src/native/protocol.ts): a side of a screen and a distance in from it,
// in the screen's own scaled pixels, from the part of it windows can use.
type OverlayPlace struct {
	// One of Monitors' ids, or "" for the one the Pivoice window is on.
	Monitor string `json:"monitor"`
	// top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right.
	Anchor string  `json:"anchor"`
	Margin float64 `json:"margin"`
	Size   float64 `json:"size"`
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
	LL       LLConfig `json:"ll"`
	Spatial  string   `json:"spatial"`
	InputID  string   `json:"inputId"`
	OutputID string   `json:"outputId"`
	// Windows: WASAPI exclusive mode, the device to ourselves for its smallest buffers.
	Exclusive bool `json:"exclusive"`
	// The speakers' buffer: managed by the app (it adds to it when they keep
	// running dry), or BufferMs on top of the smallest the device offers.
	// A page from before these has neither: the smallest, as it always was.
	BufferAuto bool    `json:"bufferAuto"`
	BufferMs   float64 `json:"bufferMs"`
	// What the app does to the mic before it goes out (all off: nothing at all).
	Processing Processing `json:"processing"`
	// Live captions (a page from before them sends none: captions off).
	Captions *Captions `json:"captions,omitempty"`
}

// Captions is AppCaptions in src/native/protocol.ts.
type Captions struct {
	Send           bool    `json:"send"`
	Model          string  `json:"model"`
	ShowOwn        bool    `json:"showOwn"`
	PreMs          float64 `json:"preMs"`
	PostMs         float64 `json:"postMs"`
	Partials       bool    `json:"partials"`
	PartialsPerSec float64 `json:"partialsPerSec"`
	RereadMs       float64 `json:"rereadMs"`
	MaxPhraseSec   float64 `json:"maxPhraseSec"`
	MinConfidence  float64 `json:"minConfidence"`
	Threads        int     `json:"threads"`
}

// Sanitize keeps captions' settings to the page's ranges (CAPTION_RANGES in src/captions/config.ts).
func (c Captions) Sanitize() Captions {
	c.PreMs = clamp(c.PreMs, 0, 1000, 200)
	c.PostMs = clamp(c.PostMs, 0, 2000, 200)
	c.PartialsPerSec = clamp(c.PartialsPerSec, 1, 20, 8)
	c.RereadMs = clamp(c.RereadMs, 250, 4000, 1000)
	c.MaxPhraseSec = clamp(c.MaxPhraseSec, 4, 30, 15)
	c.MinConfidence = clamp(c.MinConfidence, 0, 0.95, 0)
	c.Threads = min(8, max(1, c.Threads))
	return c
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
	// Automatic gain: the level it aims for (dBFS RMS), the most it may
	// boost (dB), the loudest it lets peaks be (dBFS), and how fast it turns
	// up and down (ms). Any left at 0: the app's default.
	GainTargetDb  float64 `json:"gainTargetDb"`
	GainMaxDb     float64 `json:"gainMaxDb"`
	GainCeilingDb float64 `json:"gainCeilingDb"`
	GainRiseMs    float64 `json:"gainRiseMs"`
	GainFallMs    float64 `json:"gainFallMs"`
}

type LLConfig struct {
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
	DTX: true, DTXThresholdDb: -70, DTXHangoverMs: 400, Redundancy: 0,
	MinBufferMs: 0, MaxBufferMs: 80, MarginMs: 3, JitterMultiplier: 1, JitterPercentile: 99,
	JitterWindowSec: 3, StretchPct: 2, ConcealMs: 12,
}

// Sanitize keeps every number in the range the page's settings allow
// (LL_RANGES in src/audio/ll/config.ts), and anything that isn't a number
// at the default: a page can't hand the engine a size it can't use.
func (c LLConfig) Sanitize() LLConfig {
	d := DefaultLL
	c.DTXThresholdDb = clamp(c.DTXThresholdDb, -90, -30, d.DTXThresholdDb)
	c.DTXHangoverMs = clamp(c.DTXHangoverMs, 50, 1500, d.DTXHangoverMs)
	c.Redundancy = min(2, max(0, c.Redundancy))
	c.MinBufferMs = clamp(c.MinBufferMs, 0, 60, d.MinBufferMs)
	c.MaxBufferMs = max(c.MinBufferMs, clamp(c.MaxBufferMs, 10, 300, d.MaxBufferMs))
	c.MarginMs = clamp(c.MarginMs, 0, 30, d.MarginMs)
	c.JitterMultiplier = clamp(c.JitterMultiplier, 0.5, 3, d.JitterMultiplier)
	c.JitterPercentile = clamp(c.JitterPercentile, 80, 100, d.JitterPercentile)
	c.JitterWindowSec = clamp(c.JitterWindowSec, 1, 10, d.JitterWindowSec)
	c.StretchPct = clamp(c.StretchPct, 0, 6, d.StretchPct)
	c.ConcealMs = clamp(c.ConcealMs, 0, 60, d.ConcealMs)
	return c
}

// MaxBufferMs is the most BufferMs may add (the biggest of the page's choices).
const MaxBufferMs = 24

// Sanitize keeps the speakers' buffer to what the page offers.
func (c Config) Sanitize() Config {
	c.LL, c.Processing = c.LL.Sanitize(), c.Processing.Sanitize()
	c.BufferMs = clamp(c.BufferMs, 0, MaxBufferMs, 0)
	if c.Captions != nil {
		cc := c.Captions.Sanitize()
		c.Captions = &cc
	}
	return c
}

// Sanitize keeps the processing settings to the page's ranges (src/lib/prefs.ts); 0 is still "the default" where it was.
func (p Processing) Sanitize() Processing {
	p.GateThreshold = clamp(p.GateThreshold, 0, 1, 0)
	p.GateGraceMs = clamp(p.GateGraceMs, 0, 2000, 0)
	p.GainTargetDb = clamp(p.GainTargetDb, -30, 0, 0)
	p.GainMaxDb = clamp(p.GainMaxDb, 0, 40, 0)
	p.GainCeilingDb = clamp(p.GainCeilingDb, -20, 0, 0)
	p.GainRiseMs = clamp(p.GainRiseMs, 0, 10000, 0)
	p.GainFallMs = clamp(p.GainFallMs, 0, 2000, 0)
	return p
}

// clamp v to [lo, hi]; NaN (not something JSON makes, but cheap to rule out) is def.
func clamp(v, lo, hi, def float64) float64 {
	if v != v {
		return def
	}
	return min(hi, max(lo, v))
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
	// Whether it can show the overlay (a window, on a desktop it knows how to put one on).
	Overlay bool `json:"overlay,omitempty"`
	// The caption models it can run natively here.
	Captions []string `json:"captions,omitempty"`
}

// CaptionState is how the app's recogniser is getting on (AppCaptionState in src/native/protocol.ts).
type CaptionState struct {
	T         string   `json:"t"` // "captions"
	Model     string   `json:"model"`
	Phase     string   `json:"phase"`
	Bytes     int64    `json:"bytes"`
	Total     int64    `json:"total"`
	Error     string   `json:"error,omitempty"`
	RTF       *float64 `json:"rtf,omitempty"`
	Listening bool     `json:"listening"`
	CacheDir  string   `json:"cacheDir,omitempty"`
	// What it hears: "raw", or "echo" (after echo cancellation, which is on; never noise suppression or gain).
	Hears string `json:"hears,omitempty"`
}

// CaptionOwn is your own words, as the app recognised them (Peer "").
type CaptionOwn struct {
	T     string `json:"t"` // "caption"
	Peer  string `json:"peer"`
	U     int64  `json:"u"`
	Text  string `json:"text"`
	Final bool   `json:"final"`
}

// CaptionPeer is a message off someone's captions channel, as it came (the page checks it).
type CaptionPeer struct {
	T    string `json:"t"` // "caption"
	Peer string `json:"peer"`
	Data string `json:"data"`
}

// Monitors: the screens the overlay can go on. Placeable: it goes where
// it's told (not on GNOME, which places windows itself). OnTop: it stays
// above other windows (GNOME only lets you ask for that from its menu).
// Needs: on a Wayland desktop that offers layer-shell, what's missing for
// it to: "gtk-layer-shell" to install, or "not-in-flatpak" (the Flatpak's
// runtime hasn't got it); else "".
type Monitors struct {
	T         string    `json:"t"` // "monitors"
	Monitors  []Monitor `json:"monitors"`
	Placeable bool      `json:"placeable"`
	OnTop     bool      `json:"onTop"`
	Needs     string    `json:"needs,omitempty"`
}

type Monitor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// The part windows can use, in the screen's own scaled pixels.
	Width   int  `json:"width"`
	Height  int  `json:"height"`
	Primary bool `json:"primary"`
	// The Pivoice window is on it.
	Current bool `json:"current"`
}

// OverlayState: whether the overlay is up, after the page asked for it.
type OverlayState struct {
	T     string `json:"t"` // "overlay"
	On    bool   `json:"on"`
	Error string `json:"error,omitempty"`
}

// SignalOut: our side of setting up a link, for the page to pass to the room.
type SignalOut struct {
	T      string `json:"t"` // "signal"
	Link   string `json:"link"`
	Signal any    `json:"signal"`
}

// LinkState: "connected", "closed", and "up" or "down" when the audio channel opens or closes.
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
