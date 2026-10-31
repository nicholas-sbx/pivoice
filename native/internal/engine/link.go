package engine

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"

	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
	"github.com/pion/webrtc/v4"
)

/*
One peer connection to one person, the app's side of src/net/peer.ts.
The page decides when links come and go (who dials, retries, timeouts:
src/net/session.ts) and passes the signalling to and from the room; this
is the connection itself: only a data channel, pre-agreed as stream 42
by both ends, unordered and never retransmitted, carrying the low-latency
engine's packets. No media: the connection takes no audio tracks at all
(it knows no codecs), so a peer can't hand us anything but those packets.
*/

const (
	llChannelID   = 42
	maxPendingICE = 64
	// The most frames one packet may carry (the new one and two repeats),
	// and the longest a frame may be (a 128-sample block is all anyone
	// sends; 8× that is room to spare). Anything more isn't ours: dropped.
	maxPacketFrames = 3
	maxFrameBytes   = 8 * 2 * pcmFrame
)

type link struct {
	e       *Engine
	id      string
	peer    string
	offerer bool
	pc      *webrtc.PeerConnection
	dc      *webrtc.DataChannel
	// What this link brings in: their packets.
	src *source

	mu        sync.Mutex
	pending   []webrtc.ICECandidateInit
	remoteSet bool
	rtts      []float64

	closed atomic.Bool
	// The channel is open.
	up atomic.Bool
}

// newAPI: a media engine with no codecs registered, so any audio or video
// a peer offers is turned down rather than decoded.
func (e *Engine) newAPI() *webrtc.API {
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(e.opts.Loopback)
	return webrtc.NewAPI(webrtc.WithMediaEngine(&webrtc.MediaEngine{}), webrtc.WithSettingEngine(se))
}

func iceServers(in []proto.IceServer) []webrtc.ICEServer {
	var out []webrtc.ICEServer
	for _, s := range in {
		var urls []string
		switch u := s.URLs.(type) {
		case string:
			urls = []string{u}
		case []any:
			for _, x := range u {
				if str, ok := x.(string); ok {
					urls = append(urls, str)
				}
			}
		}
		if len(urls) == 0 {
			continue
		}
		srv := webrtc.ICEServer{URLs: urls, Username: s.Username}
		if s.Credential != "" {
			srv.Credential = s.Credential
		}
		out = append(out, srv)
	}
	return out
}

func (e *Engine) openLink(m proto.In) (*link, error) {
	pc, err := e.newAPI().NewPeerConnection(webrtc.Configuration{
		ICEServers:    iceServers(m.IceServers),
		BundlePolicy:  webrtc.BundlePolicyMaxBundle,
		RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire,
	})
	if err != nil {
		return nil, err
	}
	l := &link{e: e, id: m.Link, peer: m.Peer, offerer: m.Offerer, pc: pc, src: newSource()}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		j := c.ToJSON()
		l.signal(map[string]any{"ice": map[string]any{
			"candidate": j.Candidate, "sdpMid": j.SDPMid, "sdpMLineIndex": j.SDPMLineIndex, "usernameFragment": j.UsernameFragment,
		}})
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateConnected:
			e.emit(proto.LinkState{T: "link", Link: l.id, State: "connected"})
		case webrtc.PeerConnectionStateFailed:
			e.closeLink(l.id)
		}
	})

	yes, no, zero, id := true, false, uint16(0), uint16(llChannelID)
	dc, err := pc.CreateDataChannel("pv-audio", &webrtc.DataChannelInit{Negotiated: &yes, ID: &id, Ordered: &no, MaxRetransmits: &zero})
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	l.dc = dc
	dc.OnOpen(func() {
		if l.closed.Load() {
			return
		}
		l.up.Store(true)
		e.attach(l)
		e.emit(proto.LinkState{T: "link", Link: l.id, State: "up"})
	})
	dc.OnClose(func() {
		if l.up.Swap(false) {
			e.emit(proto.LinkState{T: "link", Link: l.id, State: "down"})
		}
		e.closeLink(l.id)
	})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			l.receive(msg.Data)
		}
	})
	if l.offerer {
		go l.offer()
	}
	return l, nil
}

func (l *link) signal(body map[string]any) {
	if !l.closed.Load() {
		l.e.emit(proto.SignalOut{T: "signal", Link: l.id, Signal: body})
	}
}

func (l *link) fail(what string, err error) {
	if l.closed.Load() {
		return
	}
	log.Printf("link %s: %s failed: %v", l.id, what, err)
	l.e.closeLink(l.id)
}

func (l *link) offer() {
	o, err := l.pc.CreateOffer(nil)
	if err != nil {
		l.fail("offer", err)
		return
	}
	if err := l.pc.SetLocalDescription(o); err != nil {
		l.fail("offer", err)
		return
	}
	l.signal(map[string]any{"sdp": map[string]any{"type": "offer", "sdp": o.SDP}})
}

