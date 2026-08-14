import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'fs'
import { tmpdir, EOL } from 'os'
import { join } from 'path'

// Channels are root subdirectories enumerated at startup and declared by the
// files they hold, so a test creates the directory AND its inbox before spawning.
// A directory with no inbox file is write-only for that session (§13).
function mkRoot(): string { return mkdtempSync(join(tmpdir(), 'fc-test-')) }
function mkChannel(root: string, id: string, files: string[] = []): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}

function spawn(root: string, env: Record<string, string> = {}, stdout: 'pipe' | 'ignore' = 'ignore') {
  return Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    env: { ...process.env, FILE_CHANNEL_ROOT: root, FILE_CHANNEL_POLL_MS: '150', ...env },
    stdin: 'pipe', stdout, stderr: 'ignore',
  })
}

function driver(proc: Bun.Subprocess) {
  const send = (o: object) => proc.stdin.write(JSON.stringify(o) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return send
}

const call = (id: number, name: string, args: object) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

async function poll<T>(fn: () => T | null, tries = 100): Promise<T | null> {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v != null) return v; await Bun.sleep(50) }
  return null
}
const readJson = (p: string, ok: (o: any) => boolean) => () => {
  if (!existsSync(p)) return null
  try { const o = JSON.parse(readFileSync(p, 'utf8')); return ok(o) ? o : null } catch { return null }
}
const readNonEmpty = (p: string) => () => { const c = existsSync(p) ? readFileSync(p, 'utf8') : ''; return c ? c : null }
const injections = (out: string) => (out.match(/"method":"notifications\/claude\/channel"/g) || []).length
// The tool-error text a given call answered with, so a rejection is asserted
// against the input that caused it rather than against a count of rejections.
function errorFor(out: string, id: number): string {
  for (const line of out.split('\n')) {
    try {
      const o = JSON.parse(line)
      // The message body only: the envelope carries "type":"text" on every
      // response, so matching against the whole record would pass on anything.
      if (o.id === id) return o.result?.isError ? String(o.result.content?.[0]?.text) : `<not an error: ${line}>`
    } catch {}
  }
  return `<no response for id ${id}>`
}
function firstInjection(out: string): any {
  for (const line of out.split('\n')) {
    try { const o = JSON.parse(line); if (o.method === 'notifications/claude/channel') return o.params } catch {}
  }
  return null
}

test('mixed terminators, an empty line and a partial tail: ids and offset track the file (I1/I2/I3/I9)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const inbox = join(dir, 'inbox.txt'); const state = join(dir, 'inbox.txt.state')
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(state, (o) => o.read_offset === 0))       // server up, state created
  appendFileSync(inbox, 'a\n\nb\r\nc\rd')                       // 9 bytes: LF, empty, CRLF, CR, then "d" unterminated
  const first = await poll(readJson(state, (o) => o.message_id === 3))
  appendFileSync(inbox, '\n')                                   // terminate "d"
  const second = await poll(readJson(state, (o) => o.message_id === 4))
  await Bun.sleep(200); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect(first).toEqual({ read_offset: 8, message_id: 3 })      // empty line consumed but not injected; "d" held
  expect(second).toEqual({ read_offset: 10, message_id: 4 })
  expect(injections(out)).toBe(4)
}, 15000)

// Separate from the framing test above, where these were the suite's only checks
// of I10 and I19 and sat behind its assertions: a framing regression retired both
// without anything saying so.
test('an injection carries exactly the plugin-owned meta, and the state file is never torn (I10/I19)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const state = join(dir, 'inbox.txt.state')
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(state, (o) => o.read_offset === 0))
  appendFileSync(join(dir, 'inbox.txt'), 'a\n')
  await poll(readJson(state, (o) => o.message_id === 1))
  await Bun.sleep(200); proc.kill()
  const p = firstInjection(await new Response(proc.stdout).text())
  expect(p.content).toBe('a')
  // Exactly these three keys: `source` is the harness's to prepend, and the frozen
  // key set is what enforces I10 — a meta key containing a hyphen is dropped by the
  // harness silently, so any key added here must stay within [A-Za-z0-9_].
  expect(p.meta).toEqual({ channel: 'main', id: '1', type: 'text' })
  expect(existsSync(state + '.tmp')).toBe(false)   // temp+rename leaves no residue (I19)
}, 15000)

