// Pure permission control-plane codecs: verdict parsing, request formatting.
// Control records are always jsonl (§3, §15). No I/O.

export interface Verdict { request_id: string; behavior: 'allow' | 'deny' }

export type VerdictResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; reason: string }

// Parse one control/verdicts.jsonl line. A malformed verdict is fail-closed: it
// never resolves an open id, the prompt stays pending (§15). request_id (five
// lowercase letters without `l`) is lowercased before matching.
export function parseVerdict(line: string): VerdictResult {
  let o: unknown
  try { o = JSON.parse(line) } catch { return { ok: false, reason: 'line is not valid JSON' } }
  const r = o as { kind?: unknown; request_id?: unknown; behavior?: unknown }
  if (!r || typeof r !== 'object') return { ok: false, reason: 'verdict is not a JSON object' }
  if (r.kind !== 'permission') return { ok: false, reason: 'kind is not "permission"' }
  if (typeof r.request_id !== 'string') return { ok: false, reason: 'missing request_id' }
  if (r.behavior !== 'allow' && r.behavior !== 'deny') return { ok: false, reason: 'behavior is not exactly allow|deny' }
  return { ok: true, verdict: { request_id: r.request_id.toLowerCase(), behavior: r.behavior } }
}

interface Req { request_id: string; tool: string; description: string; input_preview: string }

// Render a control/requests.jsonl line. When maxBytes is given and the full
// record exceeds it, description/input_preview are elided (request_id and tool
// kept intact) and the record is marked truncated:true, so the line + EOL stays
// within MAX_ATOMIC_APPEND and is never torn — leaving the request always
// verdictable (§14/I21).
export function formatRequest(r: Req, maxBytes?: number): string {
  const full = { kind: 'permission_request', request_id: r.request_id, tool: r.tool, description: r.description, input_preview: r.input_preview }
  const line = JSON.stringify(full)
  if (maxBytes === undefined || Buffer.byteLength(line, 'utf8') <= maxBytes) return line
  let desc = r.description, prev = r.input_preview
  for (;;) {
    const rec = { kind: 'permission_request', request_id: r.request_id, tool: r.tool, description: desc, input_preview: prev, truncated: true }
    const out = JSON.stringify(rec)
    if (Buffer.byteLength(out, 'utf8') <= maxBytes) return out
    if (prev.length) prev = prev.slice(0, prev.length >> 1)
    else if (desc.length) desc = desc.slice(0, desc.length >> 1)
    else return out   // request_id+tool alone exceed the budget: emit anyway, one untorn line
  }
}
