// Structured plugin.log sink (jsonl) with a stderr last-resort fallback (§17).
// Effectful: appends to <root>/plugin.log. One JSON object per line, level-gated
// by FILE_CHANNEL_LOG_LEVEL. Concurrent instances share this file, so each line
// is kept within MAX_ATOMIC_APPEND by eliding oversized detail rather than
// tearing. stderr is used only when the file cannot be relied on.

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { EOL } from 'node:os'
import { MAX_ATOMIC_APPEND } from './registry.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// §17 event taxonomy.
export type LogEvent =
  | 'start' | 'lock_acquired' | 'lock_contended' | 'channel_discovered'
  | 'registry_invalid' | 'message_injected' | 'reply_written' | 'send_written'
  | 'parse_error' | 'inbox_truncated' | 'permission_request'
  | 'permission_verdict' | 'error'

export interface LogEntry { level: LogLevel; event: LogEvent; channel?: string; detail?: Record<string, unknown> }
export type Log = (entry: LogEntry) => void

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const EOL_LEN = Buffer.byteLength(EOL, 'utf8')

export function parseLevel(raw: string | undefined): LogLevel {
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

function fit(rec: Record<string, unknown>): string {
  const budget = MAX_ATOMIC_APPEND - EOL_LEN
  let line = JSON.stringify(rec)
  if (Buffer.byteLength(line, 'utf8') <= budget) return line
  line = JSON.stringify({ ...rec, detail: { truncated: true } })   // oversized detail elided (§17)
  if (Buffer.byteLength(line, 'utf8') <= budget) return line
  return JSON.stringify({ ts: rec.ts, level: rec.level, event: rec.event, truncated: true })
}

function toStderr(entry: LogEntry): void {
  try { process.stderr.write(`file channel: ${entry.event} ${JSON.stringify(entry.detail ?? {})}\n`) } catch {}
}

// Real sink: append to <root>/plugin.log; on any write failure (file removed and
// unrecreatable, root gone unwritable) fall back to stderr for that line. A
// removed file is recreated by appendFileSync's implicit open with 'a'.
export function makeLog(root: string, level: LogLevel): Log {
  const path = join(root, 'plugin.log')
  const threshold = ORDER[level]
  return (entry) => {
    if (ORDER[entry.level] < threshold) return
    // pid: §17 blesses several instances sharing one root, and without it their
    // lines interleave indistinguishably — you cannot tell which session injected
    // a message, lost a lock, or failed.
    const line = fit({ ts: new Date().toISOString(), pid: process.pid, ...entry })
    try { appendFileSync(path, line + EOL) } catch { toStderr(entry) }
  }
}

// Degraded sink for an unwritable/uncreatable root (§17): everything to stderr.
export function makeStderrLog(level: LogLevel): Log {
  const threshold = ORDER[level]
  return (entry) => { if (ORDER[entry.level] >= threshold) toStderr(entry) }
}
