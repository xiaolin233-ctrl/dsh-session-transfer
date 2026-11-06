/**
 * Host half of `dsh-session-transfer`.
 *
 * The only responsibility of this entry module is wiring the HTTP surface. All
 * of the move logic lives in `./impl.js`, which is imported afresh on every
 * request so the implementation can be iterated without restarting DSH.
 */

import { pathToFileURL, fileURLToPath } from 'node:url'

export const name = 'dsh-session-transfer'
export const inject = ['webServer']

const ROUTE = '/dsh-session-transfer'
const IMPL_PATH = fileURLToPath(new URL('./impl.js', import.meta.url))
const MAX_BODY_BYTES = 1 << 20

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      finish(reject, new Error('request body timed out'))
      req.destroy()
    }, 15_000)
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(reject, new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => finish(reject, error))
  })
}

/** Import the current implementation, bypassing the ESM module cache. */
async function loadImplementation() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return import(`${pathToFileURL(IMPL_PATH).href}?stamp=${stamp}`)
}

export function apply(ctx) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === `${ROUTE}/state`) {
        const impl = await loadImplementation()
        sendJson(
          res,
          200,
          await impl.state(ctx, {
            sessionId: url.searchParams.get('sessionId') ?? '',
            targetWorkspaceId: url.searchParams.get('targetWorkspaceId') ?? '',
          }),
        )
        return
      }
      if (req.method === 'POST' && url.pathname === `${ROUTE}/transfer`) {
        const raw = await readBody(req)
        let body
        try {
          body = raw.trim() === '' ? {} : JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad-json', message: 'request body is not valid JSON' })
          return
        }
        const impl = await loadImplementation()
        sendJson(res, 200, await impl.transfer(ctx, body))
        return
      }
      sendJson(res, 404, { ok: false, code: 'not-found', message: `unknown route ${req.method} ${url.pathname}` })
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message })
      else res.destroy()
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler })
  ctx.effect(() => dispose, 'dsh-session-transfer:http')
}