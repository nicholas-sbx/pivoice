//go:build nowebview || !(linux || windows)

package overlay

import (
	"errors"
	"unsafe"

	"github.com/nicholas-sbx/pivoice/native/internal/proto"
)

// No overlay here: no window at all (nowebview), or macOS, which isn't released yet.
type window struct{}

func supported() bool { return false }

func openWindow(*Overlay) (*window, error) { return nil, errors.New("no overlay on this platform") }

func (*window) place(proto.OverlayPlace) {}
func (*window) eval(string)              {}
func (*window) close()                   {}

func monitors(unsafe.Pointer) proto.Monitors { return proto.Monitors{} }
