// Browser half of dsh-schedule-panel. Contributes one sidebar panel icon and
// one main-area page (key `schedule-panel`); no shipped seat is replaced.
window.__ModuleLoader__.load({
  id: 'dsh-schedule-panel',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    const BASE = 'schedule-panel/api'
    const REFRESH_MS = 60_000

    // ---- tiny fetch helpers (same-origin, cookie auth) -------------------
    async function getJson(path) {
      const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    function usePanelData() {
      const [state, setState] = React.useState({ phase: 'loading', snapshot: null, error: null })
      const load = React.useCallback(async (silent = false) => {
        if (!silent) setState((prev) => ({ ...prev, phase: prev.snapshot ? 'refreshing' : 'loading' }))
        try {
          const snapshot = await getJson('/tasks')
          if (!snapshot.ok) throw new Error(snapshot.error ?? 'catalog failed')
          setState({ phase: 'ready', snapshot, error: null })
        } catch (error) {
          setState((prev) => ({ ...prev, phase: 'error', error: String(error?.message ?? error) }))
        }
      }, [])
      React.useEffect(() => {
        load()
        const timer = window.setInterval(() => load(true), REFRESH_MS)
        const es = new EventSource(`${BASE}/events`)
        es.addEventListener('changed', () => load(true))
        es.addEventListener('session', () => load(true))
        es.onerror = () => { /* browser retries; keep silent */ }
        return () => { window.clearInterval(timer); es.close() }
      }, [load])
      return [state, load]
    }

    // ---- formatting ------------------------------------------------------
    const zhWeekday = ['日', '一', '二', '三', '四', '五', '六']
    function fmtTime(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    function frequency(task) {
      switch (task.kind) {
        case 'after': return `延迟 ${Math.round(task.everySeconds / 60)} 分钟（一次性）`
        case 'at': return `定时 ${fmtTime(task.scheduledAt)}（一次性）`
        case 'every': return `每 ${Math.round(task.everySeconds / 60)} 分钟`
        case 'daily': {
      const t = (task.time ?? '').slice(0, 5)
          return `每天 ${t}${task.timeZone ? `（${task.timeZone}）` : ''}`
        }
        case 'weekly': {
          const days = (task.weekdays ?? []).map((d) => `周${zhWeekday[d % 7]}`).join('/')
          return `${days} ${(task.time ?? '').slice(0, 5)}`
        }
        case 'cron': return `Cron ${task.expression ?? ''}`
        default: return task.kind
      }
    }
    function statusChip(task) {
      if (task.status !== 'active') return { text: '已结束', cls: 'sp-chip-ended' }
      if (task.overdue) return { text: '已逾期', cls: 'sp-chip-overdue' }
      return { text: '等待中', cls: 'sp-chip-active' }
    }

    // ---- components ------------------------------------------------------
    function Row({ task, onOpenSession }) {
      const chip = statusChip(task)
      const session = task.sessionTitle || task.sessionId
      return React.createElement('div', { className: 'sp-row' },
        React.createElement('div', { className: 'sp-row-main' },
          React.createElement('div', { className: 'sp-row-title' },
            React.createElement('span', { className: 'sp-name' }, task.title || '(未命名)'),
            React.createElement('span', { className: `sp-chip ${chip.cls}` }, chip.text)),
          React.createElement('div', { className: 'sp-row-sub' },
            React.createElement('span', { className: 'sp-freq' }, frequency(task)),
            React.createElement('span', { className: 'sp-dot' }, '·'),
            React.createElement('span', { className: 'sp-next' },
              task.status === 'active' ? `下次 ${fmtTime(task.scheduledAt)}（${task.nextIn}）` : `最后 ${fmtTime(task.scheduledAt)}`)),
          React.createElement('button', {
            type: 'button', className: 'sp-session', title: '打开来源会话',
            onClick: () => onOpenSession?.(task.sessionId),
          }, `⚙ ${session}${task.sessionRunning ? '（运行中）' : ''}`)),
        task.lastDelivery
          ? React.createElement('div', { className: 'sp-last' },
              '最近投递 ', fmtTime(task.lastDelivery.deliveredAt ?? task.lastDelivery.scheduledAt))
          : null)
    }

    function Panel() {
      const [state, reload] = usePanelData()
      const { phase, snapshot, error } = state
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const openSession = React.useCallback((id) => {
        // Reuse the workspace opener exposed on window by the shell bridge if
        // present; otherwise navigate to the root with the hash the app reads.
        try {
          const w = window
          if (w.__DSH_PANEL_BRIDGE__?.openSession) return w.__DSH_PANEL_BRIDGE__.openSession(id)
        } catch { /* fallthrough */ }
        window.location.hash = `#/session/${id}`
      }, [])
      const tasks = snapshot?.tasks ?? []
      const shown = tasks.filter((task) => {
        if (filter === 'active' && task.status !== 'active') return false
        if (filter === 'ended' && task.status !== 'inactive') return false
        if (filter === 'overdue' && !(task.status === 'active' && task.overdue)) return false
        if (query) {
          const q = query.toLowerCase()
          return (task.title ?? '').toLowerCase().includes(q)
            || (task.sessionTitle ?? '').toLowerCase().includes(q)
            || task.sessionId.toLowerCase().includes(q)
        }
        return true
      })
      const totals = snapshot?.totals
      return React.createElement('div', { className: 'sp-page', 'data-testid': 'schedule-panel-page' },
        React.createElement('style', null, CSS),
        React.createElement('header', { className: 'sp-head' },
          React.createElement('h1', null, '定时任务'),
          React.createElement('button', { type: 'button', className: 'sp-refresh', onClick: () => reload() }, '刷新')),
        totals
          ? React.createElement('div', { className: 'sp-stats' },
              React.createElement('span', null, `共 ${totals.all}`),
              React.createElement('span', null, `启用 ${totals.active}`),
              React.createElement('span', null, `已结束 ${totals.inactive}`),
              React.createElement('span', { className: totals.overdue ? 'sp-warn' : undefined }, `逾期 ${totals.overdue}`),
              React.createElement('span', null, `${totals.sessions} 个会话`))
          : null,
        React.createElement('div', { className: 'sp-toolbar' },
          React.createElement('div', { className: 'sp-tabs', role: 'tablist' },
            [['all', '全部'], ['active', '进行中'], ['overdue', '已逾期'], ['ended', '已结束']].map(([key, label]) =>
              React.createElement('button', {
                key, type: 'button', role: 'tab', 'aria-selected': filter === key,
                className: `sp-tab${filter === key ? ' sp-tab-on' : ''}`,
                onClick: () => setFilter(key),
              }, label))),
          React.createElement('input', {
            className: 'sp-search', type: 'search', placeholder: '搜索任务或会话…',
            value: query, onChange: (event) => setQuery(event.target.value),
          })),
        phase === 'loading' ? React.createElement('p', { className: 'sp-note' }, '正在加载任务…') : null,
        phase === 'error' ? React.createElement('p', { className: 'sp-note sp-error' }, `加载失败：${error}（`, React.createElement('button', { type: 'button', className: 'sp-linkbtn', onClick: () => reload() }, '重试'), '）') : null,
        phase !== 'loading' && phase !== 'error' && shown.length === 0
          ? React.createElement('p', { className: 'sp-note' }, '没有匹配的任务。在会话里让小谢「提醒我…」即可创建。') : null,
        React.createElement('div', { className: 'sp-list' },
          shown.map((task) => React.createElement(Row, { key: task.id, task, onOpenSession: openSession }))))
    }

    const CSS = `
.sp-page{height:100%;overflow:auto;padding:28px clamp(24px,4vw,48px) 48px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.sp-head{display:flex;align-items:center;justify-content:space-between;max-width:960px;margin:0 auto 8px}
.sp-head h1{margin:0;font-size:20px;font-weight:500}
.sp-refresh{border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;border-radius:14px;height:30px;padding:0 14px;cursor:pointer;font:inherit}
.sp-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-stats{display:flex;gap:18px;max-width:960px;margin:0 auto 14px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.sp-warn{color:var(--dsw-alias-state-error-primary,#d33)}
.sp-toolbar{display:flex;gap:12px;align-items:center;max-width:960px;margin:0 auto 14px;flex-wrap:wrap}
.sp-tabs{display:flex;gap:6px}
.sp-tab{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:14px;height:28px;padding:0 12px;cursor:pointer;font:inherit}
.sp-tab:hover,.sp-tab-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sp-search{flex:1;min-width:160px;max-width:360px;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:transparent;color:inherit;padding:0 10px;font:inherit}
.sp-search:focus{outline:1px solid var(--dsw-alias-state-business-primary,#4c7dff);outline-offset:-1px}
.sp-list{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:8px}
.sp-row{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l3,#8884);border-radius:14px;padding:12px 14px}
.sp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-row-main{min-width:0;flex:1}
.sp-row-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sp-name{font-weight:500}
.sp-chip{font-size:11px;border-radius:9px;padding:1px 8px}
.sp-chip-active{background:color-mix(in srgb,#37c26e 18%,transparent);color:#2f9e57}
.sp-chip-overdue{background:color-mix(in srgb,#e5533d 16%,transparent);color:#c4442f}
.sp-chip-ended{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.sp-row-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:13px;display:flex;gap:6px;flex-wrap:wrap}
.sp-dot{opacity:.6}
.sp-session{margin-top:4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:6px}
.sp-session:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sp-last{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.sp-note{max-width:960px;margin:32px auto;color:var(--dsw-alias-label-tertiary)}
.sp-error{color:var(--dsw-alias-state-error-primary,#d33)}
.sp-linkbtn{border:0;background:none;color:inherit;cursor:pointer;text-decoration:underline;font:inherit;padding:0}
@media (prefers-color-scheme: dark){
 .sp-chip-active{background:#2f9e5733;color:#63c98b}
 .sp-chip-overdue{background:#c4442f33;color:#e88; }
}
`

    const inject = ['slots']
    function apply(ctx) {
      const Icon = () => React.createElement('span', {
        style: { fontSize: 15, lineHeight: 1 }, 'aria-hidden': true,
      }, '⏱')
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'schedule-panel',
        order: 12,
        label: '定时面板',
      }, Icon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'schedule-panel',
      }, () => React.createElement(Panel)))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
