/**
 * dsh-conversation-rollback — Host half.
 *
 * In-place rollback of the CURRENT Session: hide a suffix of the model-visible
 * surface with a single `surfaceOp: { op: 'replace' }` event (the same primitive
 * compaction uses) and restore the content-state snapshots (todo / plan) that
 * were in force at the rollback point. The session log stays append-only:
 * nothing is physically deleted, the cut is expressed as an ordinary surface
 * replacement, so `deriveMessages()` (and therefore the model context) no longer
 * contains the rolled-back turns.
 *
 * @module dsh-conversation-rollback
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name. */
export const name = 'dsh-conversation-rollback'

/** Host services this plugin depends on. */
export const inject = ['webServer', 'sessions', 'connection', 'agents', 'jobs']

const ROUTE_PREFIX = '/dsh-conversation-rollback/api'
const CUT_SOURCE_KIND = 'rollback-cut'

/** Message-bearing surface event types. */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Content-state events restored to their pre-cut value (last write wins).
 *
 * `goal/change` is deliberately absent. Its fold requires every event to carry
 * `revision === current.revision + 1` and an unchanged `roundsStarted`; replaying
 * a snapshot that was current before the cut would repeat an old revision and
 * park the Session's goal projection in a permanent failure state
 * (`goal replay failed at session event N`). A rollback therefore leaves the
 * goal untouched instead of corrupting it.
 */
const STATE_EVENTS = ['todo/write', 'plan/mode']

/**
 * How long a rollback waits for the running turn to settle before it proceeds
 * anyway.
 *
 * `Agent.cancel()` is issued first, so the wait is only a courtesy that keeps a
 * half-written step out of the log; a turn wedged in an unresponsive tool must
 * not hold the HTTP request — and with it the client's busy latch — open for the
 * rest of the session.
 */
export const IDLE_TIMEOUT_MS = 15_000

/** Sessions with a rollback currently in flight, keyed by session id. */
const ROLLBACKS_IN_FLIGHT = new Map()

/**
 * Rejection used when a second rollback targets a session that is already being
 * rolled back. Carries a machine-readable code so the client can explain the
 * refusal instead of echoing the host's English message.
 */
export class RollbackBusyError extends Error {
  constructor() {
    super('rollback: another rollback is already running for this session')
    this.name = 'RollbackBusyError'
    this.code = 'busy'
  }
}

/**
 * Run `task` only while no other task holds `key`.
 *
 * Two windows can roll the same Session back at once, and both would compute
 * the same plan before either appended it: the second `surfaceOp.replace`
 * would then name a range that no longer exists. The guard is per-process and
 * synchronous at the check, which is what makes it atomic in JavaScript; a
 * queued second attempt is rejected rather than replayed, because the first one
 * already performed the cut the operator asked for.
 *
 * @param key - the session id the task belongs to.
 * @param task - the work to run exclusively.
 * @returns the task's result; rejects when the key is already busy.
 */
export function singleFlight(key, task) {
  if (ROLLBACKS_IN_FLIGHT.has(key)) return Promise.reject(new RollbackBusyError())
  const running = Promise.resolve().then(task)
  ROLLBACKS_IN_FLIGHT.set(key, running)
  const release = () => {
    // A later attempt that somehow registered over this one must not be cleared
    // by a stale release.
    if (ROLLBACKS_IN_FLIGHT.get(key) === running) ROLLBACKS_IN_FLIGHT.delete(key)
  }
  running.then(release, release)
  return running
}

/**
 * Wait for the agent's running turn to settle, bounded by `timeoutMs`.
 *
 * @param agent - the live agent, when one is attached to the Session.
 * @param timeoutMs - how long to wait before giving up.
 * @returns `true` when the turn settled, `false` when the wait timed out.
 */
