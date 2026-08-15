import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRegistry, writeTarget, statePathFor } from './registry.ts'

const noLog = () => {}
const mkRoot = () => mkdtempSync(join(tmpdir(), 'fc-reg-'))
function mkChannel(root: string, id: string, files: string[] = []): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), '')
  return dir
}

test('format comes from the extension, per role, and no inbox file means nothing to read (I18)', () => {
  const root = mkRoot()
  mkChannel(root, 'text-chan', ['inbox.txt'])
  mkChannel(root, 'json-chan', ['inbox.jsonl', 'outbox.txt'])   // the two roles are independent
  mkChannel(root, 'write-only')                                  // declares nothing to read
  const reg = buildRegistry(root, noLog)

  expect(reg.get('text-chan')!.inbox).toEqual({ path: join(root, 'text-chan', 'inbox.txt'), format: 'text' })
  expect(reg.get('json-chan')!.inbox!.format).toBe('jsonl')
  expect(reg.get('json-chan')!.outbox!.format).toBe('text')
  expect(reg.get('write-only')!.inbox).toBeNull()
  expect(statePathFor(reg.get('json-chan')!.inbox!.path)).toBe(join(root, 'json-chan', 'inbox.jsonl.state'))
})

test('an ambiguous channel is skipped and logged; the rest of the root still serves (I17)', () => {
  const root = mkRoot()
  mkChannel(root, 'ambiguous', ['inbox.txt', 'inbox.jsonl'])
  mkChannel(root, 'healthy', ['inbox.txt'])
  const errors: string[] = []
  const reg = buildRegistry(root, (e) => { if (e.event === 'error') errors.push(String(e.detail?.message)) })
  // The blast radius is one directory: voiding the registry would make a stray
  // file in an unrelated channel look, from inside the session, like no channel
  // ever existed.
  expect([...reg.keys()]).toEqual(['healthy'])
  expect(errors.join(' ')).toMatch(/both inbox\.txt and inbox\.jsonl/)
})

// One root subdirectory plus a channels.json written per case. Each case below is
// a separate test on purpose: they were once a single sequence, where the first
// assertion to fail hid every case after it — and the subtlest one, the symlinked
// collision, sat last.
function withRegistry(): { root: string; external: string; write: (o: unknown) => void } {
  const root = mkRoot()
  mkChannel(root, 'ingest', ['inbox.txt'])
  const external = mkdtempSync(join(tmpdir(), 'fc-ext-'))
  const file = join(root, 'channels.json')
  return { root, external, write: (o) => writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o)) }
}

test('a channels.json that is not an object of string paths is ignored; the root still serves (I17)', () => {
  // Without the shape guard, Object.entries("abc") would register channels 0,1,2.
  for (const bad of ['not json', '[1,2]', '"a string"', '5', '{"report":5}']) {
    const { root, write } = withRegistry()
    write(bad)
    let invalid = false
    const reg = buildRegistry(root, (e) => { if (e.event === 'registry_invalid') invalid = true })
    expect([...reg.keys()]).toEqual(['ingest'])
    expect(invalid).toBe(true)
  }
})

test('a channels.json target that is not an existing directory is skipped (I17)', () => {
  const { root, external, write } = withRegistry()
  const file = join(external, 'a-file')
  writeFileSync(file, '')
  for (const path of [join(root, 'does-not-exist'), file]) {   // absent, and present-but-not-a-directory
    write({ report: path })
    expect([...buildRegistry(root, noLog).keys()]).toEqual(['ingest'])
  }
})

test('an existing directory in channels.json registers as a write target (I17)', () => {
  const { root, external, write } = withRegistry()
  write({ report: external })
  expect(buildRegistry(root, noLog).get('report')!.role).toBe('target')
})

test('a duplicate id drops the channels.json entry; the root subdirectory keeps the name (I17)', () => {
  const { root, external, write } = withRegistry()
  write({ ingest: external })
  const reg = buildRegistry(root, noLog)
  expect([...reg.keys()]).toEqual(['ingest'])
  expect(reg.get('ingest')!.role).toBe('reader')   // registered first, so it is the survivor
})

test('a symlinked target colliding with a root subdirectory is dropped (I17)', () => {
  // Lexically distinct paths, one physical directory — they would share one inbox
  // and one state file. Only a canonical compare catches it.
  const { root, external, write } = withRegistry()
  const link = join(external, 'link-to-ingest')
  symlinkSync(join(root, 'ingest'), link)
  write({ other: link })
  const errors: string[] = []
  const reg = buildRegistry(root, (e) => { if (e.event === 'error') errors.push(String(e.detail?.message)) })
  expect([...reg.keys()]).toEqual(['ingest'])
  expect(errors.join(' ')).toMatch(/path collides/)
})

test('writeTarget: an existing file wins, else it mirrors the sibling, else text (I11)', () => {
  const root = mkRoot()
  mkChannel(root, 'declared', ['inbox.jsonl', 'outbox.txt'])
  mkChannel(root, 'inbox-only', ['inbox.jsonl'])   // outbox absent: created mirroring the inbox
  mkChannel(root, 'bare')                          // declares nothing: text
  const reg = buildRegistry(root, noLog)

  expect(writeTarget(reg.get('declared')!, 'outbox')).toEqual({ path: join(root, 'declared', 'outbox.txt'), format: 'text' })
  expect(writeTarget(reg.get('inbox-only')!, 'outbox')).toEqual({ path: join(root, 'inbox-only', 'outbox.jsonl'), format: 'jsonl' })
  expect(writeTarget(reg.get('bare')!, 'inbox')).toEqual({ path: join(root, 'bare', 'inbox.txt'), format: 'text' })
})
