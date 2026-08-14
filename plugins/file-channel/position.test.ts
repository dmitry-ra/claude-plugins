import { test, expect } from 'bun:test'
import { decideStart, parseState } from './position.ts'

test('decideStart: no state -> EOF; state -> resume + keep counter; read_offset 0 -> replay (I5)', () => {
  expect(decideStart(null, { size: 10 })).toEqual({ offset: 10, messageId: 0 })
  expect(decideStart({ read_offset: 4, message_id: 2 }, { size: 9 })).toEqual({ offset: 4, messageId: 2 })
  expect(decideStart({ read_offset: 0, message_id: 0 }, { size: 12 })).toEqual({ offset: 0, messageId: 0 })
})

test('parseState: a record missing either field, or not JSON, is null -> seek to end (I5)', () => {
  expect(parseState('{"read_offset":4,"message_id":2}')).toEqual({ read_offset: 4, message_id: 2 })
  expect(parseState('{"read_offset":4}')).toBeNull()   // one field short; a record with neither cannot fail alone
  expect(parseState('not json')).toBeNull()
  // §4 invites hand-editing, and the read syscall rejects these outright, so
  // unusable state must fall back to "start at the end" rather than reach it.
  expect(parseState('{"read_offset":-1,"message_id":0}')).toBeNull()
  expect(parseState('{"read_offset":1.5,"message_id":0}')).toBeNull()
})
