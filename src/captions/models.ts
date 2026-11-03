import catalog from './models.json'

/**
 * The speech models captions can use, and how one gets from the site to a
 * recogniser: the same files, pinned by hash, whether a browser fetches
 * them (worker.ts) or the app does (native/internal/asr, with its own copy
 * of models.json, checked to match).
 *
 * Neither is shipped with anything: each is fetched the first time it's
 * wanted (scripts/captions-models.mjs puts them on the site, in parts of at
 * most 24 MiB), checked file by file against the SHA-256 in models.json,
 * and kept: in Cache Storage in a browser, in the user's cache folder in
 * the app.
 */

export type Engine = 'vosk' | 'nemo-ctc'
export type ModelId = keyof typeof catalog

export interface CatalogModel {
  id: ModelId
  engine: Engine
  title: string
  detail: string
  /** Who made it and its licence, to show beside it. */
  credit: string
  url: string
  /** Roughly what downloading it costs, to say so before asking (the manifest has it exactly). */
  downloadMB: number
  /**
   * False: the app's alone. Vosk large is: vosk-browser's WebAssembly reads
   * it at 3-5x real time where the app reads it at 0.25x (README, "Live
   * captions"), so in a browser it would only ever fall behind.
   */
  browser?: boolean
  /** path, sha256, size. */
  files: [string, string, number][]
}

export const MODELS: CatalogModel[] = (Object.keys(catalog) as ModelId[]).map(id => ({ id, ...(catalog[id] as unknown as Omit<CatalogModel, 'id'>) }))
export const DEFAULT_MODEL: ModelId = 'vosk-small-en'

export function modelOf(id: string): CatalogModel | null {
  return MODELS.find(m => m.id === id) ?? null
}

/** Whether a browser runs it (the rest are the app's alone). */
export function inBrowser(m: CatalogModel): boolean {
  return m.browser !== false
}

/**
 * What a browser runs for this choice: it, or the default for one only the
 * app runs. The choice itself is kept: the app's page can share a browser's
 * storage (the headless app's does), and it's still the app's choice there.
 */
export function browserModel(id: ModelId): ModelId {
  const m = modelOf(id)
  return m && inBrowser(m) ? id : DEFAULT_MODEL
}

export function isModelId(id: unknown): id is ModelId {
  return typeof id === 'string' && MODELS.some(m => m.id === id)
}

/** How a file is laid out on the site (scripts/captions-models.mjs writes it). */
export interface ManifestFile {
  path: string
  size: number
  sha256: string
  encoding: 'gzip' | 'identity'
  parts: { name: string; size: number }[]
}

export interface Manifest {
  v: 1
  id: string
  files: ManifestFile[]
}

/** What to download, from a manifest: only the files the catalog pins, laid out sensibly. Null if it isn't usable. */
export function checkManifest(model: CatalogModel, raw: unknown): Manifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<Manifest>
  if (m.v !== 1 || m.id !== model.id || !Array.isArray(m.files) || m.files.length !== model.files.length) return null
  const ok = model.files.every(([path, sha, size], i) => {
    const f = m.files![i]
    return (
      f &&
      f.path === path &&
      f.sha256 === sha &&
      f.size === size &&
      (f.encoding === 'gzip' || f.encoding === 'identity') &&
      Array.isArray(f.parts) &&
      f.parts.length > 0 &&
      f.parts.length <= 64 &&
      f.parts.every(
        (p, n) => p && p.name === `${path}${f.encoding === 'gzip' ? '.gz' : ''}.${n}` && Number.isInteger(p.size) && p.size > 0 && p.size <= 32 * 1024 * 1024
      )
    )
  })
  return ok ? (m as Manifest) : null
}

export function downloadBytes(m: Manifest): number {
  return m.files.reduce((n, f) => n + f.parts.reduce((k, p) => k + p.size, 0), 0)
}

// ---- the cache ------------------------------------------------------------------

const CACHE = 'pv-captions-v1'

/** Where a checked file is kept: its hash is in the key, so nothing else can ever be found under it. */
function cacheKey(base: string, model: CatalogModel, path: string, sha: string): string {
  return new URL(`${model.id}/${path}?sha256=${sha}`, base).href
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE)
  } catch {
    return null
  }
}

/** Which of the model's files are already here. */
export async function cachedFiles(base: string, model: CatalogModel): Promise<Set<string>> {
  const cache = await openCache()
  const have = new Set<string>()
  if (!cache) return have
  for (const [path, sha] of model.files) if (await cache.match(cacheKey(base, model, path, sha))) have.add(path)
  return have
}

/** Drop a model's files (and anything left from older versions of them). */
export async function forgetModel(base: string, model: CatalogModel) {
  const cache = await openCache()
  if (!cache) return
  const prefix = new URL(`${model.id}/`, base).href
  for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req)
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
  let s = ''
  for (const b of d) s += b.toString(16).padStart(2, '0')
  return s
}

/** A file's bytes from the cache, checked again (it's about to be parsed by C++ in WebAssembly). */
export async function readCached(base: string, model: CatalogModel, path: string, sha: string): Promise<ArrayBuffer | null> {
  const cache = await openCache()
  const res = await cache?.match(cacheKey(base, model, path, sha))
  if (!res) return null
  const buf = await res.arrayBuffer()
  if ((await sha256Hex(buf)) === sha) return buf
  await cache!.delete(cacheKey(base, model, path, sha))
  return null
}

/**
 * Download one file: its parts in order, gunzipped if they're gzip,
 * checked against the pinned hash, then kept. `progress` gets the bytes
 * downloaded so far of this file.
 */
export async function downloadFile(base: string, model: CatalogModel, f: ManifestFile, progress: (bytes: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const dir = new URL(`${model.id}/`, base)
  let got = 0
  // The parts, one after another, as one stream.
  const parts = f.parts
  let i = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const joined = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        if (!reader) {
          if (i === parts.length) return ctrl.close()
          const p = parts[i++]
          const res = await fetch(new URL(p.name, dir), { signal, cache: 'no-store' })
          if (!res.ok || !res.body) throw new Error(`${p.name}: HTTP ${res.status}`)
          reader = res.body.getReader()
        }
        const { done, value } = await reader.read()
        if (done) {
          reader = null
          continue
        }
        got += value.length
        progress(got)
        return ctrl.enqueue(value)
      }
    },
    cancel() {
      void reader?.cancel()
    }
  })
  const body = f.encoding === 'gzip' ? joined.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : joined
  const buf = await new Response(body).arrayBuffer()
  if (buf.byteLength !== f.size || (await sha256Hex(buf)) !== f.sha256) throw new Error(`${f.path} isn't the file it should be`)
  const cache = await openCache()
  if (cache) {
    try {
      await cache.put(cacheKey(base, model, f.path, f.sha256), new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }))
    } catch {
      /* out of space or storage blocked: used this time, fetched again next time */
    }
  }
  return buf
}
