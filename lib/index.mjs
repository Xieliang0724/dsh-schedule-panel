// dsh-schedule-panel — host half.
// 聚合只读面板 API：
//   GET /schedule-panel/api/health   服务自检
//   GET /schedule-panel/api/tasks    全量任务 + 会话标题 + 最近投递
//   GET /schedule-panel/api/next?hours=24  未来 N 小时时间线
//   GET /schedule-panel/api/events   SSE 变更流（schedule/changed、会话状态）
// 认证复用 WebUI 同一体系（connection.authorizeIndex），peer 走 owner 身份。
const PLUGIN_VERSION = '0.1.0'
const BASE = '/schedule-panel'

/** One JSON response with CORS-free same-origin headers. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** True when the request originates from loopback (admin parity with mobile-gateway). */
function isLoopback(req) {
  const remote = req.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** Strip to the fields the panel renders; never leak prompt bodies or tokens. */
function publicTask(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    scheduledAt: row.scheduledAt,
    status: row.status,
    sessionId: row.sessionId,
    everySeconds: row.everySeconds,
    time: row.time,
    timeZone: row.timeZone,
    weekdays: row.weekdays,
    expression: row.expression,
    lastDelivery: row.lastDelivery ?? null,
  }
}

/** Relative-time label, zh, minute granularity; stable for tests. */
function relativeFrom(ms, now) {
  const delta = Math.round((ms - now) / 60000)
  if (Math.abs(delta) < 1) return '刚刚'
  const abs = Math.abs(delta)
  const unit = abs >= 1440 ? `${Math.round(abs / 1440)} 天`
    : abs >= 60 ? `${Math.round(abs / 60)} 小时`
      : `${abs} 分钟`
  return delta > 0 ? `${unit}后` : `${unit}前`
}

/** Compose the panel payload: catalog joined with live session titles. */
async function buildSnapshot(dsh) {
  const catalog = await dsh.invoke('catalog', {})
  if (!catalog.ok) return { ok: false, error: catalog.error }
  const now = Date.now()
  const seen = new Map()
  const tasks = []
  for (const raw of catalog.value ?? []) {
    const task = publicTask(raw)
    seen.set(task.sessionId, (seen.get(task.sessionId) ?? 0) + 1)
    task.nextInMs = Date.parse(task.scheduledAt) - now
    task.nextIn = relativeFrom(Date.parse(task.scheduledAt), now)
    task.overdue = task.status === 'active' && task.nextInMs < 0
    tasks.push(task)
  }
  const sessions = {}
  for (const sessionId of seen.keys()) {
    try {
      const frame = await dsh.sessionSummary(sessionId)
      if (frame) sessions[sessionId] = frame
    } catch { /* title stays absent */ }
  }
  for (const task of tasks) {
    const session = sessions[task.sessionId]
    task.sessionTitle = session?.title ?? null
    task.sessionRunning = session?.running ?? false
  }
  tasks.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  const active = tasks.filter((task) => task.status === 'active')
  return {
    ok: true,
    now,
    totals: {
      all: tasks.length,
      active: active.length,
      inactive: tasks.length - active.length,
      overdue: active.filter((task) => task.overdue).length,
      sessions: seen.size,
    },
    tasks,
  }
}

