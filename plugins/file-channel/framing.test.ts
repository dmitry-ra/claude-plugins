import { test, expect } from 'bun:test'
import { frameLines, firstTerminator } from './framing.ts'

const buf = (s: string) => Buffer.from(s, 'utf8')
const texts = (b: Uint8Array) => frameLines(b).lines.map((l) => l.text)

// One input carries every axis at once: all three terminator conventions (LF, CR,
// CRLF), all three multi-byte widths (é 2B, € 3B, 😀 4B), an empty line, and an
// unterminated tail. Re-framing it from every byte offset then exercises partial
// retention and the CRLF-split-across-reads case on all of them (I1, I2, I3).
// This subsumes a standalone unterminated-tail case: the `cut = 1` iteration
// frames a terminator-free buffer, so emitting a held tail as a line, or
// over-consuming one, fails here (checked by mutating both ways).
const MIXED = 'café\n€1\r\n😀\r\rx\ntail'
const LINES = ['café', '€1', '😀', 'x']

test('every terminator, every width, split at any byte boundary, frames identically (I1/I2/I3)', () => {
  const whole = buf(MIXED)
  expect(texts(whole)).toEqual(LINES)                       // whole-buffer baseline
  for (let cut = 1; cut < whole.length; cut++) {
    const head = frameLines(whole.subarray(0, cut))
    const tail = frameLines(whole.subarray(head.consumed))
    expect([...head.lines, ...tail.lines].map((l) => l.text)).toEqual(LINES)
  }
})

test('firstTerminator finds either terminator, or -1 (I1)', () => {
  expect(firstTerminator(buf('ab\ncd'))).toBe(2)
  expect(firstTerminator(buf('ab\rcd'))).toBe(2)
  expect(firstTerminator(buf('no terminator'))).toBe(-1)
})