test('a restart resumes from the persisted state without replaying (I5/I9)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main')
  const inbox = join(dir, 'inbox.txt'); const state = join(dir, 'inbox.txt.state')
  writeFileSync(inbox, 'old\n')
  writeFileSync(state, JSON.stringify({ read_offset: 4, message_id: 1 }))
  const proc = spawn(root, {}, 'pipe')
  await Bun.sleep(500)
  appendFileSync(inbox, 'new\n')
  const s = await poll(readJson(state, (o) => o.read_offset === 8))
  await Bun.sleep(200); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect(s).toEqual({ read_offset: 8, message_id: 2 })
  expect(out).toContain('new')
  expect(out).not.toContain('old')
}, 15000)

test('jsonl inbox: an object injects type=json, a bad line is a parse_error notice with no id (I7)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.jsonl'])
  const inbox = join(dir, 'inbox.jsonl'); const state = join(dir, 'inbox.jsonl.state')
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(state, (o) => o.read_offset === 0))
  const batch = '{"text":"hi","priority":5}\n' + 'not json\n'
  appendFileSync(inbox, batch)
  const s = await poll(readJson(state, (o) => o.read_offset === Buffer.byteLength(batch)))
  await Bun.sleep(200); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect(s.message_id).toBe(1)                                   // only the valid object got an id
  expect(out).toContain('"type":"json"')
  expect(out).toContain('inbox parse error')
  const plog = readFileSync(join(root, 'plugin.log'), 'utf8')
  expect(plog).toContain('"event":"message_injected"')
  expect(plog).toContain('"event":"parse_error"')
  expect(plog).toMatch(/"pid":\d+/)   // instances share one log; lines must be attributable
}, 15000)

test('reply creates the outbox mirroring the declared format, or text when none (I11/I18)', async () => {
  const root = mkRoot()
  mkChannel(root, 'json-chan', ['inbox.jsonl'])                  // outbox absent: mirrors the inbox
  mkChannel(root, 'bare')                                        // declares nothing: text
  const proc = spawn(root); const send = driver(proc)
  send(call(2, 'reply', { channel: 'json-chan', text: 'pong', priority: 5 }))
  send(call(3, 'reply', { channel: 'bare', text: 'plain' }))
  await proc.stdin.flush()
  const a = await poll(readNonEmpty(join(root, 'json-chan', 'outbox.jsonl')))
  const b = await poll(readNonEmpty(join(root, 'bare', 'outbox.txt')))
  proc.kill()
  expect(a).toBe('{"text":"pong","priority":5}' + EOL)
  expect(b).toBe('plain' + EOL)
}, 15000)

// Four rejections down one pipe: they share a spawn, so they stay one test — but
// each is asserted by its own JSON-RPC id. Counting isError instead would pass
// even with the branches crossed, reporting the wrong cause for every input.
test('reply rejects each malformed call with the reason that fits it (I8/I11)', async () => {
  const root = mkRoot(); mkChannel(root, 'main', ['inbox.txt', 'outbox.txt'])
  const proc = spawn(root, {}, 'pipe'); const send = driver(proc)
  send(call(2, 'reply', { channel: 'main', text: 'x', priority: 5 }))
  send(call(3, 'reply', { channel: 'main', text: 'line one\nline two' }))
  send(call(4, 'reply', { channel: 'main' }))
  send(call(5, 'reply', { channel: 'nope', text: 'x' }))
  await proc.stdin.flush()
  await Bun.sleep(700); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect(errorFor(out, 2)).toMatch(/structured fields require a jsonl/)
  expect(errorFor(out, 3)).toMatch(/must not contain a line terminator/)
  expect(errorFor(out, 4)).toMatch(/requires a text field/)
  expect(errorFor(out, 5)).toMatch(/unknown channel: nope/)
  expect(readFileSync(join(root, 'main', 'outbox.txt'), 'utf8')).toBe('')   // nothing written by any of them
  // No code path creates a directory outside the root: a convenience that
  // auto-created one would turn a typo into a channel nobody protected (§15).
  expect(existsSync(join(root, 'nope'))).toBe(false)
}, 15000)

