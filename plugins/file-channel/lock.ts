// Single-reader lock for a channel dir: at most one process tails an inbox.
// flock(2) (Linux/macOS) / named mutex (Windows) - the kernel frees it on ANY
// process exit (incl. SIGKILL), so no pid files and no stale locks.

import { openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export type LockResult = { ok: true; release: () => void } | { ok: false }

export function acquireReaderLock(dir: string): LockResult {
  switch (process.platform) {
    case 'linux':  return flockLock(dir, 'libc.so.6')
    case 'darwin': return flockLock(dir, 'libSystem.dylib')
    case 'win32':  return mutexLock(dir)
    default:       return degraded(dir, `no lock primitive for ${process.platform}`)
  }
}

function flockLock(dir: string, libcName: string): LockResult {
  const { dlopen, FFIType } = require('bun:ffi')
  let libc: { flock: (fd: number, op: number) => number }
  try {
    libc = dlopen(libcName, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols
  } catch (err) {
    // The soname is a guess: musl (Alpine) ships no libc.so.6 at all. Unguarded,
    // this throw reaches the per-channel catch in the server and every channel is
    // skipped one by one while the session still looks healthy — the platform
    // fallback below exists for exactly this and was unreachable, because the
    // failure arrives as an exception rather than as an unknown platform.
    return degraded(dir, `cannot load ${libcName}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const LOCK_EX = 2, LOCK_NB = 4
  const fd = openSync(join(dir, 'reader.lock'), 'w')
  if (libc.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)                 // a live owner holds it: yield
    return { ok: false }
  }
  // fd stays open for the process lifetime; the OS closes it on exit -> auto-release.
  return { ok: true, release: () => closeSync(fd) }
}

function mutexLock(dir: string): LockResult {
  const { dlopen, FFIType, ptr } = require('bun:ffi')
  let k32: { CreateMutexW: (a: null, b: number, c: unknown) => bigint; GetLastError: () => number; CloseHandle: (h: bigint) => number }
  try {
    k32 = dlopen('kernel32.dll', {
      CreateMutexW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },  // HANDLE is u64, not ptr
      GetLastError: { args: [], returns: FFIType.u32 },
      CloseHandle:  { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols
  } catch (err) {
    return degraded(dir, `cannot load kernel32.dll: ${err instanceof Error ? err.message : String(err)}`)
  }
  const ERROR_ALREADY_EXISTS = 183
  const tag = createHash('sha1').update(dir).digest('hex').slice(0, 16)
  const wname = Buffer.from(`Local\\claude-file-channel-${tag}\0`, 'utf16le')
  const handle = k32.CreateMutexW(null, 0, ptr(wname))
  const lastError = k32.GetLastError()               // read before any other call clobbers it
  // A null handle means the mutex was never created, and GetLastError then carries
  // that failure rather than ERROR_ALREADY_EXISTS. Reporting success here would
  // hand back a release closure over a null handle and let a second reader tail
  // the same inbox while both believe they hold the lock.
  if (!handle) return degraded(dir, `CreateMutexW failed (GetLastError ${lastError})`)
  if (lastError === ERROR_ALREADY_EXISTS) {
    k32.CloseHandle(handle)
    return { ok: false }
  }
  return { ok: true, release: () => { k32.CloseHandle(handle) } }
}

// No usable lock primitive: run single-session without exclusion rather than
// refusing to serve. Reaching this means the exclusion guarantee is off, so it
// says so on stderr — the operator's only signal that two readers are possible.
function degraded(dir: string, reason: string): LockResult {
  process.stderr.write(`file channel: ${reason}; running without exclusion (${dir})\n`)
  return { ok: true, release: () => {} }
}
