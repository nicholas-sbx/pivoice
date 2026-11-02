// Package rt gives the audio thread realtime priority where the system
// lets it have that, so the kernel runs it the moment its block is due
// instead of whenever its turn comes round.
//
// Only Linux needs asking: Windows' WASAPI threads get Pro Audio priority
// when the stream is opened (portaudio.go), and CoreAudio's callback
// threads are realtime already.
package rt

// Priority is the realtime priority asked for (SCHED_FIFO/SCHED_RR, 1–99),
// or the most the system allows if that's lower. It's under PipeWire's
// own threads (20 through rtkit, 83 and up with realtime limits), so the
// sound server always comes first, and over everything that isn't
// realtime, which is the point.
const Priority = 18