test('send creates the inbox of a channel this session does not read, and no state file (I18)', async () => {
  const root = mkRoot()
  mkChannel(root, 'main', ['inbox.txt'])
  mkChannel(root, 'downstream')                                  // no inbox: not read here, created by the send
  const proc = spawn(root); const send = driver(proc)
  send(call(2, 'send', { channel: 'downstream', text: 'handoff' }))
  await proc.stdin.flush()
  const foreign = await poll(readNonEmpty(join(root, 'downstream', 'inbox.txt')))
  proc.kill()
  expect(foreign).toBe('handoff' + EOL)
  expect(existsSync(join(root, 'downstream', 'inbox.txt.state'))).toBe(false)   // written, never read
}, 15000)

test('send loops back into a channel this session reads only with allow_self (I12)', async () => {
  const root = mkRoot(); mkChannel(root, 'main', ['inbox.txt'])
  const proc = spawn(root); const send = driver(proc)
  send(call(2, 'send', { channel: 'main', text: 'loop-blocked' }))
  send(call(3, 'send', { channel: 'main', text: 'loop-allowed', allow_self: true }))
  await proc.stdin.flush()
  const inbox = await poll(readNonEmpty(join(root, 'main', 'inbox.txt')))
  proc.kill()
  expect(inbox).toContain('loop-allowed')
  expect(inbox).not.toContain('loop-blocked')
}, 15000)

// The read side and the write side of "no length bound" are separate mechanisms —
// block-crossing scan versus an append past MAX_ATOMIC_APPEND. Together, a broken
// scan hid the write assertion entirely (ADR-010).
test('a line longer than the scan block is framed and injected whole (I2)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const state = join(dir, 'inbox.txt.state')
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(state, (o) => o.read_offset === 0))
  const long = 'L'.repeat(100_000)         // past SCAN_CHUNK: the scan crosses blocks to find the terminator
  appendFileSync(join(dir, 'inbox.txt'), long + '\n')
  const s = await poll(readJson(state, (o) => o.message_id === 1))
  await Bun.sleep(200); proc.kill()
  expect(s).toEqual({ read_offset: long.length + 1, message_id: 1 })
  expect(await new Response(proc.stdout).text()).toContain(long)
}, 20000)

test('a reply past MAX_ATOMIC_APPEND is written, not refused (I21)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const proc = spawn(root); const send = driver(proc)
  const huge = 'H'.repeat(1_048_586)       // past MAX_ATOMIC_APPEND, which no longer gates a data write
  send(call(2, 'reply', { channel: 'main', text: huge }))
  await proc.stdin.flush()
  const written = await poll(readNonEmpty(join(dir, 'outbox.txt')))
  proc.kill()
  expect(written!.length).toBe(huge.length + EOL.length)
}, 20000)

test('an out-of-contract shrink notices and seeks to the end, then keeps reading (I4)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const inbox = join(dir, 'inbox.txt'); const state = join(dir, 'inbox.txt.state')
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(state, (o) => o.read_offset === 0))
  appendFileSync(inbox, 'first\n')
  await poll(readJson(state, (o) => o.message_id === 1))
  writeFileSync(inbox, '')                                       // append-only violated
  await poll(readJson(state, (o) => o.read_offset === 0))
  appendFileSync(inbox, 'second\n')
  const s = await poll(readJson(state, (o) => o.message_id === 2))
  await Bun.sleep(200); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('partial-truncation')
  expect(s).toEqual({ read_offset: 7, message_id: 2 })
}, 15000)

test('two servers on one channel: only one tails (single-reader lock) (I16)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const a = spawn(root, {}, 'pipe'); const b = spawn(root, {}, 'pipe')
  await Bun.sleep(600)
  appendFileSync(join(dir, 'inbox.txt'), 'once\n')
  await Bun.sleep(800)
  a.kill(); b.kill()
  const out = (await new Response(a.stdout).text()) + (await new Response(b.stdout).text())
  expect(injections(out)).toBe(1)
}, 20000)

