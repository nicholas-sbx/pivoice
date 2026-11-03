package native

import "golang.org/x/sys/windows"

// osPath: what to hand a library that opens files with narrow (ANSI) paths,
// as Kaldi and sherpa-onnx do on Windows. A path that's all ASCII goes as it
// is; anything else (a user name with an accent in %LocalAppData%) as its
// 8.3 short name, which is ASCII, where the volume has them.
func osPath(p string) string {
	for i := 0; i < len(p); i++ {
		if p[i] >= 0x80 {
			w, err := windows.UTF16PtrFromString(p)
			if err != nil {
				return p
			}
			buf := make([]uint16, 1024)
			n, err := windows.GetShortPathName(w, &buf[0], uint32(len(buf)))
			if err != nil || n == 0 || int(n) > len(buf) {
				return p
			}
			return windows.UTF16ToString(buf[:n])
		}
	}
	return p
}
