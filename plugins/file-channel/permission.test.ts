import { test, expect } from 'bun:test'
import { parseVerdict, formatRequest } from './permission.ts'

test('parseVerdict: allow/deny with a lowercased id; anything else stays pending (I13)', () => {
  expect(parseVerdict('{"kind":"permission","request_id":"ABCDE","behavior":"allow"}'))
    .toEqual({ ok: true, verdict: { request_id: 'abcde', behavior: 'allow' } })
  expect(parseVerdict('{"kind":"permission","request_id":"mnopq","behavior":"deny"}'))
    .toEqual({ ok: true, verdict: { request_id: 'mnopq', behavior: 'deny' } })
  // Every malformed shape fails closed: none of these may ever produce an allow.
  for (const line of [
    'not json',
    '{"kind":"message","text":"hi"}',                                    // wrong kind
    '{"kind":"permission","behavior":"allow"}',                          // no request_id
    '{"kind":"permission","request_id":"abcde","behavior":"maybe"}',     // behavior not exactly allow|deny
  ]) expect(parseVerdict(line).ok).toBe(false)
})

test('formatRequest: full record, or one elided to fit the byte bound (I21)', () => {
  const r = { request_id: 'abcde', tool: 'Bash', description: 'rm -rf /tmp/x', input_preview: 'rm -rf /tmp/x' }
  expect(formatRequest(r))
    .toBe('{"kind":"permission_request","request_id":"abcde","tool":"Bash","description":"rm -rf /tmp/x","input_preview":"rm -rf /tmp/x"}')

  // Oversized fields are elided rather than the write refused: a request the
  // operator cannot see is a request that can never be verdicted.
  const line = formatRequest({ ...r, description: 'd'.repeat(500), input_preview: 'p'.repeat(500) }, 200)
  expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(200)
  const o = JSON.parse(line)
  expect(o.request_id).toBe('abcde')   // identity kept intact
  expect(o.tool).toBe('Bash')
  expect(o.truncated).toBe(true)
})
