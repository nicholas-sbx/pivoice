package engine

import (
	"fmt"
	"math"
	"runtime/metrics"
	"sort"
	"time"

	"github.com/nicholas-sbx/pivoice/native/internal/ll"
	"github.com/pion/webrtc/v4"
)

// LinkStats is LinkStats in src/net/stats.ts: the page shows it as it is
// (ping, the route card), so the field names must match.
type LinkStats struct {
	RttMs         *float64     `json:"rttMs"`
	Route         *string      `json:"route"`
	Protocol      *string      `json:"protocol"`
	RelayProtocol *string      `json:"relayProtocol"`
	RelayHost     *string      `json:"relayHost"`
	LocalType     *string      `json:"localType"`
	RemoteType    *string      `json:"remoteType"`
	JitterMs      *float64     `json:"jitterMs"`
	LossPct       *float64     `json:"lossPct"`
	BufferMs      *float64     `json:"bufferMs"`
	Kbps          *float64     `json:"kbps"`
	PlayoutMs     *float64     `json:"playoutMs"`
	CaptureMs     *float64     `json:"captureMs"`
	SendMs        float64      `json:"sendMs"`
	MouthToEarMs  *float64     `json:"mouthToEarMs"`
	MeasuredMs    *float64     `json:"measuredMs"`
	LL            *RemoteStats `json:"ll"`
}

// RemoteStats is LLRemoteStats in src/audio/ll/engine.ts.
type RemoteStats struct {
	ll.JitterStats
	Kbps       *float64 `json:"kbps"`
	MeasuredMs *float64 `json:"measuredMs"`
	RttMs      *float64 `json:"rttMs"`
}

type TestStats struct {
	Ms       *float64 `json:"ms"`
	Measured bool     `json:"measured"`
	Detail   string   `json:"detail"`
}

type Stats struct {
	T        string               `json:"t"` // "stats"
	Peers    map[string]LinkStats `json:"peers"`
	Test     *TestStats           `json:"test"`
	Audio    any                  `json:"audio"`
	Glitches Glitches             `json:"glitches"`
}

// Glitches is everything that can put a click in the audio on our side,
// counted since the sound card opened, so a crackle can be traced to its cause.
type Glitches struct {
	// The driver's own flags: the mic's buffer overflowed before we read it,
	// or the speakers ran dry because a block was late.
	InputOverflows   int64 `json:"inputOverflows"`
	OutputUnderflows int64 `json:"outputUnderflows"`
	// Mic blocks lost because the sender hadn't caught up.
	CaptureDropped int64 `json:"captureDropped"`
	// Incoming frames thrown away because the audio thread was behind.
	FramesDropped int64 `json:"framesDropped"`
	// The longest the Go runtime stopped everything (garbage collection) since the last stats, ms.
	GCPauseMaxMs float64 `json:"gcPauseMaxMs"`
}

func ptr[T any](v T) *T { return &v }

