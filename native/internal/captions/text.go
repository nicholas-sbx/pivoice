package captions

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode"
)

// What goes over the captions channel: src/captions/protocol.ts, the same
// fields in the same order, and the same rules for the text.
const (
	Version     = 1
	MaxText     = 400
	MaxMessage  = 2048
	ChannelID   = 43
	channelName = "pv-captions"
)

// ChannelName is the captions channel's label (negotiated as ChannelID by both ends).
func ChannelName() string { return channelName }

// Message is one update of one phrase.
type Message struct {
	V int    `json:"v"`
	S int64  `json:"s"`
	U int64  `json:"u"`
	T string `json:"t"`
	F bool   `json:"f"`
}

// Encode a phrase update as it goes out: byte for byte what the page's
// encodeCaption makes (no HTML escaping, which JSON.stringify doesn't do).
func Encode(run, u int64, text string, final bool) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(Message{V: Version, S: run, U: u, T: Clean(text), F: final})
	return bytes.TrimRight(b.Bytes(), "\n")
}

func hidden(r rune) bool {
	switch {
	case r <= 0x1f, r >= 0x7f && r <= 0x9f, r == 0x2028, r == 0x2029,
		r >= 0x200b && r <= 0x200f, r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// Clean text as it may be shown: no control or direction characters,
// single spaces, at most MaxText characters (UTF-16 units, as JavaScript
// counts), the end kept from a word.
func Clean(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if hidden(r) || unicode.IsSpace(r) || r == 0xfeff {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	t := b.String()
	u := []rune(t)
	if utf16Len(u) <= MaxText {
		return t
	}
	// The last MaxText UTF-16 units, then from the first space in its first 40.
	n := 0
	i := len(u)
	for i > 0 && n+runeLen(u[i-1]) <= MaxText {
		i--
		n += runeLen(u[i])
	}
	tail := u[i:]
	units := 0
	for k := 0; k < len(tail) && units < 40; k++ {
		if tail[k] == ' ' {
			return string(tail[k+1:])
		}
		units += runeLen(tail[k])
	}
	return string(tail)
}

func runeLen(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

func utf16Len(rs []rune) int {
	n := 0
	for _, r := range rs {
		n += runeLen(r)
	}
	return n
}
