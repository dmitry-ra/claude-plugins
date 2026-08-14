// Pure message-format codecs: text <-> jsonl. No I/O, no fs.

export type InboxResult =
  | { ok: true; type: 'text' | 'json'; body: string }
  | { ok: false; reason: string }

export type OutboxResult =
  | { ok: true; line: string }
  | { ok: false; reason: string }

// Decode one inbox line. text: the line is the body. jsonl: the line must be a
// JSON object with a string `text`; the body is the re-serialized object. That
// requirement is the whole of the plugin's validation — application structure is
// the producer's and consumer's business (§8). The id/channel/type identifiers
// are assigned on injection, not read from here.
export function decodeInbox(line: string, format: 'text' | 'jsonl'): InboxResult {
  if (format === 'text') return { ok: true, type: 'text', body: line }
  let obj: unknown
  try { obj = JSON.parse(line) } catch { return { ok: false, reason: 'line is not valid JSON' } }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: 'line is not a JSON object' }
  }
  if (typeof (obj as { text?: unknown }).text !== 'string') {
    return { ok: false, reason: 'missing required field "text"' }
  }
  return { ok: true, type: 'json', body: JSON.stringify(obj) }
}

// Encode outbox/inbox tool arguments: a required `text` plus arbitrary opaque
// structured fields (§11). jsonl: serialize `{text, ...fields}` — always valid
// JSON, the model never writes raw syntax. text: the bare line; any structured
// field is a hard error since a text line carries only the body (§8, §10).
export function encodeOutbox(
  args: { text: string; fields?: Record<string, unknown> },
  format: 'text' | 'jsonl',
): OutboxResult {
  const fields = args.fields ?? {}
  if (format === 'jsonl') return { ok: true, line: JSON.stringify({ text: args.text, ...fields }) }
  if (Object.keys(fields).length > 0) return { ok: false, reason: 'structured fields require a jsonl-format target' }
  // An empty body would be written as a bare terminator, which the reading side
  // discards as an empty line (§7) — the call would report success and deliver
  // nothing. A jsonl target has no such problem: {"text":""} is a real line.
  if (args.text === '') return { ok: false, reason: 'empty text cannot be sent to a text-format target: it would be written as a bare line terminator and discarded on read' }
  // One line = one message: an embedded terminator would frame as N messages
  // downstream. The plugin is the serializer that must emit one well-formed line,
  // so it rejects rather than splits.
  if (/[\n\r]/.test(args.text)) return { ok: false, reason: 'text for a text-format target must not contain a line terminator (\\n or \\r)' }
  return { ok: true, line: args.text }
}
