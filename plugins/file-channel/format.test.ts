import { test, expect } from 'bun:test'
import { decodeInbox, encodeOutbox } from './format.ts'

test('decodeInbox: text is the body; jsonl needs an object with a string text (I6/I7)', () => {
  expect(decodeInbox('plain {not parsed}', 'text')).toEqual({ ok: true, type: 'text', body: 'plain {not parsed}' })
  // Extra fields ride through untouched: structure beyond `text` is not the
  // plugin's business, so the body is the re-serialized object (ADR-011).
  expect(decodeInbox('{"text":"hi","priority":5,"nested":{"a":1}}', 'jsonl'))
    .toEqual({ ok: true, type: 'json', body: '{"text":"hi","priority":5,"nested":{"a":1}}' })
  // Each shape carries no injectable body, but for a different reason — and the
  // reason is what reaches the model in the parse-error notice (§7), so assert it
  // rather than the bare `ok`. Asserting only `ok` passes even when every input
  // reports the same wrong cause. `{}` is the one that catches a "text is
  // optional" implementation: it is a valid object with nothing to inject.
  const why = (line: string) => (decodeInbox(line, 'jsonl') as { reason?: string }).reason
  expect(why('not json')).toMatch(/not valid JSON/)
  expect(why('[1,2]')).toMatch(/not a JSON object/)
  expect(why('{"text":5}')).toMatch(/missing required field/)
  expect(why('{}')).toMatch(/missing required field/)
})

test('encodeOutbox: jsonl serializes {text,...fields}; a text target takes a bare line only (I8)', () => {
  expect(encodeOutbox({ text: 'pong', fields: { priority: 5 } }, 'jsonl'))
    .toEqual({ ok: true, line: '{"text":"pong","priority":5}' })
  expect(encodeOutbox({ text: 'pong' }, 'text')).toEqual({ ok: true, line: 'pong' })
  expect(encodeOutbox({ text: 'x', fields: { priority: 5 } }, 'text').ok).toBe(false)
  // Either terminator would frame as two messages downstream, so the serializer
  // rejects rather than splits.
  expect(encodeOutbox({ text: 'a\nb' }, 'text').ok).toBe(false)
  expect(encodeOutbox({ text: 'a\rb' }, 'text').ok).toBe(false)
  // An empty body would be a bare terminator that the reader discards: the call
  // would report success and deliver nothing. jsonl can carry it.
  expect(encodeOutbox({ text: '' }, 'text').ok).toBe(false)
  expect(encodeOutbox({ text: '' }, 'jsonl')).toEqual({ ok: true, line: '{"text":""}' })
})
