package engine

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/nicholas-sbx/pivoice/native/internal/opus"
	"github.com/nicholas-sbx/pivoice/native/internal/proto"
	"github.com/pion/webrtc/v4"
)

/*
One peer connection to one person, the app's side of src/net/peer.ts.
The page decides when links come and go (who dials, retries, timeouts:
src/net/session.ts) and passes the signalling to and from the room; this
is the connection itself. Two kinds, as in the browser:

  - voice: a call, Opus over RTP, for people who don't have the
    low-latency engine on;
  - ll: only a data channel, pre-agreed as stream 42 by both ends,
    unordered and never retransmitted, carrying the engine's packets.
*/

const (
	llChannelID     = 42
	maxPendingICE   = 64
	opusPayloadType = 111
	voicePtimeMs    = "10"
)

type link struct {
	e       *Engine
	id      string
	peer    string
	kind    string
	offerer bool
	pc      *webrtc.PeerConnection
	dc      *webrtc.DataChannel
	track   *webrtc.TrackLocalStaticSample
	// What this link brings in: their low-latency packets, or their call's audio.
	src *source

	mu        sync.Mutex
	pending   []webrtc.ICECandidateInit
	remoteSet bool
	rtts      []float64

	closed atomic.Bool
	// ll: the channel is open; voice: the connection is.
	up atomic.Bool
}

// opusFmtp is what we want to receive, as tuneOpusSdp in src/net/sdp.ts asks for it.
func opusFmtp(dtx bool) string {
	d := "0"
	if dtx {
		d = "1"
	}
	return "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;usedtx=" + d + ";maxaveragebitrate=64000"
}

func opusCapability(dtx bool) webrtc.RTPCodecCapability {
	return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: opusFmtp(dtx)}
}

func (e *Engine) newAPI(dtx bool) (*webrtc.API, error) {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: opusCapability(dtx), PayloadType: opusPayloadType}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(e.opts.Loopback)
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithSettingEngine(se)), nil
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
	api, err := e.newAPI(e.dtx.Load())
	if err != nil {
		return nil, err
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers:    iceServers(m.IceServers),
		BundlePolicy:  webrtc.BundlePolicyMaxBundle,
		RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire,
	})
	if err != nil {
		return nil, err
	}
	l := &link{e: e, id: m.Link, peer: m.Peer, kind: m.Kind, offerer: m.Offerer, pc: pc, src: newSource()}
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
			if l.kind == "voice" {
				l.up.Store(true)
				e.rebuildTargets()
			}
			e.emit(proto.LinkState{T: "link", Link: l.id, State: "connected"})
		case webrtc.PeerConnectionStateFailed:
			e.closeLink(l.id)
		}
	})

	if l.kind == "ll" {
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
			e.emit(proto.LinkState{T: "link", Link: l.id, State: "ll-up"})
		})
		dc.OnClose(func() {
			if l.up.Swap(false) {
				e.emit(proto.LinkState{T: "link", Link: l.id, State: "ll-down"})
			}
			e.closeLink(l.id)
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if !msg.IsString {
				l.receive(msg.Data)
			}
		})
	} else {
		track, err := webrtc.NewTrackLocalStaticSample(opusCapability(false), "audio", "pivoice")
		if err != nil {
			_ = pc.Close()
			return nil, err
		}
		l.track = track
		if l.offerer {
			if _, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv}); err != nil {
				_ = pc.Close()
				return nil, err
			}
		}
		pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			if t.Kind() == webrtc.RTPCodecTypeAudio {
				go l.readCall(t)
			}
		})
	}
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
	log.Printf("%s link %s: %s failed: %v", l.kind, l.id, what, err)
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
	l.signal(map[string]any{"sdp": map[string]any{"type": "offer", "sdp": tuneSDP(o.SDP)}})
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
		if l.track != nil {
			// Onto the transceiver their offer made, which makes it sendrecv.
			if _, err := l.pc.AddTrack(l.track); err != nil {
				l.fail("answer", err)
				return
			}
		}
		a, err := l.pc.CreateAnswer(nil)
		if err != nil {
			l.fail("answer", err)
			return
		}
		if err := l.pc.SetLocalDescription(a); err != nil {
			l.fail("answer", err)
			return
		}
		l.signal(map[string]any{"sdp": map[string]any{"type": "answer", "sdp": tuneSDP(a.SDP)}})
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

// tuneSDP asks for 10 ms frames on audio, the way src/net/sdp.ts does
// (libwebrtc picks its Opus frame size from the remote description's
// ptime). Only on the copy we send: pion won't take a local description
// that differs from what it made, and ptime is only a wish about what we
// receive. The Opus parameters themselves come from the codec we registered.
func tuneSDP(sdp string) string {
	if !strings.Contains(sdp, "m=audio") || strings.Contains(sdp, "a=ptime:") {
		return sdp
	}
	lines := strings.Split(sdp, "\r\n")
	out := make([]string, 0, len(lines)+1)
	inAudio := false
	for _, line := range lines {
		if strings.HasPrefix(line, "m=") || line == "" {
			if inAudio {
				out = append(out, "a=ptime:"+voicePtimeMs)
			}
			inAudio = strings.HasPrefix(line, "m=audio")
		}
		out = append(out, line)
	}
	return strings.Join(out, "\r\n")
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

// receiveLL takes one low-latency packet for a source: PCM straight
// through, Opus decoded, oldest frame first so a repeat of one we missed
// goes in before the new one.
func (e *Engine) receiveLL(s *source, buf []byte) {
	p, ok := ll.DecodePacket(buf)
	if !ok {
		return
	}
	s.bytes.Add(int64(len(buf)))
	s.pcm.Store(p.PCM)
	s.gotCodec.Store(true)
	var newest int64
	for i, f := range p.Frames {
		ts := s.unwrap.Unwrap(f.TS)
		if i == len(p.Frames)-1 {
			newest = ts
		}
		if ts <= s.lastDecoded {
			continue
		}
		s.lastDecoded = ts
		if p.PCM {
			s.deliver(float64(ts), ll.BytesToPCM(f.Data))
			continue
		}
		pcm, err := s.decode(f.Data)
		if err == nil {
			s.deliver(float64(ts), pcm)
		}
	}
	if p.HasCapture && len(p.Frames) > 0 {
		s.stamp.Store(&stamp{ts: float64(newest), ms: p.CaptureMs})
	}
}

// readCall decodes their call's audio: Opus over RTP, on the RTP clock (48 kHz for Opus).
func (l *link) readCall(t *webrtc.TrackRemote) {
	s := l.src
	l.e.attach(l)
	for {
		pkt, _, err := t.ReadRTP()
		if err != nil {
			return
		}
		if len(pkt.Payload) == 0 {
			continue
		}
		s.bytes.Add(int64(len(pkt.Payload)))
		s.gotCodec.Store(true)
		ts := s.unwrap.Unwrap(pkt.Timestamp)
		if ts <= s.lastDecoded {
			continue
		}
		s.lastDecoded = ts
		pcm, err := s.decode(pkt.Payload)
		if err == nil {
			s.deliver(float64(ts), pcm)
		}
	}
}

func (s *source) decode(data []byte) ([]float32, error) {
	if s.dec == nil {
		dec, err := opus.NewDecoder()
		if err != nil {
			return nil, err
		}
		s.dec = dec
	}
	return s.dec.Decode(data)
}
