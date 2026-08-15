// Pure line framing for the file channel: bytes in, lines out. No I/O.

const UTF8 = new TextDecoder()

export interface FramedLine { text: string; end: number }   // end = byte offset past the terminator

function isTerminator(b: number): boolean { return b === 0x0a || b === 0x0d }

// A line ends at "\n" or at "\r", each a terminator in its own right, so LF, CR
// and CRLF input all frame with no lookahead: in CRLF the CR ends the line and
// the LF that follows ends an empty one. Empty lines are not messages and are
// dropped (§7) — which is what makes a CRLF split across two reads produce the
// same messages as one read of the same bytes. "\n"/"\r" are ASCII and never land
// inside a multi-byte sequence, so every span sits on a codepoint boundary.
export function frameLines(buf: Uint8Array): { lines: FramedLine[]; consumed: number } {
  const lines: FramedLine[] = []
  let start = 0
  let consumed = 0
  for (let i = 0; i < buf.length; i++) {
    if (!isTerminator(buf[i]!)) continue
    if (i > start) lines.push({ text: UTF8.decode(buf.subarray(start, i)), end: i + 1 })
    consumed = i + 1
    start = i + 1
  }
  return { lines, consumed }
}

// Index of the first terminator, or -1. The reader scans with this and retains
// nothing: only once a terminator is known does it read that one line (§4).
export function firstTerminator(buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i++) if (isTerminator(buf[i]!)) return i
  return -1
}
