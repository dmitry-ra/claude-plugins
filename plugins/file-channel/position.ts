// Pure read-position decisions for the channel inbox. No I/O.

export interface State { read_offset: number; message_id: number }
export interface Start { offset: number; messageId: number }

// Where to start reading and the next message id, from persisted state (or null)
// and the inbox's current size. No state -> EOF, so accumulated lines are not
// replayed; an operator-placed read_offset:0 is < size and naturally forces a
// replay. A stored offset past EOF (the file shrank while the plugin was down) is
// returned as-is: the first pump sees size < offset and applies the §4 shrink
// rule (notice + seek to end). Detection is size-only: no inode or other
// platform-dependent attribute. The state file is named after the inbox file it
// describes, so a channel that switched format finds no state of its own and
// starts fresh — no stored extension to reconcile (§3).
export function decideStart(prev: State | null, cur: { size: number }): Start {
  if (!prev) return { offset: cur.size, messageId: 0 }
  return { offset: prev.read_offset, messageId: prev.message_id }
}

// The plugin owns the state file. Any record missing a field fails this parse ->
// decideStart(null) -> offset=end, no replay (safe).
export function parseState(raw: string): State | null {
  try {
    const o = JSON.parse(raw)
    // Non-negative integers only. §4 invites the operator to hand-edit this file,
    // and a negative or fractional offset is rejected by the read syscall itself —
    // treating it as unusable state starts safely from the end instead.
    if (o && Number.isInteger(o.read_offset) && o.read_offset >= 0
          && Number.isInteger(o.message_id) && o.message_id >= 0) {
      return { read_offset: o.read_offset, message_id: o.message_id }
    }
  } catch {}
  return null
}
