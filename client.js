/**
 * dsh-session-transfer - browser half.
 *
 * One sidebar menu row ("Transfer to another workspace…") and one dialog on the
 * overlay layer. The host half owns the real work: it replays the source
 * session's event log into a new session inside the target workspace, so the
 * copy keeps its title, tool calls and token accounting, and can be continued.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-transfer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useReducer, useRef, useCallback } = React

    const ROUTE = '/dsh-session-transfer'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'

    // The app's own document language wins; a shell still serving its default
    // `lang="en"` has not synced it yet, so the browser's order decides then.
    const detectZh = (documentLanguage, browserLanguage) => {
      const tag = typeof documentLanguage === 'string' ? documentLanguage : ''
      if (/^zh(-|$)/i.test(tag)) return true
      if (tag !== '' && !/^en(-|$)/i.test(tag)) return false
      const first = Array.isArray(browserLanguage) ? browserLanguage[0] : browserLanguage
      return typeof first === 'string' && /^zh(-|$)/i.test(first)
    }
    const zh = detectZh(
      typeof document !== 'undefined' ? document.documentElement?.lang : '',
      typeof navigator !== 'undefined' ? navigator.languages || navigator.language : '',
    )

    const COPY = zh
      ? {
          menuLabel: '转移到其他工作区…',
          dialogTitle: '转移对话',
          dialogIntro: '完整的事件日志会原样复制到目标工作区：标题、工具调用与 token 用量都会保留，对话可以继续。',
          currentLabel: '当前工作区',
          targetLabel: '目标工作区',
          loading: '正在读取工作区…',
          noTargets: '还没有可用的其他工作区。先在侧栏新建一个工作区，再回来转移。',
          sessionCount: (n) => `${n} 个对话`,
          eventsCopied: (n) => `已复制 ${n} 条事件`,
          keepOriginal: '保留原工作区的对话',
          keepOriginalHint: '不勾选时原对话会被归档；归档不删除数据，可在侧栏「已归档」中恢复。',
          bulk: (n) => `同时转移该工作区全部 ${n} 个对话`,
          bulkHint: '逐个复制；子代理会话不会被转移。',
          cancel: '取消',
          confirm: '转移',
          busy: '正在转移…',
          doneTitle: '转移完成',
          openNew: '打开新会话',
          finish: '完成',
          archivedOriginal: '原对话已归档',
          keptOriginal: '原对话已保留',
          noteOriginalActive: '原对话仍在运行，已保留',
          noteArchiveFailed: '原对话归档失败',
          partialNote: (id) => `已写入部分副本 ${id}，可手动清理。`,
          closeLabel: '关闭',
          loadFailed: '无法读取工作区列表',
          transferFailed: '转移失败',
          noEvents: '这段对话还没有可复制的事件',
          noneSucceeded: '没有任何对话被转移',
        }
      : {
          menuLabel: 'Transfer to another workspace…',
          dialogTitle: 'Transfer conversation',
          dialogIntro:
            'The full event log is copied into the target workspace — title, tool calls and token usage included, so the conversation can continue.',
          currentLabel: 'Current workspace',
          targetLabel: 'Target workspace',
          loading: 'Reading workspaces…',
          noTargets: 'No other workspace yet. Create one in the sidebar, then come back.',
          sessionCount: (n) => `${n} conversation${n === 1 ? '' : 's'}`,
          eventsCopied: (n) => `${n} event${n === 1 ? '' : 's'} copied`,
          keepOriginal: 'Keep the conversation in the source workspace',
          keepOriginalHint:
            'Unchecked, the source conversation is archived. Archiving hides it without deleting anything; restore it from Archived in the sidebar.',
          bulk: (n) => `Also transfer all ${n} conversations in this workspace`,
          bulkHint: 'Copied one by one; subagent sessions are skipped.',
          cancel: 'Cancel',
          confirm: 'Transfer',
          busy: 'Transferring…',
          doneTitle: 'Transfer complete',
          openNew: 'Open new session',
          finish: 'Done',
          archivedOriginal: 'source archived',
          keptOriginal: 'source kept',
          noteOriginalActive: 'source was still running, so it was kept',
          noteArchiveFailed: 'source archive failed',
          partialNote: (id) => `A partial copy remains at ${id}; you can clean it up.`,
          closeLabel: 'Close',
          loadFailed: 'Could not read the workspace list',
          transferFailed: 'Transfer failed',
          noEvents: 'This conversation has no events to copy yet',
          noneSucceeded: 'No conversation was transferred',
        }

    const CSS = `
.dst-menu-item {
  display: flex; align-items: center; gap: 8px;
  box-sizing: border-box; width: 100%; height: 30px; padding: 0 10px;
  border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 18px;
  text-align: start; cursor: pointer; white-space: nowrap;
}
.dst-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dst-menu-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dst-menu-icon { flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); }

.dst-scrim {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; box-sizing: border-box;
  background: rgba(0, 0, 0, 0.38);
  pointer-events: auto;
}
.dst-panel {
  position: relative; box-sizing: border-box;
  display: flex; flex-direction: column;
  width: min(520px, 100%); max-height: min(640px, 100%);
  border: 0.5px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l4));
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  color: var(--dsw-alias-label-primary);
  outline: none;
}
.dst-header { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 10px; }
.dst-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dst-title { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; }
.dst-intro { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dst-close {
  margin-inline-start: auto; flex: none;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 16px; line-height: 1; cursor: pointer;
}
.dst-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dst-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 20px 16px; min-height: 0; overflow: auto; }
.dst-section { display: flex; flex-direction: column; gap: 6px; }
.dst-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; letter-spacing: 0.02em; }
.dst-source { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
.dst-list { display: flex; flex-direction: column; gap: 2px; }
.dst-option {
  display: flex; align-items: center; gap: 10px;
  box-sizing: border-box; padding: 8px 10px; cursor: pointer;
  border: 0.5px solid transparent; border-radius: var(--dsw-radius-md);
}
.dst-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dst-option[data-selected='true'] {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dst-radio { flex: none; margin: 0; accent-color: var(--dsw-alias-state-business-primary); }
.dst-option-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dst-option-title { font-size: 13px; line-height: 18px; }
.dst-option-path { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.dst-option-count { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dst-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 18px; cursor: pointer; }
.dst-check input { flex: none; margin: 2px 0 0; accent-color: var(--dsw-alias-state-business-primary); }
.dst-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dst-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dst-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dst-results { display: flex; flex-direction: column; gap: 10px; }
.dst-result { display: flex; flex-direction: column; gap: 2px; }
.dst-result-head { display: flex; align-items: center; gap: 8px; }
.dst-result-mark { flex: none; width: 16px; text-align: center; font-size: 13px; }
.dst-result-ok .dst-result-mark { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary)); }
.dst-result-fail .dst-result-mark { color: var(--dsw-alias-state-error-primary); }
.dst-result-title { font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
.dst-result-body { padding-inline-start: 24px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dst-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; }
.dst-button {
  box-sizing: border-box; height: 32px; padding: 0 14px;
  border-radius: var(--dsw-radius-md); border: 0.5px solid transparent;
  font-family: inherit; font-size: 13px; line-height: 18px; cursor: pointer;
}
.dst-button:disabled { opacity: 0.5; cursor: default; }
.dst-button-primary { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-inverse, #fff); font-weight: 500; }
.dst-button-outline { background: transparent; border-color: var(--dsw-alias-border-l4); color: var(--dsw-alias-label-primary); }
.dst-button-ghost { background: transparent; color: var(--dsw-alias-label-secondary); }
.dst-button-outline:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dst-button-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dst-button-primary:hover { filter: brightness(1.06); }
`

    let pluginCtx = null

    const getService = (key) => {
      if (pluginCtx === null) return null
      try {
        return pluginCtx.get?.(key) ?? null
      } catch (error) {
        return null
      }
    }

    const newSessionIdOf = (result) =>
      result !== null && typeof result === 'object' && typeof result.newSessionId === 'string' && result.newSessionId !== ''
        ? result.newSessionId
        : null

    // ---- request store: menu row -> overlay dialog -------------------------

    let pending = null
    const listeners = new Set()

    const emit = () => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.warn('dsh-session-transfer: dialog listener failed', error)
        }
      }
    }

    const openTransfer = (request) => {
      pending = request
      emit()
    }

    const closeTransfer = () => {
      if (pending === null) return
      pending = null
      emit()
    }

    const usePendingTransfer = () => {
      const [, force] = useReducer((value) => value + 1, 0)
      useEffect(() => {
        const listener = () => force()
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return pending
    }

    // ---- transport --------------------------------------------------------

    const requestJson = async (url, init, timeoutMs) => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          ...init,
          ...(controller === null ? {} : { signal: controller.signal }),
        })
        const text = await response.text()
        let payload = null
        try {
          payload = text === '' ? null : JSON.parse(text)
        } catch (error) {
          payload = null
        }
        if (payload === null) {
          return { ok: false, code: 'bad-response', message: `HTTP ${response.status}` }
        }
        return payload
      } catch (error) {
        return {
          ok: false,
          code: 'network',
          message: error instanceof Error ? error.message : String(error),
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    const answerOf = (payload) =>
      payload !== null && typeof payload === 'object'
        ? payload
        : { ok: false, code: 'bad-response', message: COPY.transferFailed }

    const messageOf = (payload) => {
      const message = payload?.message
      return typeof message === 'string' && message !== '' ? message : COPY.transferFailed
    }

    // ---- components -------------------------------------------------------

    let inlineStyleNeeded = true
    const StyleTag = () => (inlineStyleNeeded ? h('style', null, CSS) : null)

    const TransferIcon = () =>
      h(
        'svg',
        {
          className: 'dst-menu-icon',
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('rect', { x: 1.6, y: 3, width: 4.6, height: 10, rx: 1.2 }),
        h('rect', { x: 9.8, y: 3, width: 4.6, height: 10, rx: 1.2 }),
        h('path', { d: 'M6.9 8h2.4M8.4 6.6 9.9 8l-1.5 1.4' }),
      )

    const Button = ({ variant = 'outline', children, ...rest }) =>
      h('button', { type: 'button', className: `dst-button dst-button-${variant}`, ...rest }, children)

    const TransferMenuItem = ({ sessionId, displayTitle, useMenuOpenState }) => {
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : null
      const label = COPY.menuLabel
      const onSelect = () => {
        if (typeof closeMenu === 'function') closeMenu(false)
        openTransfer({
          sessionId: String(sessionId ?? ''),
          title: typeof displayTitle === 'string' ? displayTitle : '',
        })
      }
      return h(
        React.Fragment,
        null,
        h(StyleTag, null),
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dst-menu-item',
            title: label,
            onClick: onSelect,
          },
          h(TransferIcon, null),
          h('span', null, label),
        ),
      )
    }

    const shortId = (id) => (typeof id === 'string' && id.length > 18 ? `${id.slice(0, 18)}…` : String(id ?? ''))

    const ResultRow = ({ item }) => {
      const title =
        typeof item?.title === 'string' && item.title !== '' ? item.title : shortId(item?.sessionId)
      if (item?.ok === true) {
        const extras = []
        extras.push(item.archivedOriginal === true ? COPY.archivedOriginal : COPY.keptOriginal)
        if (item.note === 'original-active') extras.push(COPY.noteOriginalActive)
        else if (typeof item.note === 'string' && item.note.startsWith('original-archive-failed')) {
          extras.push(COPY.noteArchiveFailed)
        }
        return h(
          'div',
          { className: 'dst-result dst-result-ok' },
          h(
            'div',
            { className: 'dst-result-head' },
            h('span', { className: 'dst-result-mark', 'aria-hidden': 'true' }, '✓'),
            h('span', { className: 'dst-result-title' }, title),
          ),
          h('div', { className: 'dst-result-body' }, COPY.eventsCopied(Number(item.eventCount ?? 0)), ' · ', extras.join(' · ')),
        )
      }
      return h(
        'div',
        { className: 'dst-result dst-result-fail' },
        h(
          'div',
          { className: 'dst-result-head' },
          h('span', { className: 'dst-result-mark', 'aria-hidden': 'true' }, '×'),
          h('span', { className: 'dst-result-title' }, title),
        ),
        h('div', { className: 'dst-result-body' }, typeof item?.message === 'string' ? item.message : COPY.transferFailed),
        typeof item?.partialSessionId === 'string' && item.partialSessionId !== ''
          ? h('div', { className: 'dst-result-body' }, COPY.partialNote(item.partialSessionId))
          : null,
      )
    }

    const TransferPanel = ({ request }) => {
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [sourceWorkspaceId, setSourceWorkspaceId] = useState(null)
      const [sourceSessionIds, setSourceSessionIds] = useState([])
      const [sessionInfo, setSessionInfo] = useState(null)
      const [targetId, setTargetId] = useState(null)
      const [keepOriginal, setKeepOriginal] = useState(false)
      const [bulk, setBulk] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)

      const panelRef = useRef(null)
      const busyRef = useRef(false)
      busyRef.current = busy

      const dismiss = useCallback(() => {
        if (busyRef.current) return
        closeTransfer()
      }, [])

      useEffect(() => {
        let cancelled = false
        setPhase('loading')
        setError(null)
        requestJson(`${ROUTE}/state?sessionId=${encodeURIComponent(request.sessionId)}`, { method: 'GET' }, 30000)
          .then((payload) => {
            if (cancelled) return
            const data = answerOf(payload)
            if (data.ok !== true) {
              setError(messageOf(data))
              setPhase('error')
              return
            }
            const list = Array.isArray(data.workspaces) ? data.workspaces : []
            const currentWorkspaceId = typeof data.currentWorkspaceId === 'string' ? data.currentWorkspaceId : null
            const candidates = list.filter((item) => item.id !== currentWorkspaceId)
            setWorkspaces(list)
            setSessionInfo(data.session ?? null)
            setSourceWorkspaceId(currentWorkspaceId)
            setSourceSessionIds(Array.isArray(data.sourceSessionIds) ? data.sourceSessionIds : [])
            setTargetId(candidates.length > 0 ? candidates[0].id : null)
            setPhase('ready')
          })
          .catch((thrown) => {
            if (cancelled) return
            setError(thrown instanceof Error ? thrown.message : String(thrown))
            setPhase('error')
          })
        return () => {
          cancelled = true
        }
      }, [request.sessionId])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            dismiss()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [dismiss])

      useEffect(() => {
        panelRef.current?.focus?.()
      }, [phase])

      const candidates = workspaces.filter((item) => item.id !== sourceWorkspaceId)
      const sourceWorkspace =
        sourceWorkspaceId === null ? null : workspaces.find((item) => item.id === sourceWorkspaceId) ?? null
      const bulkCount = Math.max(0, sourceSessionIds.length)

      const refreshCatalog = () => {
        const sessions = getService('sessions')
        if (sessions !== null && typeof sessions.refresh === 'function') {
          Promise.resolve(sessions.refresh()).catch(() => {})
        }
      }

      const submit = async () => {
        if (busyRef.current || targetId === null) return
        const sessionIds = bulk && bulkCount > 1 ? [...sourceSessionIds] : [request.sessionId]
        const titles = {}
        if (request.title !== '') titles[request.sessionId] = request.title
        setBusy(true)
        setError(null)
        try {
          const payload = await requestJson(
            `${ROUTE}/transfer`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionIds, targetWorkspaceId: targetId, keepOriginal, titles }),
            },
            180000,
          )
          const data = answerOf(payload)
          if (Array.isArray(data.results)) {
            setResult(data)
            setPhase('done')
            refreshCatalog()
            for (const item of data.results) {
              if (item?.ok !== true) continue
              const newId = newSessionIdOf(item)
              const sessions = getService('sessions')
              if (newId !== null && sessions !== null && typeof sessions.refreshProjections === 'function') {
                Promise.resolve(sessions.refreshProjections(newId)).catch(() => {})
              }
            }
            return
          }
          setError(messageOf(data))
        } catch (thrown) {
          setError(thrown instanceof Error ? thrown.message : String(thrown))
        } finally {
          setBusy(false)
        }
      }

      const openNew = (sessionId) => {
        const uiWorkspace = getService('uiWorkspace')
        if (uiWorkspace === null || typeof uiWorkspace.openSession !== 'function') return
        closeTransfer()
        Promise.resolve(uiWorkspace.openSession(sessionId)).catch(() => {})
      }

      const body = () => {
        if (phase === 'done') {
          const results = Array.isArray(result?.results) ? result.results : []
          return h(
            'div',
            { className: 'dst-results' },
            h('div', { className: 'dst-label' }, COPY.doneTitle),
            ...results.map((item, index) =>
              h(ResultRow, { key: `${item?.sessionId ?? 'row'}-${index}`, item }),
            ),
          )
        }
        if (phase === 'loading') {
          return h('div', { className: 'dst-empty' }, COPY.loading)
        }
        if (phase === 'error') {
          return h('div', { className: 'dst-error' }, error ?? COPY.loadFailed)
        }
        const sessionTitle =
          request.title !== ''
            ? request.title
            : typeof sessionInfo?.title === 'string' && sessionInfo.title !== ''
              ? sessionInfo.title
              : shortId(request.sessionId)
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dst-section' },
            h('div', { className: 'dst-label' }, COPY.currentLabel),
            h('div', { className: 'dst-source' }, sessionTitle),
          ),
          h(
            'div',
            { className: 'dst-section' },
            h('div', { className: 'dst-label' }, COPY.targetLabel),
            candidates.length === 0
              ? h('div', { className: 'dst-empty' }, COPY.noTargets)
              : h(
                  'div',
                  { className: 'dst-list', role: 'radiogroup', 'aria-label': COPY.targetLabel },
                  ...candidates.map((workspace) =>
                    h(
                      'label',
                      {
                        key: workspace.id,
                        className: 'dst-option',
                        'data-selected': String(targetId === workspace.id),
                      },
                      h('input', {
                        type: 'radio',
                        className: 'dst-radio',
                        name: 'dst-target',
                        value: workspace.id,
                        checked: targetId === workspace.id,
                        disabled: busy,
                        onChange: () => setTargetId(workspace.id),
                      }),
                      h(
                        'span',
                        { className: 'dst-option-text' },
                        h('span', { className: 'dst-option-title' }, workspace.title || workspace.path),
                        h('span', { className: 'dst-option-path' }, workspace.path),
                      ),
                      h('span', { className: 'dst-option-count' }, COPY.sessionCount(workspace.sessionCount)),
                    ),
                  ),
                ),
          ),
          candidates.length === 0
            ? null
            : h(
                'div',
                { className: 'dst-section' },
                h(
                  'label',
                  { className: 'dst-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: keepOriginal,
                    disabled: busy,
                    onChange: (event) => setKeepOriginal(event.target.checked === true),
                  }),
                  h('span', null, COPY.keepOriginal),
                ),
                h('p', { className: 'dst-hint' }, COPY.keepOriginalHint),
                bulkCount > 1
                  ? h(
                      'label',
                      { className: 'dst-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: bulk,
                        disabled: busy,
                        onChange: (event) => setBulk(event.target.checked === true),
                      }),
                      h('span', null, COPY.bulk(bulkCount)),
                    )
                  : null,
                bulkCount > 1 ? h('p', { className: 'dst-hint' }, COPY.bulkHint) : null,
              ),
          error !== null ? h('div', { className: 'dst-error' }, error) : null,
        )
      }

      const footer = () => {
        if (phase === 'done') {
          const results = Array.isArray(result?.results) ? result.results : []
          const firstNewId = results.map((item) => (item?.ok === true ? newSessionIdOf(item) : null)).find((id) => id !== null) ?? null
          return h(
            'div',
            { className: 'dst-footer' },
            firstNewId === null
              ? null
              : h(Button, { variant: 'primary', onClick: () => openNew(firstNewId) }, COPY.openNew),
            h(Button, { variant: 'outline', onClick: dismiss }, COPY.finish),
          )
        }
        return h(
          'div',
          { className: 'dst-footer' },
          h(Button, { variant: 'ghost', onClick: dismiss, disabled: busy }, COPY.cancel),
          h(
            Button,
            {
              variant: 'primary',
              onClick: submit,
              disabled: busy || phase !== 'ready' || targetId === null,
            },
            busy ? COPY.busy : COPY.confirm,
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h(StyleTag, null),
        h(
          'div',
          {
            className: 'dst-scrim',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) dismiss()
            },
          },
          h(
            'div',
            {
              className: 'dst-panel',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'dst-title',
              tabIndex: -1,
              ref: panelRef,
            },
            h(
              'div',
              { className: 'dst-header' },
              h(
                'div',
                { className: 'dst-heading' },
                h('h2', { className: 'dst-title', id: 'dst-title' }, COPY.dialogTitle),
                h('p', { className: 'dst-intro' }, COPY.dialogIntro),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dst-close',
                  'aria-label': COPY.closeLabel,
                  title: COPY.closeLabel,
                  onClick: dismiss,
                  disabled: busy,
                },
                '✕',
              ),
            ),
            h('div', { className: 'dst-body' }, body()),
            footer(),
          ),
        ),
      )
    }

    const TransferDialog = () => {
      const request = usePendingTransfer()
      if (request === null) return null
      return h(TransferPanel, { key: `${request.sessionId}:${request.title}`, request })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        // One package-owned stylesheet beats a <style> element inside a menu list: the
        // list's keyboard walk reads the DOM, so a non-button sibling is best avoided.
        try {
          const stylesService = typeof ctx.get === 'function' ? ctx.get('styles') : undefined
          if (stylesService !== undefined && typeof stylesService.insert === 'function') {
            stylesService.insert(CSS)
            inlineStyleNeeded = false
          }
        } catch (error) {
          console.warn('dsh-session-transfer: styles.insert unavailable, falling back to an inline <style>', error)
        }
        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            {
              name: MENU_SLOT,
              id: 'dsh-session-transfer:menu',
              order: 350,
              label: () => COPY.menuLabel,
            },
            TransferMenuItem,
          ),
        )
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register(
            {
              name: OVERLAY_SLOT,
              id: 'dsh-session-transfer:dialog',
              order: 60,
            },
            TransferDialog,
          ),
        )
      },
    }
  },
})