// onSignal is the rest of the conversation: their offer or answer, their candidates.
func (l *link) onSignal(raw json.RawMessage) {
	var s struct {
		SDP *struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
		} `json:"sdp"`
		ICE *struct {
			Candidate        string  `json:"candidate"`
			SDPMid           *string `json:"sdpMid"`
			SDPMLineIndex    *uint16 `json:"sdpMLineIndex"`
			UsernameFragment *string `json:"usernameFragment"`
		} `json:"ice"`
	}
	if json.Unmarshal(raw, &s) != nil || l.closed.Load() {
		return
	}
	switch {
	case s.ICE != nil:
		c := webrtc.ICECandidateInit{Candidate: s.ICE.Candidate, SDPMid: s.ICE.SDPMid, SDPMLineIndex: s.ICE.SDPMLineIndex, UsernameFragment: s.ICE.UsernameFragment}
		l.mu.Lock()
		if !l.remoteSet {
			if len(l.pending) < maxPendingICE {
				l.pending = append(l.pending, c)
			}
			l.mu.Unlock()
			return
		}
		l.mu.Unlock()
		// A candidate that doesn't fit is harmless.
		_ = l.pc.AddICECandidate(c)
	case s.SDP != nil && s.SDP.Type == "offer" && !l.offerer:
		if err := l.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: s.SDP.SDP}); err != nil {
			l.fail("answer", err)
			return
		}
		l.flush()
		a, err := l.pc.CreateAnswer(nil)
		if err != nil {
			l.fail("answer", err)
			return
		}
		if err := l.pc.SetLocalDescription(a); err != nil {
			l.fail("answer", err)
			return
		}
		l.signal(map[string]any{"sdp": map[string]any{"type": "answer", "sdp": a.SDP}})
	case s.SDP != nil && s.SDP.Type == "answer" && l.offerer:
		if err := l.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP.SDP}); err != nil {
			l.fail("signal", err)
			return
		}
		l.flush()
	}
}

func (l *link) flush() {
	l.mu.Lock()
	l.remoteSet = true
	pending := l.pending
	l.pending = nil
	l.mu.Unlock()
	for _, c := range pending {
		_ = l.pc.AddICECandidate(c)
	}
}

func (l *link) close() {
	if l.closed.Swap(true) {
		return
	}
	l.up.Store(false)
	// Close can wait on the network: never on the caller's goroutine.
	go func() { _ = l.pc.Close() }()
}

// sendLL sends a low-latency packet unless the channel's backed up: late is dropped, never queued.
func (l *link) sendLL(buf []byte) {
	if !l.up.Load() || l.dc.BufferedAmount() > maxBuffered {
		return
	}
	_ = l.dc.Send(buf)
}

func (l *link) receive(buf []byte) {
	if kind, sent, ok := ll.DecodePing(buf); ok {
		if kind == ll.Ping {
			_ = l.dc.Send(ll.EncodePing(ll.Pong, sent))
			return
		}
		rtt := l.e.nowMs() - sent
		if rtt >= 0 && rtt < 10_000 {
			l.mu.Lock()
			l.rtts = append(l.rtts, rtt)
			if len(l.rtts) > 5 {
				l.rtts = l.rtts[1:]
			}
			l.mu.Unlock()
		}
		return
	}
	l.e.receiveLL(l.src, buf)
}

// receiveLL takes one low-latency packet for a source, oldest frame first
// so a repeat of one we missed goes in before the new one. Only raw PCM,
// at most maxPacketFrames frames of at most maxFrameBytes, and each frame
// must start where the last one we took ended or later: a repeat, or an
// overlap meant to pile frames up in the jitter buffer, goes nowhere.
func (e *Engine) receiveLL(s *source, buf []byte) {
	p, ok := ll.DecodePacket(buf)
	if !ok || !p.PCM || len(p.Frames) > maxPacketFrames {
		return
	}
	for _, f := range p.Frames {
		if len(f.Data) < 2 || len(f.Data) > maxFrameBytes {
			return
		}
	}
	s.bytes.Add(int64(len(buf)))
	var newest int64
	for i, f := range p.Frames {
		ts := s.unwrap.Unwrap(f.TS)
		if i == len(p.Frames)-1 {
			newest = ts
		}
		if ts < s.nextTS {
			continue
		}
		pcm := ll.BytesToPCM(f.Data)
		s.nextTS = ts + int64(len(pcm))
		s.deliver(float64(ts), pcm)
	}
	if p.HasCapture && len(p.Frames) > 0 {
		s.stamp.Store(&stamp{ts: float64(newest), ms: p.CaptureMs})
	}
}