func median(xs []float64) *float64 {
	if len(xs) == 0 {
		return nil
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	return ptr(s[len(s)/2])
}

// kbps since the last time we asked (stats are read once a second). Under e.mu.
func (e *Engine) kbps(s *source, now time.Time) *float64 {
	n := s.bytes.Swap(0)
	prev, ok := e.readAt[s]
	e.readAt[s] = now
	if !ok {
		return nil
	}
	secs := now.Sub(prev).Seconds()
	if secs <= 0 {
		return nil
	}
	return ptr(float64(n) * 8 / 1000 / secs)
}

// sendMs: what our own sending costs, the PCM frame we wait to fill (sendDelayMs in config.ts).
const sendMs = float64(pcmFrame) * 1000 / 48000

func (e *Engine) stats() Stats {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	out := Stats{T: "stats", Peers: map[string]LinkStats{}}
	var inMs, outMs *float64
	if e.stream != nil {
		info := e.stream.Info()
		out.Audio = info
		// One block either way on top of what the driver reports.
		block := float64(info.Block) * 1000 / 48000
		inMs, outMs = ptr(info.InputLatencyMs+block), ptr(info.OutputLatencyMs+block)
	}
	for _, l := range e.links {
		if !l.up.Load() {
			continue
		}
		var st LinkStats
		route(l.pc, &st)
		st.CaptureMs, st.PlayoutMs = inMs, outMs
		s := l.src
		ps := s.published.Load()
		rs := &RemoteStats{Kbps: e.kbps(s, now)}
		l.mu.Lock()
		rs.RttMs = median(l.rtts)
		l.mu.Unlock()
		if rs.RttMs != nil {
			st.RttMs = rs.RttMs
		}
		st.SendMs = sendMs
		if ps != nil {
			rs.JitterStats = ps.JitterStats
			rs.MeasuredMs = ps.measuredMs
			st.BufferMs = ps.BufferMs
			st.JitterMs = ptr(ps.JitterMs)
			st.LossPct = ptr(ps.ConcealedPct)
			st.MeasuredMs = ps.measuredMs
		}
		st.Kbps = rs.Kbps
		if st.RttMs != nil && st.BufferMs != nil {
			m := *st.RttMs/2 + *st.BufferMs + st.SendMs
			if inMs != nil {
				m += *inMs + *outMs
			}
			st.MouthToEarMs = &m
		}
		st.LL = rs
		out.Peers[l.peer] = st
	}
	for s := range e.readAt {
		if !e.live(s) {
			delete(e.readAt, s)
		}
	}
	out.Test = e.testStatsLocked(inMs, outMs)
	out.Glitches = e.glitchesLocked()
	return out
}

func (e *Engine) live(s *source) bool {
	for _, l := range e.links {
		if l.src == s {
			return true
		}
	}
	return e.loop != nil && e.loop.src.Load() == s
}

func (e *Engine) testStatsLocked(inMs, outMs *float64) *TestStats {
	switch e.testPath {
	case "raw":
		if inMs == nil {
			return &TestStats{}
		}
		info := e.stream.Info()
		return &TestStats{
			Ms:     ptr(*inMs + *outMs),
			Detail: fmt.Sprintf("mic %.1f + output %.1f ms (%d-sample blocks, %s), as the driver reports them", *inMs, *outMs, info.Block, info.API),
		}
	case "ll":
		if e.loop == nil {
			return nil
		}
		s := e.loop.src.Load()
		ps := s.published.Load()
		if ps == nil {
			return &TestStats{}
		}
		buf := 0.0
		if ps.BufferMs != nil {
			buf = *ps.BufferMs
		}
		return &TestStats{
			Ms:       ps.measuredMs,
			Measured: ps.measuredMs != nil,
			Detail:   fmt.Sprintf("buffer %.0f ms (target %.0f) · concealed %.1f%% · late %d", buf, ps.TargetMs, ps.ConcealedPct, ps.Late),
		}
	}
	return nil
}

// route fills in how the link gets there, from the ICE pair in use: the
// same three kinds as the browser's route card (same network, direct, relayed).
func route(pc *webrtc.PeerConnection, st *LinkStats) {
	sctp := pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		return
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return
	}
	lt, rt := pair.Local.Typ.String(), pair.Remote.Typ.String()
	st.LocalType, st.RemoteType = &lt, &rt
	proto := pair.Local.Protocol.String()
	st.Protocol = &proto
	var r string
	switch {
	case lt == "relay" || rt == "relay":
		r = "relay"
		if lt == "relay" {
			st.RelayHost = ptr(pair.Local.Address)
			st.RelayProtocol = &proto
		}
	case lt == "host" && rt == "host":
		r = "local"
	default:
		r = "direct"
	}
	st.Route = &r
	if st.RttMs == nil {
		for _, s := range pc.GetStats() {
			if p, ok := s.(webrtc.ICECandidatePairStats); ok && p.Nominated && p.CurrentRoundTripTime > 0 {
				st.RttMs = ptr(p.CurrentRoundTripTime * 1000)
				break
			}
		}
	}
}

func (e *Engine) glitchesLocked() Glitches {
	g := Glitches{CaptureDropped: e.capDropped.Load(), GCPauseMaxMs: e.gcPauses.maxSince()}
	if e.stream != nil {
		info := e.stream.Info()
		g.InputOverflows, g.OutputUnderflows = info.InputOverflows, info.OutputUnderflows
	}
	for _, l := range e.links {
		g.FramesDropped += l.src.dropped.Load()
	}
	return g
}

// gcPauses reads the runtime's histogram of stop-the-world pauses and says
// how long the longest one since the last read was.
type gcPauses struct {
	last []uint64
}

func (p *gcPauses) maxSince() float64 {
	s := []metrics.Sample{{Name: "/sched/pauses/total/gc:seconds"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindFloat64Histogram {
		return 0
	}
	h := s[0].Value.Float64Histogram()
	longest := 0.0
	for i, c := range h.Counts {
		if i < len(p.last) && c > p.last[i] && !math.IsInf(h.Buckets[i+1], 1) {
			longest = h.Buckets[i+1] * 1000
		}
	}
	p.last = append(p.last[:0], h.Counts...)
	return longest
}
