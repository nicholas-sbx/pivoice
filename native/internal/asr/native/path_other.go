//go:build !windows

package native

func osPath(p string) string { return p }
