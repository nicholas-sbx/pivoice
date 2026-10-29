package dsp

// Settings say what the chain does. All off is the default, and then the
// chain is never consulted at all (see Active).
type Settings struct {
	Echo  bool
	Noise bool
	Gain  bool
	// Noise suppression's voice gate: frames RNNoise rates less likely to be
	// voice than this (0–1) are faded out, once the grace period since the
	// last voice has passed. 0 turns the gate off (RNNoise still denoises).
	GateThreshold float32
	GateGraceMs   float32
	// RNNoise's own lookahead: a frame (10 ms) more delay, for cleaner starts of words.
	NoiseLookahead bool
	// Automatic gain's target (dBFS RMS) and the most it may boost (dB); 0, 0 means the defaults.
	GainTargetDb float32
	GainMaxDb    float32
}

func (s Settings) gainTuning() (target, most float64) {
	if s.GainTargetDb == 0 && s.GainMaxDb == 0 {
		return AGCTargetDb, AGCMaxGainDb
	}
	return float64(s.GainTargetDb), float64(s.GainMaxDb)
}

// Active: anything to do at all.
func (s Settings) Active() bool { return s.Echo || (s.Noise && NoiseAvailable) || s.Gain }

// Chain runs the mic through echo cancellation, then noise suppression,
// then gain, each in its own frame size: blocks of any size in, the same
// audio out once each stage has a frame of it. Output sample k is input
// sample k (cleaned up), so the caller keeps its own timestamps and only
// shifts them by Delay.
type Chain struct {
	set   Settings
	echo  *Echo
	noise *Denoise
	agc   *AGC

	micQ, refQ []float32
	noiseQ     []float32
	frame      [EchoFrame]float32
	echoOut    []float32
	out        []float32

	// RNNoise's first noiseDelay samples out are its silence before the
	// first frame: dropped, so output sample k is input sample k.
	noiseDelay int
	preroll    int

	// The gate: open while there's voice, and for the grace period after.
	vad      float32
	open     bool
	sinceVox int
	gateGain float32
}

// NoiseDelay is RNNoise's own delay beyond its frame filling: the
// overlap of its analysis window, one frame, and with its lookahead on,
// another (checked in the tests).
func NoiseDelay(lookahead bool) int {
	if lookahead {
		return 2 * NoiseFrame
	}
	return NoiseFrame
}

func NewChain(s Settings) (*Chain, error) {
	c := &Chain{set: s, gateGain: 1, open: true}
	if s.Echo {
		e, err := NewEcho()
		if err != nil {
			return nil, err
		}
		c.echo = e
	}
	if s.Noise && NoiseAvailable {
		d, err := NewDenoise(s.NoiseLookahead)
		if err != nil {
			c.Close()
			return nil, err
		}
		c.noise = d
		c.noiseDelay = NoiseDelay(s.NoiseLookahead)
		c.preroll = c.noiseDelay
	}
	if s.Gain {
		c.agc = NewAGC(s.gainTuning())
	}
	return c, nil
}

// Retune what doesn't need new state (the gate); the caller makes a new
// chain when a stage goes on or off (see SameStages).
func (c *Chain) Retune(s Settings) {
	c.set.GateThreshold, c.set.GateGraceMs = s.GateThreshold, s.GateGraceMs
	if c.agc != nil && (s.GainTargetDb != c.set.GainTargetDb || s.GainMaxDb != c.set.GainMaxDb) {
		c.agc.Retune(s.gainTuning())
	}
	c.set.GainTargetDb, c.set.GainMaxDb = s.GainTargetDb, s.GainMaxDb
}

// SameStages: whether a chain made for a would do for b, retuned.
func (a Settings) SameStages(b Settings) bool {
	return a.Echo == b.Echo && a.Noise == b.Noise && a.Gain == b.Gain && a.NoiseLookahead == b.NoiseLookahead
}

// Settings it was made with.
func (c *Chain) Settings() Settings { return c.set }

// Delay is how far behind the input the output is, samples: whatever is
// waiting for a frame to fill, plus RNNoise's own overlap. The last sample
// Process returned is the input sample Delay before the last one given.
func (c *Chain) Delay() int {
	d := len(c.micQ) + len(c.noiseQ)
	if c.noise != nil {
		d += c.noiseDelay - c.preroll
	}
	return d
}

// Voice is RNNoise's last say on whether you're talking (1 without it).
func (c *Chain) Voice() float32 {
	if c.noise == nil {
		return 1
	}
	return c.vad
}

// Process a block of mic (and, with echo cancellation, what played over
// the same block). Returns whatever is ready, which may be more or fewer
// samples than went in; it's only good until the next call.
func (c *Chain) Process(mic, ref []float32) []float32 {
	c.out = c.out[:0]
	stage := mic
	if c.echo != nil {
		c.micQ = append(c.micQ, mic...)
		if len(ref) == len(mic) {
			c.refQ = append(c.refQ, ref...)
		} else {
			// Nothing played (no speakers): silence as the reference.
			for range mic {
				c.refQ = append(c.refQ, 0)
			}
		}
		c.echoOut = c.echoOut[:0]
		for len(c.micQ) >= EchoFrame {
			c.echo.Process(c.micQ[:EchoFrame], c.refQ[:EchoFrame], c.frame[:])
			c.echoOut = append(c.echoOut, c.frame[:]...)
			c.micQ = append(c.micQ[:0], c.micQ[EchoFrame:]...)
			c.refQ = append(c.refQ[:0], c.refQ[EchoFrame:]...)
		}
		stage = c.echoOut
	}
	if c.noise != nil {
		c.noiseQ = append(c.noiseQ, stage...)
		for len(c.noiseQ) >= NoiseFrame {
			f := c.noiseQ[:NoiseFrame]
			c.vad = c.noise.Process(f)
			c.gate(f)
			c.out = append(c.out, f...)
			c.noiseQ = append(c.noiseQ[:0], c.noiseQ[NoiseFrame:]...)
		}
	} else {
		c.out = append(c.out, stage...)
	}
	if c.agc != nil && len(c.out) > 0 {
		c.agc.Process(c.out, c.vad >= 0.5, c.noise != nil)
	}
	return c.out
}

// gate fades a frame out when RNNoise doesn't think it's voice and the
// grace period since the last voice has run out, and back in the moment
// it does (no lookahead: the frame that opens it is the first one heard).
func (c *Chain) gate(f []float32) {
	th := c.set.GateThreshold
	if th <= 0 {
		return
	}
	grace := int(c.set.GateGraceMs * SampleRate / 1000)
	if c.vad >= th {
		c.open, c.sinceVox = true, 0
	} else {
		c.sinceVox += len(f)
		if c.sinceVox > grace {
			c.open = false
		}
	}
	target := float32(0)
	if c.open {
		target = 1
	}
	// 5 ms fades: quick enough not to cut words, slow enough not to click.
	step := float32(1) / (0.005 * SampleRate)
	for i := range f {
		switch {
		case c.gateGain < target:
			c.gateGain = min(target, c.gateGain+step)
		case c.gateGain > target:
			c.gateGain = max(target, c.gateGain-step)
		}
		f[i] *= c.gateGain
	}
}

func (c *Chain) Close() {
	if c.echo != nil {
		c.echo.Close()
	}
	if c.noise != nil {
		c.noise.Close()
	}
}
