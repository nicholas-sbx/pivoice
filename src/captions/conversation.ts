import { palette, traits } from 'blobatar'
import type { CaptionMsg } from './protocol'

export interface CaptionIdentity {
  id: string
  name: string
  joinedAt: number
}

export interface CaptionMessage {
  id: number
  speaker: string
  name: string
  hue: number
  color: string
  text: string
  waiting: boolean
}

interface Phrase {
  key: string
  text: string
  final: boolean
}
interface Turn extends CaptionMessage {
  phrases: Phrase[]
  pendingUntil: number
}
interface Person {
  identity: CaptionIdentity
  hue: number
  color: string
  speaking: boolean
  hasActivity: boolean
  endedAt: number
  turn: Turn | null
  reserved: Turn[]
  phrases: Map<string, Turn>
}

const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
// Bound both a long uninterrupted monologue and the per-speaker phrase index.
const MAX_PHRASES = 40
const MAX_TEXT = 8000

/**
 * A call-local conversation, independent of the expiring seat captions.
 * Speech starts reserve rows before recognition finishes. Updates replace
 * their phrase in place, so a late final cannot move it past an interrupter.
 */
export class CaptionConversation {
  messages: Turn[] = []
  /** Reservations preserve ordering internally; only actual words become rows. */
  get visibleMessages(): CaptionMessage[] {
    return this.messages.filter(t => t.text)
  }
  /** Waiting for a first word belongs in the fixed strip below the messages. */
  get pendingSpeakers(): CaptionIdentity[] {
    return [...this.people.values()]
      .filter(p => p.turn?.waiting && !p.turn.text)
      .map(p => p.identity)
  }
  private people = new Map<string, Person>()
  private nextId = 0
  mergeMs = 10_000
  waitMs = 5000
  keep = 100

  /** Existing people's colours are never reconsidered. Only newcomers choose. */
  roster(members: readonly CaptionIdentity[]) {
    const here = new Set(members.map(m => m.id))
    for (const id of this.people.keys()) {
      if (here.has(id)) continue
      for (const turn of this.messages) if (turn.speaker === id) turn.waiting = false
      this.people.delete(id)
    }
    for (const m of [...members].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))) {
      if (this.people.has(m.id)) continue
      const base = traits(m.name || '?').num('hue', 0, 360)
      const used = [...this.people.values()].map(p => p.hue)
      let hue = base
      let best = -1
      // Prefer their avatar's hue, then the nearest sufficiently distinct hue.
      for (let i = 0; i < 72; i++) {
        const offset = Math.ceil(i / 2) * 5 * (i % 2 ? 1 : -1)
        const candidate = (base + offset + 360) % 360
        const distance = Math.min(360, ...used.map(h => hueDistance(h, candidate)))
        if (distance > best) { hue = candidate; best = distance }
        if (distance >= 24) { hue = candidate; break }
      }
      this.people.set(m.id, {
        identity: { ...m }, hue, color: palette(hue).head ?? '#dbdee1',
        speaking: false, hasActivity: false, endedAt: -Infinity, turn: null, reserved: [], phrases: new Map()
      })
    }
  }

  /** Called on speaking-ring edges, including when there are no words yet. */
  activity(ids: ReadonlySet<string>, now: number) {
    // End everyone who stopped first, so a simultaneous handover is ordered.
    for (const [id, p] of this.people) {
      if (!p.speaking || ids.has(id)) continue
      p.speaking = false
      p.endedAt = now
      if (p.turn) p.turn.pendingUntil = now + this.waitMs
    }
    for (const id of ids) {
      const p = this.people.get(id)
      if (!p || p.speaking) continue
      this.start(p, now)
      p.speaking = true
      p.hasActivity = true
    }
    this.tick(now)
  }

  private start(p: Person, now: number): Turn {
    // A new turn owns the only typing indicator for this person. Late
    // corrections may update older text, but must never light those rows again.
    for (const turn of this.messages) if (turn.speaker === p.identity.id) turn.waiting = false
    const last = this.messages.at(-1)
    // A row reserved by somebody else already counts as an interruption,
    // even if their recogniser hasn't produced its first word yet.
    if (this.mergeMs > 0 && p.turn && p.turn === last && now - p.endedAt <= this.mergeMs && p.turn.phrases.length < MAX_PHRASES && p.turn.text.length < MAX_TEXT) {
      p.turn.waiting = true
      p.turn.pendingUntil = now + this.waitMs
      return p.turn
    }
    const turn: Turn = {
      id: ++this.nextId, speaker: p.identity.id, name: p.identity.name,
      hue: p.hue, color: p.color, text: '', waiting: true,
      phrases: [], pendingUntil: now + this.waitMs
    }
    this.messages.push(turn)
    p.turn = turn
    p.reserved.push(turn)
    this.trim()
    return turn
  }

  /** Only checked, rate-limited, current caption messages enter here. */
  apply(id: string, m: CaptionMsg, now: number) {
    const p = this.people.get(id)
    if (!p) return
    const key = `${m.s}:${m.u}`
    let turn = p.phrases.get(key)
    if (!turn) {
      if (!m.t && !p.turn) return
      // Normally the ring reserved this row. Text can arrive before its next
      // poll, or without a ring (a final-only sender), so it can reserve one too.
      turn = p.reserved.shift() ?? (p.turn
        && (p.hasActivity || (p.turn === this.messages.at(-1) && this.mergeMs > 0 && now - p.endedAt <= this.mergeMs))
        && p.turn.phrases.length < MAX_PHRASES && p.turn.text.length < MAX_TEXT
        ? p.turn : this.start(p, now))
      if (p.reserved[0] === turn) p.reserved.shift()
      p.phrases.set(key, turn)
      turn.phrases.push({ key, text: '', final: false })
    }
    const phrase = turn.phrases.find(f => f.key === key)
    if (!phrase || phrase.final) return
    phrase.text = m.t
    phrase.final = m.f
    turn.text = turn.phrases.map(f => f.text).filter(Boolean).join(' ')
    turn.pendingUntil = now + this.waitMs
    turn.waiting = p.turn === turn && !m.f
    if (!p.speaking && !p.hasActivity) p.endedAt = now
    this.tick(now)
  }

  tick(now: number) {
    for (const turn of this.messages) {
      const p = this.people.get(turn.speaker)
      if (turn.waiting && (!p || p.turn !== turn || (!p.speaking && now >= turn.pendingUntil))) turn.waiting = false
    }
    // Keep blank reservations in order, within the same bounded history, so
    // a slow final-only recogniser can still fill the right row later.
    this.trim()
  }

  private trim() {
    if (this.messages.length > this.keep) this.messages.splice(0, this.messages.length - this.keep)
    const kept = new Set(this.messages)
    for (const p of this.people.values()) {
      for (const [key, turn] of p.phrases) if (!kept.has(turn)) p.phrases.delete(key)
      p.reserved = p.reserved.filter(turn => kept.has(turn))
      if (p.turn && !kept.has(p.turn)) p.turn = null
    }
  }

  clear() {
    this.messages = []
    this.people.clear()
  }
}
