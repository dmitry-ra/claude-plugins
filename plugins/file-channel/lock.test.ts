import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireReaderLock } from './lock.ts'

test('held lock blocks a second acquire; OS frees it when the holder is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-lock-'))
  const holder = Bun.spawn(['bun', '-e',
    'const {acquireReaderLock}=await import(process.env.M);' +
    'const r=acquireReaderLock(process.env.D);' +
    'process.stdout.write(r.ok?"HELD\\n":"NO\\n");setInterval(()=>{},1000)'],
    { env: { ...process.env, M: join(import.meta.dir, 'lock.ts'), D: dir }, stdout: 'pipe', stderr: 'ignore' })

  const reader = holder.stdout.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('HELD')
  reader.releaseLock()

  expect(acquireReaderLock(dir).ok).toBe(false)        // a live holder blocks us

  holder.kill('SIGKILL')
  await holder.exited

  let got = false
  for (let i = 0; i < 40 && !got; i++) {
    const r = acquireReaderLock(dir)
    if (r.ok) { got = true; r.release() } else await Bun.sleep(25)
  }
  expect(got).toBe(true)                               // death freed the lock
}, 15000)
