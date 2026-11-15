# Canary 180M Flash captions

Select **Canary 180M Flash** in Voice Settings → Captions, then choose
English, German, Spanish or French. It transcribes into that same language
with punctuation and capitals. There is no automatic language detection or
translation mode in this integration. English is the default, including for
preferences saved before the language setting existed.

Like Parakeet, Canary recognises a phrase at a time. Live words re-read the
phrase at the configured interval; re-reads are skipped when audio is
backed up. The existing longest-phrase setting bounds the audio (15 seconds
by default, at most 30), below NVIDIA's 40-second input limit. A language
change restarts the recogniser, as a model change does.

**Suppress unstable output** is a Canary-only toggle, **off by default**.
Off keeps the generated text, including repetitions and text produced before
the decoding limit. On withholds unfinished results that reach that limit;
in the browser it also abandons repeating live previews early. This can omit
spoken words. The decoding limit always bounds work in either mode. The
setting is saved and changes apply to the next read without reloading the model.

## Model and quantization research

The requested model is **NVIDIA Canary 180M Flash**, not Canary 1B Flash.
[NVIDIA's model card](https://huggingface.co/nvidia/canary-180m-flash)
describes its four supported languages, explicit language hints,
punctuation/capitalization controls, and CC BY 4.0 license.

[T3 Code's catalog at `2b83dd0`](https://github.com/pingdotgg/t3code/blob/2b83dd0969f40be89311ad5394da49a4d951ac6e/apps/server/src/speech/catalog.json)
uses `handy-computer/canary-180m-flash-gguf`, revision
`46b86384d1db59108d6e060a0fc00924cb58499f`, file
`canary-180m-flash-Q8_0.gguf` (218,447,648 bytes, SHA-256
`f942ab746040b531a29ab78ca3afc8dc9564efd8e4c942b5541e53644be9c408`).
That is an 8-bit GGUF conversion for transcribe.cpp.

PiVoice uses the **same NVIDIA model with an INT8 ONNX conversion**, from
[k2-fsa's Canary export](https://github.com/k2-fsa/sherpa-onnx/blob/78022953788ff05f62f4a733c6268a5689efeb86/scripts/nemo/canary/export_onnx_180m_flash.py).
Both encoder and decoder weights are quantized. This is a different
conversion and quantization scheme from GGUF Q8_0, not an identical weight
file or a promise of identical transcripts or benchmark scores. It lets
both platforms use the existing CPU-only ONNX infrastructure and exactly
the same pinned files; it does not require a second native runtime or an
unmaintained browser GGUF port.

The source is the
[sherpa-onnx INT8 release archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2).
The catalog pins each encoder, decoder and vocabulary file by SHA-256 and
size. Packaging produces approximately **148 MB** of download parts (207 MB
uncompressed). Browser and app use the existing consent, integrity checks,
cache, progress display, and removal flow. Attribution appears beside the
model in settings.

## Runtimes

The browser's dedicated worker uses ONNX Runtime Web's single-threaded WASM
CPU backend. It computes 128-bin NeMo log-mel features, normalizes each bin
over the phrase, and transposes them to this encoder's frame-major layout.
The decoder gets the nine-token Canary task prompt, with matching source
and target languages, punctuation enabled, and timestamps disabled. It
advances the token position and six memory tensors at each greedy decoding
step. Every re-read starts fresh, and releases its tensors on completion
or error. With suppression enabled, only EOS-completed reads are emitted:
hitting the duration-based token guard withholds unfinished output. Repeating
token blocks in a live preview are abandoned early until more speech arrives;
final reads keep legitimate repetitions. With suppression off, reads can return
text at the token limit. Control tokens are excluded from captions. A runtime
failure becomes a visible model error and stops further input to that worker.

The desktop uses sherpa-onnx 1.13.8's existing pinned CPU libraries in the
caption helper process, with its Canary encoder/decoder configuration.
The source and target language hints match. When suppression is enabled, results
that reach sherpa-onnx's duration-based token guard are withheld here too.
Its libraries, model work and
memory stay out of the audio process. Both platforms continue to receive
only the gated mic segments, through the existing 48 → 16 kHz decimator.
This export does not expose Canary's experimental word timestamps.

## Checks

```sh
npm test
npm run typecheck
npm run typecheck:worker
npm run build
npm run captions:models -- --model canary-180m-flash
# With `npm run dev` running, and Playwright installed:
npm run e2e:canary
npm run e2e:captions

cd native
go test -race ./internal/asr/... ./internal/proto
PIVOICE_ASR_LIVE=1 PIVOICE_SITE=http://localhost:5173/ \
  go test -race -v -run '^TestLiveRecognisers/canary-180m-flash$' ./internal/asr
```

The focused browser check downloads and verifies the real model in a fresh
browser, obtains live and final transcripts from the speech fixture,
repeats a phrase to check decoder reset, and creates another worker to
check cached loading. It tests both suppression settings and the settings
toggle's default, persistence and model visibility. It runs in the site PR
workflow. The general captions
end-to-end check also includes Canary in the browser and, when built, the
desktop app, sending captions to another room member.

Unit checks cover all four language prompts, input layout, token positions,
EOS as the first result, control-token filtering, token bounds, reset after
failure, preference migration, suppression changes during model loading,
live suppression changes, and model-catalog parity. Native branch CI
also builds the new C configuration on Linux and Windows.
