// Channel registry (effectful): enumerates root subdirectories and channels.json
// targets, derives each channel's formats from the files present in its
// directory, and enforces id, path, and format collisions (§2, §3).

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Log } from './log.ts'

// Per-platform atomic-append bound (§7). It governs only the two files written
// by more than one writer by design — plugin.log and control/requests.jsonl —
// and is never an acceptance policy for inbox, reply, or send lines.
export const MAX_ATOMIC_APPEND = process.platform === 'win32' ? 65536 : 1048576

export type Format = 'text' | 'jsonl'
export type Role = 'reader' | 'target'

const EXT: Record<Format, string> = { text: 'txt', jsonl: 'jsonl' }

export interface Channel { path: string; format: Format }

export interface ChannelDesc {
  id: string
  dir: string
  role: Role
  inbox: Channel | null      // null when the directory declares no inbox file
  outbox: Channel | null
}

// Which file of a role the directory declares. Both extensions present is a
// startup error: the format would be ambiguous and no config exists to break the
// tie (§3).
function detect(id: string, dir: string, role: 'inbox' | 'outbox'): Channel | null {
  const txt = join(dir, `${role}.txt`)
  const jsonl = join(dir, `${role}.jsonl`)
  const hasTxt = existsSync(txt)
  const hasJsonl = existsSync(jsonl)
  if (hasTxt && hasJsonl) {
    throw new Error(`channel "${id}": both ${role}.txt and ${role}.jsonl exist; the format is ambiguous`)
  }
  if (hasTxt) return { path: txt, format: 'text' }
  if (hasJsonl) return { path: jsonl, format: 'jsonl' }
  return null
}

// Resolve where a write to this role goes. An existing file wins; otherwise the
// file is created in the format the channel already declares through its other
// file, or text when it declares none (§10). This is the only data file the
// plugin creates.
export function writeTarget(desc: ChannelDesc, role: 'inbox' | 'outbox'): Channel {
  const existing = role === 'inbox' ? desc.inbox : desc.outbox
  if (existing) return existing
  const declared = (role === 'inbox' ? desc.outbox?.format : desc.inbox?.format) ?? 'text'
  return { path: join(desc.dir, `${role}.${EXT[declared]}`), format: declared }
}

// The read position lives beside the file it describes, so replacing an inbox
// with the other format yields a state of its own rather than a stale offset (§3).
export function statePathFor(inboxPath: string): string { return `${inboxPath}.state` }

export interface TargetEntry { id: string; path: string }

// Parse <root>/channels.json. Malformed -> registry_invalid + ignore (continue
// with root subdirs). A missing target path is skipped + warned (§2).
export function loadChannelsJson(root: string, log: Log): TargetEntry[] {
  const path = join(root, 'channels.json')
  if (!existsSync(path)) return []
  let o: any
  try { o = JSON.parse(readFileSync(path, 'utf8')) } catch {
    log({ level: 'warn', event: 'registry_invalid', detail: { reason: 'channels.json is not valid JSON' } })
    return []
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    log({ level: 'warn', event: 'registry_invalid', detail: { reason: 'channels.json is not a JSON object' } })
    return []
  }
  const out: TargetEntry[] = []
  for (const [id, p] of Object.entries(o)) {
    if (typeof p !== 'string') { log({ level: 'warn', event: 'registry_invalid', detail: { reason: 'channels.json value is not a string path', id } }); continue }
    let isDir = false
    try { isDir = statSync(p).isDirectory() } catch { isDir = false }
    if (!isDir) { log({ level: 'warn', event: 'registry_invalid', detail: { reason: 'channels.json path missing or not a directory; skipped', id, path: p } }); continue }
    out.push({ id, path: p })
  }
  return out
}

// Enumerate root subdirectories as reader channels plus channels.json targets.
// A conflict — a duplicate id, two ids on one physical directory, or an ambiguous
// format — excludes that one channel and nothing else: voiding the whole registry
// would let a stray file in an unrelated directory take down every channel, and
// from inside the session that is indistinguishable from the channels not existing.
export function buildRegistry(root: string, log: Log): Map<string, ChannelDesc> {
  const reg = new Map<string, ChannelDesc>()
  const byPath = new Map<string, string>()   // canonical dir -> id, for path-collision detection

  const add = (id: string, dir: string, role: Role) => {
    try {
      if (reg.has(id)) throw new Error(`id "${id}" is already registered`)
      // Canonical, symlinks resolved: two ids reaching one physical directory would
      // share an inbox and a state file and corrupt each other's counters, and a
      // lexical compare does not see that through a symlink (§2).
      let rp: string
      try { rp = realpathSync(dir) } catch { rp = resolve(dir) }
      const other = byPath.get(rp)
      if (other) throw new Error(`path collides with channel "${other}" (${rp})`)
      // detect() may throw; nothing is registered until it has succeeded, so a
      // rejected channel reserves neither its id nor its path.
      const desc: ChannelDesc = { id, dir, role, inbox: detect(id, dir, 'inbox'), outbox: detect(id, dir, 'outbox') }
      byPath.set(rp, id)
      reg.set(id, desc)
      log({
        level: 'info', event: 'channel_discovered', channel: id,
        detail: { role, dir, inbox: desc.inbox?.format ?? null, outbox: desc.outbox?.format ?? null },
      })
    } catch (err) {
      log({
        level: 'error', event: 'error', channel: id,
        detail: { reason: 'channel skipped', dir, message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  let entries: { name: string; isDir: boolean }[] = []
  try { entries = readdirSync(root, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() })) } catch {}
  // Sorted, not readdir order: which channel wins a path collision, and which ones
  // a setup failure lands on, must not change between restarts.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) if (e.isDir) add(e.name, join(root, e.name), 'reader')
  for (const t of loadChannelsJson(root, log)) add(t.id, t.path, 'target')
  return reg
}
