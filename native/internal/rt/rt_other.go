//go:build !linux

package rt

import "errors"

const Supported = false

func Promote(int) (string, error) { return "", errors.New("not needed here") }

func Tid() int { return 0 }
