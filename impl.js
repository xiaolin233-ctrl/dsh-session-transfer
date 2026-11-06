/**
 * Implementation of `dsh-session-transfer`.
 *
 * Loaded freshly on every HTTP request by `./index.js`, so Host-side edits take
 * effect on the next click without restarting DSH. All Harness service calls go
 * through `./host-api.js`, which is re-imported with this module.
 *
 * The move is a faithful replay, never a byte edit of the stored log:
 *   1. read the whole source log through `sessionPersistence` (or the live
 *      session, which already holds it in memory);
 *   2. `create` a new session id whose header keeps every meaningful field but
 *      points `cwd` at the target workspace;
 *   3. append the events unchanged, batch by batch, and flush;
 *   4. re-read the copy and compare it against what we meant to write;
 *   5. attach it to the target workspace and refresh its projection cache
 *      (this is what restores the sidebar title);
 *   6. optionally archive the original, which hides it without deleting a byte.
 */

import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const host = await import(`${new URL('./host-api.js', import.meta.url).href}?stamp=${STAMP}`)

const {
  COPYABLE_FORMAT_STATUSES,
  DELIVERY_MARKER_TYPES,
  appendEvents,
  archiveSession,
  attachSession,
  closeSession,
  createSession,
  flushSession,
  hostServices,
  readSource,
  readStoredLog,
  statSession,
  writeProjectionCache,
} = host

function messageOf(error) {
  if (error instanceof Error) return error.message === '' ? String(error) : error.message
  return String(error)
}

function failure(code, message) {
  return { ok: false, code, message }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false
  try {
    return resolvePath(left).toLowerCase() === resolvePath(right).toLowerCase()
  } catch {
    return left.toLowerCase() === right.toLowerCase()
  }
}

function listWorkspaces(registry) {
  return registry.list().map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessionCount: workspace.sessionIds.length,
    sessionIds: [...workspace.sessionIds],
  }))
}

async function workspaceByPath(registry, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  try {
    return await registry.resolveByPath(cwd)
  } catch {
    return undefined
  }
}

function assertContiguous(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') throw new Error(`event ${index} is not an object`)
    if (event.seq !== index) throw new Error(`event log is not contiguous: index ${index} carries seq ${String(event.seq)}`)
  }
}

function isMidTurn(events) {
  let started = -1
  let ended = -1
  for (const event of events) {
    if (event.type === 'turn/start') started = event.seq
    else if (event.type === 'turn/end') ended = event.seq
  }
  return started > ended
}

function buildHeader(header, id, cwd) {
  const next = {
    version: Number.isSafeInteger(header.version) ? header.version : 4,
    id,
    createdAt: Number.isSafeInteger(header.createdAt) && header.createdAt >= 0 ? header.createdAt : Date.now(),
    isSeeded: header.isSeeded === true,
    cwd,
    delegationDepth: Number.isSafeInteger(header.delegationDepth) && header.delegationDepth >= 0 ? header.delegationDepth : 0,
  }
  if (typeof header.agentPreset === 'string' && header.agentPreset !== '') next.agentPreset = header.agentPreset
  if (typeof header.parentSession === 'string' && header.parentSession !== '') next.parentSession = header.parentSession
  return next
}

/**
 * Rewrite the delivery markers this session produced so they name the copy.
 *
 * The inherited prefix (when the copy keeps its `parentSession`) keeps the
 * parent's markers untouched — those events still belong to the parent run.
 */
function retargetDeliveryMarkers(events, fromSeq, sessionId, keepsInheritedPrefix) {
  return events.map((event) => {
    if (!DELIVERY_MARKER_TYPES.has(event.type)) return event
    if (keepsInheritedPrefix && event.seq < fromSeq) return event
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return event
    if (data.sessionId === sessionId) return event
    return { ...event, data: { ...data, sessionId } }
  })
}

/** First delivery marker that still names a foreign session, or `undefined`. */
function findStrayDeliveryMarker(events, sessionId, expected) {
  for (const event of events) {
    if (!DELIVERY_MARKER_TYPES.has(event.type)) continue
    if (expected.keepsInheritedPrefix && event.seq < expected.inheritedEventCount) continue
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    if (data.sessionId !== sessionId) return event.seq
  }
  return undefined
}

