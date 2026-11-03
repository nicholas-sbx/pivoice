// The speech models live captions can use (src/captions/models.json: Vosk's
// small English model, NVIDIA's Parakeet 110M and its streaming
// FastConformer), fetched from where
// they're published, checked file by file against the hashes there, and
// written out ready to serve from the site:
//
//   public/captions/<model>/manifest.json
//   public/captions/<model>/<file>[.gz].<n>    the file, gzipped if that saves 10%, in parts
//
// Parts, because Workers static assets take files of 25 MiB at most and
// Parakeet's weights are 132 MB. Browsers fetch the parts and put them back
// together (src/captions/fetchModel.ts); so does the app, into its cache
// folder (native/internal/asr), and both check every file against the same
// pinned hashes before anything reads it.
//
//   node scripts/captions-models.mjs                  # every model, into public/captions/
//   node scripts/captions-models.mjs --model ID       # just that one
//   node scripts/captions-models.mjs --archive FILE   # from a .zip/.tar.gz/.tar.bz2 you already have (with --model)
//   node scripts/captions-models.mjs --out DIR        # somewhere else
//
// They're too big for the repo, so CI runs this before building the site
// (release-web.yml); run it once yourself before `npm run dev` to try
// captions locally. Running it again when it's all there does nothing.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const MODELS = JSON.parse(readFileSync(join(ROOT, 'src/captions/models.json'), 'utf8'))
/** The biggest part (Workers static assets allow 25 MiB a file). */
export const PART_BYTES = 24 * 1024 * 1024
const MANIFEST_VERSION = 1

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

// ---- reading archives: just enough of zip and tar for a model's files ----

/** Every regular file in a zip, by name. Stored and deflated entries only (all a model has). */
function unzip(buf) {
  const out = new Map()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory')
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, inflateRawSync(data))
  }
  return out
}

/** Every regular file in a tar (ustar, and GNU long names), by name. */
function untar(buf) {
  const out = new Map()
  let longName = ''
  for (let p = 0; p + 512 <= buf.length; ) {
    const header = buf.subarray(p, p + 512)
    if (header.every(b => b === 0)) break
    const field = (at, len) => header.toString('utf8', at, at + len).replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = field(345, 155)
    const name = longName || (prefix ? prefix + '/' : '') + field(0, 100)
    longName = ''
    const data = buf.subarray(p + 512, p + 512 + size)
    p += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '')
    else if (type === '0' || type === '\0') out.set(name, data)
  }
  return out
}

/** bzip2 isn't in Node: the system's (every Linux and macOS has it, and Git Bash on Windows). */
function bunzip(buf) {
  const r = spawnSync('bzip2', ['-dc'], { input: buf, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`bzip2: ${r.error?.message ?? r.stderr.toString()}`)
  return r.stdout
}

function filesOf(archive) {
  let all
  if (archive[0] === 0x50 && archive[1] === 0x4b) all = unzip(archive)
  else if (archive[0] === 0x1f && archive[1] === 0x8b) all = untar(gunzipSync(archive))
  else if (archive[0] === 0x42 && archive[1] === 0x5a && archive[2] === 0x68) all = untar(bunzip(archive))
  else all = untar(archive)
  // Whatever folder the model's in, and without macOS's ._ shadows.
  const found = new Map()
  for (const [name, data] of all) {
    const rel = name.replace(/^\.?\/?[^/]+\//, '')
    if (!rel.split('/').some(part => part.startsWith('._'))) found.set(rel, data)
  }
  return found
}

/** The model's own files out of an archive, each checked; throws on anything missing or different. */
function pick(model, files) {
  const out = new Map()
  for (const [path, hash, size] of model.files) {
    const data = files.get(path)
    if (!data) throw new Error(`${path} isn't in it`)
    if (data.length !== size || sha256(data) !== hash) throw new Error(`${path} isn't the file it should be (sha256 ${sha256(data)}, ${data.length} bytes)`)
    out.set(path, data)
  }
  return out
}

// ---- writing it out ------------------------------------------------------------

function upToDate(id, out) {
  try {
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    const pins = MODELS[id].files
    return (
      m.v === MANIFEST_VERSION &&
      m.id === id &&
      m.files.length === pins.length &&
      m.files.every((f, i) => f.path === pins[i][0] && f.sha256 === pins[i][1] && f.parts.every(p => existsSync(join(out, p.name))))
    )
  } catch {
    return false
  }
}

function write(id, files, out) {
  rmSync(out, { recursive: true, force: true })
  const manifest = { v: MANIFEST_VERSION, id, files: [] }
  for (const [path, hash, size] of MODELS[id].files) {
    const data = files.get(path)
    const gz = gzipSync(data, { level: 9 })
    const zipped = gz.length < data.length * 0.9
    const body = zipped ? gz : data
    const base = path + (zipped ? '.gz' : '')
    const parts = []
    for (let at = 0, n = 0; at < body.length; at += PART_BYTES, n++) {
      const chunk = body.subarray(at, at + PART_BYTES)
      const name = `${base}.${n}`
      mkdirSync(dirname(join(out, name)), { recursive: true })
      writeFileSync(join(out, name), chunk)
      parts.push({ name, size: chunk.length })
    }
    manifest.files.push({ path, size, sha256: hash, encoding: zipped ? 'gzip' : 'identity', parts })
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const total = manifest.files.reduce((n, f) => n + f.parts.reduce((m, p) => m + p.size, 0), 0)
  console.log(`captions: ${id} in ${out} (${(total / 1e6).toFixed(1)} MB to download)`)
}

async function fetchArchive(id) {
  for (const url of MODELS[id].sources) {
    try {
      console.log(`captions: ${id}: fetching ${url}`)
      const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Checked here too, so a bad copy moves on to the next source.
      return pick(MODELS[id], filesOf(Buffer.from(await res.arrayBuffer())))
    } catch (e) {
      console.warn(`captions: ${url}: ${e.message}`)
    }
  }
  throw new Error(`captions: couldn't get ${id} from anywhere`)
}

async function main() {
  const args = process.argv.slice(2)
  const arg = name => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const only = arg('--model')
  if (only && !MODELS[only]) throw new Error(`no model ${only} (there's ${Object.keys(MODELS).join(', ')})`)
  const archive = arg('--archive')
  if (archive && !only) throw new Error('--archive needs --model')
  for (const id of only ? [only] : Object.keys(MODELS)) {
    const out = arg('--out') ? join(arg('--out'), id) : join(ROOT, 'public', 'captions', id)
    if (upToDate(id, out)) {
      console.log(`captions: ${id} already in ${out}`)
      continue
    }
    write(id, archive ? pick(MODELS[id], filesOf(readFileSync(archive))) : await fetchArchive(id), out)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => {
    console.error(e.message)
    process.exit(1)
  })
}