const plugin = {
  name: 'schedule-panel',
  inject: ['webServer', 'connection', 'typertGateway', 'schedule'],
  apply(ctx, config) {
    const webServer = ctx.webServer
    const connection = ctx.connection
    const log = (...lines) => console.log('[schedule-panel]', ...lines)
    log(`applying: webServer.port=${webServer.port} peer=${typeof connection?.createPeer === 'function'}`)

    // One owner-scoped peer for every Remote call; the panel never accepts
    // caller-chosen identities, matching the mobile-gateway precedent.
    const peer = typeof connection?.createPeer === 'function'
      ? connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
      : undefined

    /** Typed-gateway call helper; resolves { ok, value } | { ok:false, error }. */
    const invoke = async (method, args, signal) => {
      try {
        const value = await ctx.typertGateway.invoke({
          namespace: 'schedule', method, args: args ?? {}, peer,
          ...(signal === undefined ? {} : { signal }),
        })
        return { ok: true, value }
      } catch (error) {
        log(`invoke ${method} failed: ${String(error?.message ?? error)}`)
        return { ok: false, error: { code: 'panel/invoke-failed', message: String(error?.message ?? error) } }
      }
    }

    /** Session title/running via a one-shot follow baseline frame. */
    const sessionSummary = async (sessionId) => {
      let stream
      try {
        stream = await ctx.typertGateway.stream({
          namespace: 'session', method: 'follow',
          args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } }, peer,
        })
        for await (const frame of stream) {
          if (frame?.type === 'snapshot') {
            return {
              // Title lives in the follow baseline's projection values.
              title: frame?.projections?.values?.title ?? frame?.header?.title ?? null,
              running: frame?.projections?.values?.sessionListMetadata?.blank === false
                ? frame?.running ?? false
                : frame?.running ?? false,
            }
          }
          break // baseline only; deltas ignored
        }
      } catch { /* title stays absent */ }
      finally {
        await stream?.return?.()
      }
      return null
    }

    const dsh = { invoke, sessionSummary }

    // ---- SSE change fan-out ---------------------------------------------
    const streams = new Set()
    const broadcast = (event) => {
      const payload = `event: ${event}\ndata: {}\n\n`
      for (const res of streams) {
        try { res.write(payload) } catch { streams.delete(res) }
      }
    }
    const disposeChanged = ctx.on('schedule/changed', () => broadcast('changed'))
    const disposeStatus = ctx.on('api-session/status', () => broadcast('session'))
    const disposeAdded = ctx.on('api-session/added', () => broadcast('session'))
    const disposeRemoved = ctx.on('api-session/removed', () => broadcast('session'))

    // ---- routes ----------------------------------------------------------
    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: async (req, res) => {
        log(`request ${req.method} ${req.url}`)
        // Same auth fence as the WebUI index: cookie or ?token=; the panel
        // never serves data to unauthenticated readers.
        const url = new URL(req.url ?? '/', 'http://x')
        const path = url.pathname
        if (path !== `${BASE}/api/events`) {
          if (!connection.authorizeIndex(req, res, webServer.protocol === 'https:')) return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return
        }
        try {
          if (path === `${BASE}/api/health`) {
            const ok = ctx.schedule !== undefined && peer !== undefined
            sendJson(res, 200, { ok, version: PLUGIN_VERSION, hasSchedule: ok })
            return
          }
          if (path === `${BASE}/api/tasks`) {
            const snapshot = await buildSnapshot(dsh)
            sendJson(res, snapshot.ok ? 200 : 502, snapshot)
            return
          }
          if (path === `${BASE}/api/next`) {
            const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24))
            const snapshot = await buildSnapshot(dsh)
            if (!snapshot.ok) { sendJson(res, 502, snapshot); return }
            const horizon = snapshot.now + hours * 3600_000
            const upcoming = snapshot.tasks.filter((task) =>
              task.status === 'active'
              && Date.parse(task.scheduledAt) >= snapshot.now - 3600_000
              && Date.parse(task.scheduledAt) <= horizon)
            sendJson(res, 200, { ok: true, now: snapshot.now, hours, tasks: upcoming })
            return
          }
          if (path === `${BASE}/api/events`) {
            // SSE requires the same auth; EventSource cannot set headers, so
            // accept cookie (automatic) — token query works too via authorizeIndex.
            if (!connection.authorizeIndex(req, res, webServer.protocol === 'https:')) return
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            })
            res.write(':ok\n\n')
            streams.add(res)
            req.on('close', () => streams.delete(res))
            return
          }
          if (path === `${BASE}` || path === `${BASE}/`) {
            res.writeHead(302, { location: '../' }); res.end(); return
          }
          res.writeHead(404); res.end()
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })

    const disposePeer = () => peer?.dispose?.()
    return () => {
      for (const res of streams) { try { res.end() } catch { /* gone */ } }
      streams.clear()
      disposeRoute(); disposeChanged(); disposeStatus(); disposeAdded(); disposeRemoved(); disposePeer()
    }
  },
}

export const Config = undefined
export default plugin
export { plugin }
