// Package opus is the little of libopus the app needs: a mono 48 kHz
// encoder and decoder. It's what browsers use too (WebRTC's and WebCodecs'
// Opus are both libopus), so the packets mean the same thing either way.
package opus

/*
#cgo pkg-config: opus
#include <opus.h>

// opus_encoder_ctl is variadic, which cgo can't call.
static int pv_set_bitrate(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_BITRATE(v)); }
static int pv_set_complexity(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_COMPLEXITY(v)); }
static int pv_set_inband_fec(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_INBAND_FEC(v)); }
static int pv_set_packet_loss(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_PACKET_LOSS_PERC(v)); }
static int pv_set_dtx(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_DTX(v)); }
static int pv_set_signal_voice(OpusEncoder *e) { return opus_encoder_ctl(e, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE)); }
*/
import "C"

import (
	"fmt"
	"runtime"
	"unsafe"
)

const SampleRate = 48000

type Application int

const (
	// CELT only: 2.5 ms of lookahead instead of 6.5.
	LowDelay Application = C.OPUS_APPLICATION_RESTRICTED_LOWDELAY
	VoIP     Application = C.OPUS_APPLICATION_VOIP
	Audio    Application = C.OPUS_APPLICATION_AUDIO
)

type Encoder struct {
	e   *C.OpusEncoder
	out []byte
}

func NewEncoder(app Application) (*Encoder, error) {
	var err C.int
	e := C.opus_encoder_create(SampleRate, 1, C.int(app), &err)
	if err != C.OPUS_OK {
		return nil, fmt.Errorf("opus encoder: %s", C.GoString(C.opus_strerror(err)))
	}
	C.pv_set_signal_voice(e)
	return &Encoder{e: e, out: make([]byte, 1500)}, nil
}

func (e *Encoder) SetBitrate(bps int)         { C.pv_set_bitrate(e.e, C.opus_int32(bps)) }
func (e *Encoder) SetComplexity(c int)        { C.pv_set_complexity(e.e, C.opus_int32(c)) }
func (e *Encoder) SetDTX(on bool)             { C.pv_set_dtx(e.e, C.opus_int32(b2i(on))) }
func (e *Encoder) SetPacketLossPercent(p int) { C.pv_set_packet_loss(e.e, C.opus_int32(p)) }
func (e *Encoder) SetInbandFEC(on bool)       { C.pv_set_inband_fec(e.e, C.opus_int32(b2i(on))) }

// Encode one frame (120, 240, 480 or 960 samples). The result is a fresh copy.
func (e *Encoder) Encode(pcm []float32) ([]byte, error) {
	if len(pcm) == 0 {
		return nil, fmt.Errorf("opus: empty frame")
	}
	n := C.opus_encode_float(e.e, (*C.float)(unsafe.Pointer(&pcm[0])), C.int(len(pcm)), (*C.uchar)(unsafe.Pointer(&e.out[0])), C.opus_int32(len(e.out)))
	if n < 0 {
		return nil, fmt.Errorf("opus encode: %s", C.GoString(C.opus_strerror(n)))
	}
	return append([]byte(nil), e.out[:n]...), nil
}

func (e *Encoder) Close() {
	if e.e != nil {
		C.opus_encoder_destroy(e.e)
		e.e = nil
	}
}

type Decoder struct {
	d   *C.OpusDecoder
	buf []float32
}

func NewDecoder() (*Decoder, error) {
	var err C.int
	d := C.opus_decoder_create(SampleRate, 1, &err)
	if err != C.OPUS_OK {
		return nil, fmt.Errorf("opus decoder: %s", C.GoString(C.opus_strerror(err)))
	}
	// Room for the longest packet Opus makes (120 ms).
	dec := &Decoder{d: d, buf: make([]float32, 5760)}
	// Decoders belong to network goroutines that end on their own time; free them when they're gone.
	runtime.SetFinalizer(dec, (*Decoder).Close)
	return dec, nil
}

// Decode one packet into a fresh slice of samples.
func (d *Decoder) Decode(data []byte) ([]float32, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("opus: empty packet")
	}
	n := C.opus_decode_float(d.d, (*C.uchar)(unsafe.Pointer(&data[0])), C.opus_int32(len(data)), (*C.float)(unsafe.Pointer(&d.buf[0])), C.int(len(d.buf)), 0)
	if n < 0 {
		return nil, fmt.Errorf("opus decode: %s", C.GoString(C.opus_strerror(n)))
	}
	return append([]float32(nil), d.buf[:n]...), nil
}

func (d *Decoder) Close() {
	if d.d != nil {
		C.opus_decoder_destroy(d.d)
		d.d = nil
	}
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}