/**
 * Re-read the copy and prove it matches what we meant to write: event count,
 * contiguous seq, last seq, and the ownership recorded in delivery markers.
 * The marker check is what catches a silently-missed retarget — the copy would
 * otherwise pass the other checks and then fail to open.
 */
async function verifyCopy(persistence, sessionId, expected) {
  const stored = await statSession(persistence, sessionId)
  if (stored === undefined) return { ok: false, message: 'the copied session is not visible in session storage' }
  const { events } = await readStoredLog(persistence, sessionId)
  if (events.length !== expected.count) return { ok: false, message: `stored ${events.length} events, expected ${expected.count}` }
  assertContiguous(events)
  const lastSeq = events.length === 0 ? -1 : events[events.length - 1].seq
  if (lastSeq !== expected.lastSeq) return { ok: false, message: `last stored seq is ${lastSeq}, expected ${expected.lastSeq}` }
  const stray = findStrayDeliveryMarker(events, sessionId, expected)
  if (stray !== undefined) return { ok: false, message: `the delivery marker at seq ${stray} still names another session` }
  return { ok: true }
}

/** GET /dsh-session-transfer/state — workspaces, ownership and session facts. */
export async function state(ctx, params = {}) {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
  if (sessionId === '') return failure('bad-request', 'sessionId is required')

  let services
  try {
    services = hostServices(ctx)
  } catch (error) {
    return failure('services-missing', messageOf(error))
  }
  const { persistence, registry, sessions } = services

  let stat
  try {
    stat = await statSession(persistence, sessionId)
  } catch (error) {
    return failure('session-not-found', `session "${sessionId}" could not be read: ${messageOf(error)}`)
  }
  if (stat === undefined) return failure('session-not-found', `session "${sessionId}" was not found`)

  const header = stat.header ?? {}
  const workspaces = listWorkspaces(registry)
  const owning = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))
  const found = owning ?? (await workspaceByPath(registry, header.cwd))
  const live = sessions?.get?.(sessionId)

  return {
    ok: true,
    workspaces: workspaces.map(({ id, title, path, sessionCount }) => ({ id, title, path, sessionCount })),
    currentWorkspaceId: found ? found.id : null,
    sourceSessionIds: found ? found.sessionIds : [],
    session: {
      id: sessionId,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      origin: typeof header.origin === 'string' ? header.origin : null,
      createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
      formatStatus: typeof stat.formatStatus === 'string' ? stat.formatStatus : 'current',
      live: Boolean(live),
      running: live ? isMidTurn([...live.snapshotEvents()]) : false,
      eventCount: live ? live.seq : null,
    },
  }
}

/** POST /dsh-session-transfer/transfer — replay one or more sessions elsewhere. */
export async function transfer(ctx, body = {}) {
  const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : []
  const sessionIds = [...new Set(rawIds.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))]
  const targetWorkspaceId = typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId.trim() : ''
  const keepOriginal = body.keepOriginal === true
  const titles = body.titles !== null && typeof body.titles === 'object' ? body.titles : {}

  if (sessionIds.length === 0) return failure('bad-request', 'sessionIds must contain at least one session id')

  let registry
  try {
    registry = hostServices(ctx).registry
  } catch (error) {
    return failure('services-missing', messageOf(error))
  }
  const target = registry.get(targetWorkspaceId)
  if (target === undefined) return failure('workspace-not-found', `workspace "${targetWorkspaceId}" was not found`)

  const results = []
  for (const sessionId of sessionIds) {
    const title = typeof titles[sessionId] === 'string' ? titles[sessionId] : undefined
    try {
      results.push(await transferOne(ctx, sessionId, target, keepOriginal, title))
    } catch (error) {
      results.push({ sessionId, ok: false, code: 'transfer-failed', message: messageOf(error), ...(title === undefined ? {} : { title }) })
    }
  }

  return {
    ok: results.some((result) => result.ok === true),
    targetWorkspaceId: target.id,
    targetTitle: target.title,
    targetPath: target.path,
    results,
  }
}

