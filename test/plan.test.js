import assert from 'node:assert/strict'
import { test } from 'node:test'

import { planRollback } from '../lib/index.js'

/**
 * Build a fake Session good enough for `planRollback`: a surface node list and
 * an event log that `snapshotEvents(from, to)` can slice.
 *
 * @param nodes - model-visible surface node seqs.
 * @param events - every log event in seq order.
 */
function fakeSession(nodes, events) {
  return {
    id: 'session-test',
    surface: { nodes },
    snapshotEvents(from, to) {
      return events.filter(event => event.seq >= from && event.seq < to)
    },
  }
}

const EVENTS = [
  { seq: 0, type: 'system/message', data: {} },
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { turn: 1, content: [] } },
  { seq: 3, type: 'assistant/message', data: { turn: 1, content: [] } },
  { seq: 4, type: 'turn/end', data: { turn: 1 } },
  { seq: 5, type: 'turn/start', data: { turn: 2 } },
  { seq: 6, type: 'user/message', data: { turn: 2, content: [] } },
  { seq: 7, type: 'assistant/message', data: { turn: 2, content: [] } },
  { seq: 8, type: 'turn/end', data: { turn: 2 } },
  { seq: 9, type: 'todo/write', data: { todos: ['after'] } },
]

const NODES = [0, 2, 3, 6, 7]

test('refuses to cut the session head', () => {
  const session = fakeSession(NODES, EVENTS)
  assert.throws(() => planRollback(session, 0), /session head cannot be rolled back/)
})

test('refuses a message that is no longer on the surface', () => {
  const session = fakeSession(NODES, EVENTS)
  assert.throws(() => planRollback(session, 99), /already gone/)
})

test('refuses to snap onto a different node', () => {
  // Seq 4 was never a surface node; snapping forward to 6 would delete an extra
  // turn the operator never selected.
  const session = fakeSession(NODES, EVENTS)
  assert.throws(() => planRollback(session, 4), /no longer in the visible conversation/)
})

test('plans a cut from the clicked message to the end of the surface', () => {
  const session = fakeSession(NODES, EVENTS)
  const plan = planRollback(session, 6)
  assert.equal(plan.startSeq, 6)
  assert.equal(plan.endSeq, 7)
  assert.deepEqual(plan.covered, [6, 7])
  assert.equal(plan.messageCount, 2)
  assert.equal(plan.turnCount, 1)
  assert.equal(plan.lastTurn, 2)
  assert.equal(plan.empties, false)
})

test('never replays a goal snapshot', () => {
  // seq 2 is the pre-cut content state, seq 4 is a goal mutation inside the cut.
  // The todo value must come back; the goal must not, because its fold requires
  // a strictly increasing revision and replaying an old snapshot would fail it.
  const session = fakeSession([0, 1, 3, 6], [
    { seq: 0, type: 'system/message', data: {} },
    { seq: 1, type: 'user/message', data: { turn: 1 } },
    { seq: 2, type: 'todo/write', data: { todos: ['before'] } },
    { seq: 3, type: 'user/message', data: { turn: 2 } },
    { seq: 4, type: 'goal/change', data: { operation: 'complete', revision: 2 } },
    { seq: 5, type: 'todo/write', data: { todos: ['after'] } },
    { seq: 6, type: 'user/message', data: { turn: 3 } },
  ])
  const plan = planRollback(session, 3)
  assert.deepEqual(plan.restores.map(([type]) => type), ['todo/write'])
  assert.deepEqual(plan.restores[0][1], { todos: ['before'] })
})

test('restores a content state only when the cut removed one', () => {
  const session = fakeSession(NODES, EVENTS)
  const plan = planRollback(session, 2)
  // `todo/write` sits at seq 9, inside the cut, so the pre-cut value (none) is
  // replayed only if one existed before startSeq; there is none.
  assert.deepEqual(plan.restores, [])
})

test('detects a cut that empties the model-visible surface', () => {
  const session = fakeSession([0, 2], [
    { seq: 0, type: 'system/message', data: {} },
    { seq: 2, type: 'user/message', data: { turn: 1 } },
  ])
  assert.equal(planRollback(session, 2).empties, true)
})