export async function waitForIdle(agent, timeoutMs) {
  const idle = agent?.whenIdle?.()
  if (idle === undefined) return true
  let timer
  const expired = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs, 'timeout')
  })
  try {
    const outcome = await Promise.race([Promise.resolve(idle).then(() => 'idle'), expired])
    return outcome === 'idle'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Write a JSON response.
 * @param response - Node server response.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable payload.
 */
function writeJson(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

/**
 * Read and parse a JSON request body.
 * @param request - Node incoming message.
 * @returns the parsed payload, or an empty object for an empty body.
 */
async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw === '' ? {} : JSON.parse(raw)
}

/**
 * Current model-visible surface node sequence numbers.
 * @param session - live Session.
 * @returns the ordered surface node seqs.
 */
function surfaceNodes(session) {
  return [...(session.surface?.nodes ?? [])]
}

/**
 * Compute everything a rollback would do, without mutating the session.
 *
 * `originSeq` is the seq of the user message the operator clicked. The cut
 * starts at that message (the message itself is removed) and runs to the end of
 * the current surface. Surface node 0 (the system head) is never covered.
 *
 * @param session - live Session.
 * @param originSeq - the clicked user message seq.
 * @returns the rollback plan.
 */
export function planRollback(session, originSeq) {
  const nodes = surfaceNodes(session)
  if (nodes.length === 0) throw new Error('rollback: the session has no surface')
  const index = nodes.findIndex(seq => seq >= originSeq)
  if (index < 0) throw new Error('rollback: the selected message is already gone')
  if (nodes[index] !== originSeq) {
    // The clicked seq is not on the surface any more (another window rolled the
    // same Session back, or a stale row is still on screen). Snapping to the next
    // node would silently delete more than the operator asked for.
    throw new Error('rollback: that message is no longer in the visible conversation')
  }
  if (index === 0) throw new Error('rollback: the session head cannot be rolled back')

  const startSeq = nodes[index]
  const endSeq = nodes[nodes.length - 1]
  const covered = nodes.slice(index)
  const coveredSet = new Set(covered)
  const events = session.snapshotEvents(startSeq, endSeq + 1)

  let messageCount = 0
  let lastTurn = 0
  const cutTurns = new Set()
  const jobs = []
  for (const event of events) {
    if (MESSAGE_TYPES.has(event.type) && coveredSet.has(event.seq)) messageCount += 1
    const turn = event.data?.turn
    if (typeof turn === 'number') {
      cutTurns.add(turn)
      lastTurn = Math.max(lastTurn, turn)
    }
    if (event.type === 'job/registered' && typeof event.data?.jobId === 'string') jobs.push(event.data.jobId)
  }
  const turnCount = cutTurns.size

  const restores = []
  const removedTypes = new Set(events.map(event => event.type))
  const before = session.snapshotEvents(0, startSeq)
  for (const type of STATE_EVENTS) {
    // Append the snapshot only when the cut actually removed a write of that
    // type: replaying an unchanged value would add noise without changing state.
    if (!removedTypes.has(type)) continue
    for (let i = before.length - 1; i >= 0; i -= 1) {
      if (before[i].type === type) {
        restores.push([type, before[i].data])
        break
      }
    }
  }

  const empties = nodes.length === covered.length + 1
  return { startSeq, endSeq, covered, coveredSet, events, messageCount, turnCount, lastTurn, jobs, restores, empties }
}

/**
 * Perform the rollback: cancel live work, append the surface replacement and
 * restore the content-state snapshots.
 *
 * @param ctx - host plugin context.
 * @param session - live Session.
 * @param originSeq - the clicked user message seq.
 * @returns a summary for the client.
 */
async function rollback(ctx, session, originSeq) {
  const plan = planRollback(session, originSeq)

  const agent = ctx.agents?.get?.(session.id)
  if (agent !== undefined) {
    try {
      agent.cancel({ kind: 'user' })
    } catch (error) {
      ctx.logger.warn('rollback: could not cancel the running turn:', error)
    }
    const settled = await waitForIdle(agent, IDLE_TIMEOUT_MS)
    if (!settled) {
      // The surface replacement below is still correct — it is computed from the
      // surface as it stands — but a step that finishes after this point can
      // append behind the cut. Say so instead of hiding it.
      ctx.logger.warn(`rollback: the running turn did not settle within ${IDLE_TIMEOUT_MS} ms; continuing`)
    }
    try {
      agent.inbox?.clear?.()
    } catch (error) {
      ctx.logger.warn('rollback: could not clear the queued input:', error)
    }
  }
  for (const jobId of plan.jobs) {
    try {
      ctx.jobs?.kill?.(jobId, session.id)
    } catch (error) {
      ctx.logger.warn(`rollback: could not stop background job ${jobId}:`, error)
    }
  }

  const replacement = {
    id: randomUUID(),
    role: 'system',
    content: [],
    source: { kind: CUT_SOURCE_KIND },
  }
  const inputs = [
    [
      'system/message',
      // format v4 requires both coordinates to be positive on system/message rows.
      { turn: Math.max(plan.lastTurn, 1), step: 1, message: replacement },
      { surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq }, sourceEventSeqs: plan.covered },
    ],
  ]
  for (const [type, data] of plan.restores) inputs.push([type, data])
  session.append(inputs)

  return {
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    messageCount: plan.messageCount,
    turnCount: plan.turnCount,
    emptied: plan.empties,
    restoredStates: plan.restores.map(([type]) => type),
  }
}

/**
 * Mount the fenced HTTP surface used by the client half.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const fence = request => ctx.connection.requestRejection(request) === undefined

  const sessionOf = payload => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') throw new Error('rollback: sessionId is required')
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error('rollback: unknown session')
    return session
  }

  const originOf = payload => {
    const originSeq = Number(payload?.originSeq)
    if (!Number.isSafeInteger(originSeq) || originSeq < 0) throw new Error('rollback: originSeq is invalid')
    return originSeq
  }

  const routes = {
    /** Report what a rollback would remove, for the confirmation dialog. */
    preview: async payload => {
      const session = sessionOf(payload)
      const plan = planRollback(session, originOf(payload))
      return {
        messageCount: plan.messageCount,
        turnCount: plan.turnCount,
        jobCount: plan.jobs.length,
        emptied: plan.empties,
      }
    },
    /**
     * Perform the rollback.
     *
     * The session id is resolved before the guard so a malformed payload keeps
     * answering with its own error instead of borrowing the busy message.
     */
    rollback: async payload => {
      const session = sessionOf(payload)
      const originSeq = originOf(payload)
      return singleFlight(session.id, () => rollback(ctx, session, originSeq))
    },
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!fence(request)) {
        writeJson(response, 403, { error: 'forbidden' })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method not allowed' })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const route = routes[method]
      if (route === undefined) {
        writeJson(response, 404, { error: `unknown method "${method}"` })
        return
      }
      try {
        writeJson(response, 200, { ok: true, result: await route(await readJson(request)) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = typeof error?.code === 'string' ? error.code : undefined
        writeJson(response, 400, code === undefined ? { ok: false, error: message } : { ok: false, error: message, code })
      }
    },
  }), 'dsh-conversation-rollback: host routes')
}
