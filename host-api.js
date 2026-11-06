/**
 * Thin adapter over the Harness Host services used by `dsh-session-transfer`.
 *
 * Every call into a Harness service lives here, so that a Host API change (a
 * renamed service, a changed read/create signature, a new delivery-marker event
 * type, a format-status rename) is a one-file edit instead of a hunt through
 * `impl.js`.
 *
 * `impl.js` re-imports this module with a fresh stamp on every HTTP request, so
 * edits here also take effect on the next click without restarting DSH.
 */

/** Events read per `handle.read()` round-trip (and written per append batch). */
export const PAGE_SIZE = 500

/** Hard stop for pathological logs; keeps a corrupt header from looping forever. */
export const MAX_EVENTS = 400_000

/**
 * Event types that carry the owning session id in `data.sessionId`.
 *
 * A verbatim copy of the log keeps the source id there, which v4 rejects with
 * `SessionFormatError: current-generation delivery marker names the wrong
 * Session`; `impl.js` rewrites these and `verifyCopy` checks the rewrite. If a
 * future Harness renames the event, add it here and the whole pipeline follows.
 */
export const DELIVERY_MARKER_TYPES = new Set(['session-log-deepseek/delivery-accepted'])

/**
 * `stat().formatStatus` values whose stored log can be replayed as-is.
 *
 * `current` is the only one today. A future v5 would add its own value here
 * (e.g. `v5-current`) instead of the copy path being loosened blindly.
 */
export const COPYABLE_FORMAT_STATUSES = new Set(['current'])

function lookup(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/** Fetch a service that the copy path cannot work without. */
export function requiredService(ctx, key) {
  const value = lookup(ctx, key)
  if (value === undefined) throw new Error(`service "${key}" is not available on this Host`)
  return value
}

/** Fetch a service that only improves the result (cache refresh, live-log hints). */
export function optionalService(ctx, key) {
  return lookup(ctx, key)
}

/** Resolve the four Host services this plugin touches, in one place. */
export function hostServices(ctx) {
  return {
    persistence: requiredService(ctx, 'sessionPersistence'),
    registry: requiredService(ctx, 'workspaceRegistry'),
    sessions: optionalService(ctx, 'sessions'),
    projectionCache: optionalService(ctx, 'sessionProjectionCache'),
  }
}

/** `sessionPersistence.stat()` — `undefined` (not an exception) when absent. */
export async function statSession(persistence, sessionId) {
  return await persistence.stat(sessionId)
}

/** A live session already holds its own log in memory. */
export function fromLiveSession(live) {
  const events = [...live.snapshotEvents()]
  const inherited = Number.isSafeInteger(live.inheritedEventCount) ? live.inheritedEventCount : 0
  return { events, inheritedEventCount: inherited }
}

async function drain(handle) {
  const events = []
  for (;;) {
    const page = await handle.read(events.length, PAGE_SIZE)
    const batch = Array.isArray(page?.events) ? page.events : []
    if (batch.length === 0) break
    events.push(...batch)
    if (events.length > MAX_EVENTS) throw new Error(`session log exceeds ${MAX_EVENTS} events`)
  }
  return events
}

/** Read a stored session's complete log plus its inherited prefix length. */
export async function readStoredLog(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const events = await drain(handle)
    const inheritedEventCount = Number.isSafeInteger(handle.inheritedEventCount) ? handle.inheritedEventCount : 0
    return { events, inheritedEventCount }
  } finally {
    await handle.close()
  }
}

/**
 * Read a session's complete log. A live session is flushed first, so the stored
 * log is authoritative; only when the flush carries no writer (a session
 * published outside the agent lifecycle) does its in-memory log stand in.
 */
export async function readSource(persistence, sessions, sessionId) {
  const live = sessions?.get?.(sessionId)
  if (live === undefined) return await readStoredLog(persistence, sessionId)

  if (typeof sessions.flush === 'function') await sessions.flush(live)
  const stored = await readStoredLog(persistence, sessionId)
  if (stored.events.length === live.seq) return stored

  const memory = fromLiveSession(live)
  if (memory.events.length === live.seq) return memory
  throw new Error(
    `only ${stored.events.length} of ${live.seq} events reached durable storage, and the live log holds ${memory.events.length}`,
  )
}

/** Create a stored session; the returned handle owns the write lock itself. */
export async function createSession(persistence, header, inheritedEventCount) {
  return await persistence.create(header, { inheritedEventCount })
}

/** Append the whole log in bounded batches (seq must already be contiguous). */
export async function appendEvents(handle, events) {
  for (let offset = 0; offset < events.length; offset += PAGE_SIZE) {
    await handle.append(events.slice(offset, offset + PAGE_SIZE))
  }
}

/** Durability barrier: without this the appended frames are not on disk yet. */
export async function flushSession(handle) {
  await handle.flush()
}

/** Close a handle, best effort — a failed handle is already unusable. */
export async function closeSession(handle) {
  try {
    await handle.close()
  } catch {
    /* the handle is already unusable */
  }
}

/** Attach a session id to a workspace (async; validates the header's cwd). */
export async function attachSession(workspace, sessionId) {
  await workspace.attachSession(sessionId)
}

/** Archive a session id (async; hides it without deleting a byte). */
export async function archiveSession(registry, sessionId) {
  await registry.archiveSession(sessionId)
}

/** Seed the projection cache so the sidebar can show the copy's title. */
export async function writeProjectionCache(cache, header, inheritedEventCount, events) {
  if (cache === undefined || typeof cache.coldSnapshot !== 'function') return false
  try {
    const written = await Promise.resolve(cache.coldSnapshot(header, inheritedEventCount, events))
    return written !== false
  } catch {
    return false
  }
}