async function transferOne(ctx, sessionId, target, keepOriginal, title) {
  const failures = (code, message, extra = {}) => ({ sessionId, ok: false, code, message, ...(title === undefined ? {} : { title }), ...extra })

  let services
  try {
    services = hostServices(ctx)
  } catch (error) {
    return failures('services-missing', messageOf(error))
  }
  const { persistence, registry, sessions, projectionCache } = services

  let stat
  try {
    stat = await statSession(persistence, sessionId)
  } catch (error) {
    return failures('session-not-found', `session "${sessionId}" could not be read: ${messageOf(error)}`)
  }
  if (stat === undefined) return failures('session-not-found', `session "${sessionId}" was not found`)
  const header = stat.header ?? {}

  if (header.origin === 'subagent') {
    return failures('subagent-session', 'a subagent conversation belongs to its parent run and cannot be moved on its own')
  }
  if (typeof stat.formatStatus === 'string' && !COPYABLE_FORMAT_STATUSES.has(stat.formatStatus)) {
    return failures('format-migration-required', `this session first needs a format migration (${stat.formatStatus}) before it can be copied`)
  }
  if (typeof header.cwd === 'string' && samePath(header.cwd, target.path)) {
    return failures('same-workspace', 'the conversation already lives in that workspace')
  }

  const live = sessions?.get?.(sessionId)
  let source
  try {
    source = await readSource(persistence, sessions, sessionId)
  } catch (error) {
    return failures('read-failed', `the conversation log could not be read: ${messageOf(error)}`)
  }
  const events = source.events
  try {
    assertContiguous(events)
  } catch (error) {
    return failures('log-corrupt', messageOf(error))
  }
  if (live !== undefined && isMidTurn(events)) {
    return failures('session-running', 'the conversation is answering right now; wait for the current turn to finish and try again')
  }

  const newSessionId = `session-${randomUUID()}`
  const newHeader = buildHeader(header, newSessionId, target.path)
  const keepsInheritedPrefix = newHeader.parentSession !== undefined
  // Events inherited from a parent prefix keep their parent's delivery markers; events this
  // session produced must name the copy, otherwise the stored log fails v4 relationship checks.
  const payload = retargetDeliveryMarkers(events, source.inheritedEventCount, newSessionId, keepsInheritedPrefix)

  let created
  try {
    created = await createSession(persistence, newHeader, source.inheritedEventCount)
  } catch (error) {
    return failures('create-failed', `the target session could not be created: ${messageOf(error)}`)
  }

  try {
    await appendEvents(created, payload)
    await flushSession(created)
  } catch (error) {
    await closeSession(created)
    return failures('copy-failed', `the event log could not be copied: ${messageOf(error)}`, {
      partialSessionId: newSessionId,
    })
  }
  await closeSession(created)

  const expectedLastSeq = events.length === 0 ? -1 : events[events.length - 1].seq
  try {
    const verified = await verifyCopy(persistence, newSessionId, {
      count: events.length,
      lastSeq: expectedLastSeq,
      inheritedEventCount: source.inheritedEventCount,
      keepsInheritedPrefix,
    })
    if (!verified.ok) {
      return failures('verify-failed', `the copied log does not match the source: ${verified.message}`, {
        partialSessionId: newSessionId,
      })
    }
  } catch (error) {
    return failures('verify-failed', `the copied log could not be re-read: ${messageOf(error)}`, {
      partialSessionId: newSessionId,
    })
  }

  try {
    await attachSession(target, newSessionId)
  } catch (error) {
    return failures('attach-failed', `the copy exists but could not be attached to "${target.title}": ${messageOf(error)}`, {
      partialSessionId: newSessionId,
    })
  }

  const cacheWritten = await writeProjectionCache(projectionCache, newHeader, source.inheritedEventCount, payload)

  let archivedOriginal = false
  let note
  if (!keepOriginal) {
    try {
      await archiveSession(registry, sessionId)
      archivedOriginal = true
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.name === 'WorkspaceActiveSessionError') note = 'original-active'
      else note = `original-archive-failed: ${messageOf(error)}`
    }
  }

  return {
    sessionId,
    ok: true,
    newSessionId,
    eventCount: events.length,
    archivedOriginal,
    cacheWritten,
    ...(title === undefined ? {} : { title }),
    ...(note === undefined ? {} : { note }),
  }
}