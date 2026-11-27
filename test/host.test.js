import assert from 'node:assert/strict'
import { test } from 'node:test'

import { IDLE_TIMEOUT_MS, singleFlight, waitForIdle } from '../lib/index.js'

/** Resolve after a macrotask, so a queued continuation can run first. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('singleFlight runs one task per key and releases the key after it settles', async () => {
  let runs = 0
  const first = await singleFlight('session-a', async () => {
    runs += 1
    return 'done'
  })
  assert.equal(first, 'done')
  assert.equal(runs, 1)

  // The key must be free again: a second attempt is a normal run, not a refusal.
  const second = await singleFlight('session-a', async () => {
    runs += 1
    return 'again'
  })
  assert.equal(second, 'again')
  assert.equal(runs, 2)
})

test('singleFlight rejects a concurrent attempt on the same key', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })

  const running = singleFlight('session-b', async () => {
    await gate
    return 'first'
  })
  await tick()

  await assert.rejects(
    () => singleFlight('session-b', async () => 'second'),
    /already running/,
  )

  release()
  assert.equal(await running, 'first')
})

test('singleFlight keeps distinct sessions independent', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const a = singleFlight('session-c', async () => { await gate; return 'a' })

  const b = await singleFlight('session-d', async () => 'b')
  assert.equal(b, 'b')

  release()
  assert.equal(await a, 'a')
})

test('singleFlight frees the key when the task throws', async () => {
  await assert.rejects(() => singleFlight('session-e', async () => { throw new Error('boom') }), /boom/)

  const after = await singleFlight('session-e', async () => 'recovered')
  assert.equal(after, 'recovered')
})

test('waitForIdle returns true for an agent with no running turn', async () => {
  assert.equal(await waitForIdle(undefined, 50), true)
  assert.equal(await waitForIdle({}, 50), true)
  assert.equal(await waitForIdle({ whenIdle: async () => {} }, 50), true)
})

test('waitForIdle gives up instead of waiting forever', async () => {
  const agent = { whenIdle: () => new Promise(() => {}) }
  const started = Date.now()
  assert.equal(await waitForIdle(agent, 30), false)
  assert.ok(Date.now() - started < 2000, 'the wait must be bounded by the timeout')
})

test('the idle timeout leaves room for a turn to unwind', () => {
  assert.ok(IDLE_TIMEOUT_MS >= 5000)
  assert.ok(IDLE_TIMEOUT_MS <= 60_000)
})