// Every other server test runs a single reader channel, so "one root, many
// channels" — the whole premise — held only by construction: collapsing the
// per-channel runtimes onto shared state would keep the rest of the suite green.
test('one root, many channels: counters and state files are per channel (I9)', async () => {
  const root = mkRoot()
  const alpha = mkChannel(root, 'alpha', ['inbox.txt'])
  const beta = mkChannel(root, 'beta', ['inbox.jsonl'])
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(join(alpha, 'inbox.txt.state'), (o) => o.read_offset === 0))
  await poll(readJson(join(beta, 'inbox.jsonl.state'), (o) => o.read_offset === 0))
  appendFileSync(join(alpha, 'inbox.txt'), 'one\ntwo\n')
  appendFileSync(join(beta, 'inbox.jsonl'), '{"text":"only"}\n')
  const a = await poll(readJson(join(alpha, 'inbox.txt.state'), (o) => o.message_id === 2))
  const b = await poll(readJson(join(beta, 'inbox.jsonl.state'), (o) => o.message_id === 1))
  await Bun.sleep(300); proc.kill()
  expect(a!.message_id).toBe(2)                               // beta's counter starts at 1 while alpha is at 2
  expect(b!.message_id).toBe(1)
  expect(injections(await new Response(proc.stdout).text())).toBe(3)
}, 20000)

// POSIX-only: on Windows the mode bits of a directory are ignored outright, so
// the channel under test is never actually broken and there is nothing to
// contain. The behaviour itself is not Unix-specific — an ACL would produce it —
// but chmod cannot express it, so this invariant is guarded on Unix alone.
test.skipIf(process.platform === 'win32')('a channel whose directory cannot be written is skipped; the rest serve (I17)', async () => {
  const root = mkRoot()
  const broken = mkChannel(root, 'a-broken', ['inbox.txt'])   // sorted first: set up before the healthy one
  const alpha = mkChannel(root, 'alpha', ['inbox.txt'])
  chmodSync(broken, 0o555)                                    // readable, not writable: no lock, no state file
  const proc = spawn(root, {}, 'pipe')
  await poll(readJson(join(alpha, 'inbox.txt.state'), (o) => o.read_offset === 0))
  appendFileSync(join(alpha, 'inbox.txt'), 'served\n')
  await poll(readJson(join(alpha, 'inbox.txt.state'), (o) => o.message_id === 1))
  await Bun.sleep(300); proc.kill()
  chmodSync(broken, 0o755)                                    // so the temp tree can be cleaned
  expect(existsSync(join(broken, 'inbox.txt.state'))).toBe(false)
  const log = readFileSync(join(root, 'plugin.log'), 'utf8')
  expect(log).toMatch(/channel setup failed; skipped/)
  expect(log).toContain('"channel":"a-broken"')
}, 20000)

test('permission control plane: request -> control/requests.jsonl, first verdict wins (I13/I14/I15)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  mkdirSync(join(dir, 'control'), { recursive: true })           // control/ present -> delegate
  const proc = spawn(root, {}, 'pipe'); const send = driver(proc)
  // Wait for the state file: an append landing before startup would be read past
  // (no state -> offset=end, §4), leaving no injection and so no active channel.
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.read_offset === 0))
  appendFileSync(join(dir, 'inbox.txt'), 'hi\n')                 // an injection sets the active channel
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.message_id === 1))
  send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'do x', input_preview: 'do x' } })
  await proc.stdin.flush()
  const reqs = await poll(readNonEmpty(join(dir, 'control', 'requests.jsonl')))
  expect(reqs).toContain('"request_id":"abcde"')   // routing; the record's shape is pinned in permission.test.ts
  const verdicts = join(dir, 'control', 'verdicts.jsonl')
  appendFileSync(verdicts, '{"kind":"permission","request_id":"abcde","behavior":"allow"}\n')
  appendFileSync(verdicts, '{"kind":"permission","request_id":"abcde","behavior":"deny"}\n')   // stale, ignored
  await Bun.sleep(600); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect((out.match(/"method":"notifications\/claude\/channel\/permission"/g) || []).length).toBe(1)
  expect(out).toContain('"behavior":"allow"')
}, 15000)

// Do not merge this with the fail-closed tests below, however similar the setup
// looks: `channelSeen` is per process, not per channel, so injecting anything to
// arrange one case permanently destroys this one.
test('a permission request before any channel message is left to the harness, not denied (I15)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  mkdirSync(join(dir, 'control'), { recursive: true })           // a delegate, so only the "no channel message yet" rule can explain silence
  const proc = spawn(root, {}, 'pipe'); const send = driver(proc)
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.read_offset === 0))
  send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'do x', input_preview: 'do x' } })
  await proc.stdin.flush()
  await Bun.sleep(800); proc.kill()
  const out = await new Response(proc.stdout).text()
  // Nothing came from a channel, so this prompt is the operator's own work: the
  // plugin must not answer it at all, or it refuses tool calls unrelated to it.
  expect(out).not.toContain('notifications/claude/channel/permission')
  expect(existsSync(join(dir, 'control', 'requests.jsonl'))).toBe(false)
  expect(readFileSync(join(root, 'plugin.log'), 'utf8')).toContain('no channel message yet')
}, 15000)

test('permission fail-closed: no control plane -> terminal deny, no request appended (I15)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])   // no control/ -> not a delegate
  const proc = spawn(root, {}, 'pipe'); const send = driver(proc)
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.read_offset === 0))
  appendFileSync(join(dir, 'inbox.txt'), 'hi\n')                 // injected: the deny below is the delegate check, not a missing active channel
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.message_id === 1))
  send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'do x', input_preview: 'do x' } })
  await proc.stdin.flush()
  await Bun.sleep(600); proc.kill()
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('"behavior":"deny"')
  expect(existsSync(join(dir, 'control', 'requests.jsonl'))).toBe(false)
}, 15000)

// POSIX-only, for the same reason as the containment test above: chmod 0o200 on
// Windows sets nothing that makes a file unreadable, so the plane stays readable
// and the case under test never arises. The read probe itself is portable.
test.skipIf(process.platform === 'win32')('permission fail-closed: an unreadable verdicts file -> terminal deny, not pending (I15)', async () => {
  const root = mkRoot(); const dir = mkChannel(root, 'main', ['inbox.txt'])
  const control = join(dir, 'control'); mkdirSync(control, { recursive: true })   // a delegate...
  const verdicts = join(control, 'verdicts.jsonl')
  writeFileSync(verdicts, '')
  chmodSync(verdicts, 0o200)                                     // ...whose plane can never answer: write-only to us
  const proc = spawn(root, {}, 'pipe'); const send = driver(proc)
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.read_offset === 0))
  appendFileSync(join(dir, 'inbox.txt'), 'hi\n')
  await poll(readJson(join(dir, 'inbox.txt.state'), (o) => o.message_id === 1))
  send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'do x', input_preview: 'do x' } })
  await proc.stdin.flush()
  await Bun.sleep(600); proc.kill()
  chmodSync(verdicts, 0o600)                                     // so the temp tree can be cleaned
  const out = await new Response(proc.stdout).text()
  expect(out).toContain('"behavior":"deny"')
  // Appending the request would strand it: nothing can ever resolve it, and the
  // operator sees a request that looks live.
  expect(existsSync(join(control, 'requests.jsonl'))).toBe(false)
}, 15000)

test('pipeline (§18): A sends to an external channel that B reads and injects', async () => {
  const rootB = mkRoot(); mkChannel(rootB, 'report', ['inbox.jsonl'])   // B serves report as its own subdirectory
  const rootA = mkRoot(); mkChannel(rootA, 'ingest', ['inbox.txt'])
  writeFileSync(join(rootA, 'channels.json'), JSON.stringify({ report: join(rootB, 'report') }))
  const a = spawn(rootA, {}, 'ignore'); const b = spawn(rootB, {}, 'pipe')
  const send = driver(a)
  await Bun.sleep(500)
  send(call(2, 'send', { channel: 'report', text: 'from-A' }))
  await a.stdin.flush()
  await Bun.sleep(900)
  a.kill(); b.kill()
  const out = await new Response(b.stdout).text()
  expect(out).toContain('from-A')
  expect(out).toContain('"type":"json"')   // B's inbox is jsonl: the payload arrives as an object
  // The handed-off payload carries no identifier: ids belong to the reader that
  // will assign them, and nothing plugin-defined is written into an inbox (I20).
  expect(readFileSync(join(rootB, 'report', 'inbox.jsonl'), 'utf8')).toBe('{"text":"from-A"}' + EOL)
}, 20000)

test('exits when stdin closes, so a dead parent cannot orphan it', async () => {
  const root = mkRoot(); mkChannel(root, 'main', ['inbox.txt'])
  const proc = spawn(root)
  driver(proc); await proc.stdin.flush()
  await Bun.sleep(400)
  proc.stdin.end()
  const outcome = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'hung')])
  if (outcome === 'hung') proc.kill()
  expect(outcome).not.toBe('hung')
}, 15000)
