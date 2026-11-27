window.__ModuleLoader__.load({
  id: 'dsh-rollback',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dshRollback'
    const API = 'dsh-rollback/api'
    const AUTOFILL_KEY = 'dsh-rollback:autofill'

    /** Set by `apply()`; the fallback translator for seats that omit `t`. */
    let localeService = null

    const EN = {
      label: 'Roll back to here',
      title: 'Roll back conversation',
      body: 'This removes the selected message and everything after it ({count} messages).',
      empty: 'This removes the entire conversation. The session keeps its id and its log.',
      warning: 'Removed messages cannot be recovered.',
      sideEffects: 'The running turn is cancelled; queued input and background jobs are cleaned up.',
      cancel: 'Cancel',
      confirm: 'Roll back',
      working: 'Rolling back…',
      busy: 'Another window is already rolling this session back. Try again in a moment.',
      failed: 'Rollback failed: {message}',
      nav: 'Rollback',
      settingsTitle: 'Conversation rollback',
      settingsDesc: 'Adds a rollback control to each user message and removes the chosen message plus everything after it.',
      autofill: 'Refill the composer with the removed message',
      autofillHint: 'The message text returns to the input box so you can edit and resend it. Attachments are not restored.',
    }

    const ZH = {
      label: '回退到此处',
      title: '回退对话',
      body: '将删除从这里开始的 {count} 条消息（含所选这条）。',
      empty: '将清空整个对话。会话 ID 与历史日志保留。',
      warning: '被删除的消息无法恢复。',
      sideEffects: '正在运行的轮次会被取消，排队消息与后台任务会被清理。',
      cancel: '取消',
      confirm: '回退',
      working: '正在回退…',
      busy: '另一个窗口正在回退这个会话，请稍后再试。',
      failed: '回退失败：{message}',
      nav: '对话回退',
      settingsTitle: '对话回退',
      settingsDesc: '在每条用户消息上增加回退按钮，删除所选消息及其之后的全部内容。',
      autofill: '回退后把消息回填到输入框',
      autofillHint: '消息文字会回到输入框，方便编辑后重新发送；不恢复附件。',
    }

    const DICTS = { en: EN, zh: ZH }

    function languageOf(locale) {
      let active = 'en'
      try { active = locale?.getSnapshot?.()?.active ?? 'en' } catch { /* keep default */ }
      return String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function makeTranslate(locale) {
      return (key, params) => {
        const lang = languageOf(locale)
        let text = DICTS[lang][key] ?? DICTS.en[key] ?? key
        if (typeof text === 'string' && params) {
          for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
        }
        return text
      }
    }

    /** Absolute-free URL: the browser resolves it against the document base URI. */
    function apiUrl(method) {
      return `${API}/${method}`
    }

    async function post(method, payload) {
      const response = await fetch(apiUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let body = null
      try { body = await response.json() } catch { /* non-JSON error page */ }
      if (!response.ok || body?.ok !== true) {
        const message = typeof body?.error === 'string'
          ? body.error
          : body?.error?.message ?? body?.message ?? `HTTP ${response.status}`
        const failure = new Error(message)
        // The host tags refusals it expects the UI to explain; anything else
        // keeps the host's own message.
        if (typeof body?.code === 'string') failure.code = body.code
        throw failure
      }
      return body.result
    }

    function textOfBlocks(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n').trim()
    }

    function autofillEnabled() {
      try { return globalThis.localStorage?.getItem(AUTOFILL_KEY) !== 'off' } catch { return true }
    }

    function setAutofill(value) {
      try { globalThis.localStorage?.setItem(AUTOFILL_KEY, value ? 'on' : 'off') } catch { /* private mode */ }
    }

    // ---------------------------------------------------------------------
    // UI hiding. A rollback appends one `system/message` replacement whose
    // message source is `rollback-cut`; the event names the surface nodes it
    // shadowed in `sourceEventSeqs`. Chat rows are built from append-origin
    // events, so a shadowed row disappears only when a Definition of the same
    // target claims that event exclusively: the official Definition then builds
    // no Context at all.
    //
    // The claim set is a per-session seq range instead of `sourceEventSeqs`
    // alone, because most rows (turn tails, assistant steps, tool calls, turn
    // errors) hang off log-only events that a surface replacement never shadows.
    // Everything in [start, replacement seq) belongs to the removed suffix;
    // events appended after the replacement stay visible.
    // ---------------------------------------------------------------------
    const shadowedEvents = new WeakSet()
    const sessionCuts = new Map()

    // ---------------------------------------------------------------------
    // One rollback per Session at a time. The button that started it holds the
    // latch: every other rollback button in the same Session renders disabled
    // and the composer is blocked, so a second confirmation cannot interleave
    // its cancel / inbox-clear / job-kill phase with the first.
    // ---------------------------------------------------------------------
    const busySessions = new Map()
    const busyListeners = new Set()

    function isSessionBusy(sessionId) {
      return (busySessions.get(sessionId) ?? 0) > 0
    }

    function notifyBusy() {
      for (const listener of [...busyListeners]) {
        try { listener() } catch { /* a broken subscriber must not break the latch */ }
      }
    }

    /** Take the latch for one Session; the returned disposer releases it once. */
    function beginBusy(sessionId) {
      busySessions.set(sessionId, (busySessions.get(sessionId) ?? 0) + 1)
      notifyBusy()
      let ended = false
      return () => {
        if (ended) return
        ended = true
        const next = (busySessions.get(sessionId) ?? 1) - 1
        if (next > 0) busySessions.set(sessionId, next)
        else busySessions.delete(sessionId)
        notifyBusy()
      }
    }

    function subscribeBusy(listener) {
      busyListeners.add(listener)
      return () => { busyListeners.delete(listener) }
    }

    function scanWindow(sessionId, entries) {
      const list = entries ?? []
      let cut = sessionCuts.get(sessionId)
      for (const entry of list) {
        if (entry?.type !== 'event') continue
        const event = entry.event
        if (!event || event.type !== 'system/message') continue
        if (typeof event.surfaceOp !== 'object' || event.surfaceOp === null) continue
        const source = event.data?.message?.source
        if (source?.kind !== 'rollback-cut') continue
        let from = Number.POSITIVE_INFINITY
        for (const seq of event.sourceEventSeqs ?? []) {
          if (typeof seq === 'number' && seq < from) from = seq
        }
        if (!Number.isFinite(from)) continue
        if (cut === undefined) cut = { start: from, end: event.seq }
        else {
          cut.start = Math.min(cut.start, from)
          cut.end = Math.max(cut.end, event.seq)
        }
      }
      if (cut === undefined) return false
      // Extend the cut back to the enclosing turn/start: the turn's process row,
      // tail row and error row are all anchored on that log-only event, which a
      // surface replace never shadows. Pick the greatest turn/start below the cut.
      const origin = cut.start
      let enclosing
      for (const entry of list) {
        if (entry?.type !== 'event') continue
        const event = entry.event
        if (!event || event.type !== 'turn/start') continue
        if (typeof event.seq !== 'number' || event.seq > origin) continue
        if (enclosing === undefined || event.seq > enclosing) enclosing = event.seq
      }
      if (enclosing !== undefined && enclosing < cut.start) cut.start = enclosing
      sessionCuts.set(sessionId, cut)
      let changed = false
      for (const entry of list) {
        if (entry?.type !== 'event') continue
        const event = entry.event
        if (!event || typeof event.seq !== 'number') continue
        if (event.seq < cut.start || event.seq >= cut.end) continue
        if (!shadowedEvents.has(event)) { shadowedEvents.add(event); changed = true }
      }
      return changed
    }

    /**
     * Follow one open Session's event window.
     * @returns a disposer, or undefined when the Session is not retained yet
     *   (the caller retries on the next list publication).
     */
    function watchSession(ctx, sessionId, onShadowGrow) {
      try {
        const feed = ctx.sessions.binding(sessionId)?.eventSource
        if (!feed) return undefined
        const apply = () => {
          try {
            const window = feed.getSnapshot?.()
            if (window && scanWindow(sessionId, window.entries)) onShadowGrow()
          } catch { /* a broken window must not break the feed */ }
        }
        apply()
        return feed.subscribe(apply) ?? (() => {})
      } catch {
        return undefined
      }
    }

    function shadowedMatch(event) {
      if (event && typeof event === 'object' && shadowedEvents.has(event)) {
        return { id: `rollback-shadow-${event.seq}`, role: 'start', exclusive: true }
      }
      return null
    }

    const HIDDEN_TYPES = [
      'user/message', 'developer/message', 'system/message',
      'assistant/message', 'assistant/live-chunk', 'assistant/attempt',
      'tool/result', 'tool/call',
      'turn/start', 'turn/end', 'step/start', 'step/end',
      'llm/retry', 'llm/retry-started',
      'command/run', 'command/done',
      'compaction/start', 'compaction/summary', 'compaction/end',
      'request/header', 'request/context',
    ]

    function shadowDefinition(kind, target) {
      const table = {}
      for (const type of HIDDEN_TYPES) table[type] = shadowedMatch
      return {
        kind,
        target,
        match: table,
        start: () => ({}),
        update: context => context.state,
        // Claims only land on removed events, so nothing is ever published for
        // this Context; returning null keeps the row out of the visible flow.
        buildViewNode: () => null,
      }
    }

    // ---------------------------------------------------------------------
    // Rollback button, rendered in the chain seat directly above a user or
    // steering bubble (the same seat the built-in row uses).
    // ---------------------------------------------------------------------
    function RollbackButton(props) {
      const { sessionId, useChat, inputActions, t, matched, ensureWatched, focusComposer, beginRollback } = props
      const node = useChat((snapshot) => {
        const values = snapshot?.nodes?.values?.() ?? []
        for (const candidate of values) {
          if (!candidate?.data) continue
          if (candidate.data.source === matched.source) return candidate
        }
        return undefined
      })
      const [state, setState] = useState({ phase: 'idle' })
      const [hover, setHover] = useState(false)
      // Another rollback in this Session (from a different message) disables
      // this button too, not just the one that started the operation.
      const [busy, setBusy] = useState(() => isSessionBusy(sessionId))
      useEffect(() => {
        const update = () => setBusy(isSessionBusy(sessionId))
        update()
        return subscribeBusy(update)
      }, [sessionId])
      useEffect(() => { ensureWatched?.(sessionId) }, [sessionId, ensureWatched])
      const seq = node?.data?.seq
      const text = useMemo(() => textOfBlocks(node?.data?.content), [node])

      const close = useCallback(() => setState({ phase: 'idle' }), [])

      const begin = useCallback(async () => {
        if (typeof seq !== 'number') return
        setState({ phase: 'loading' })
        try {
          const preview = await post('preview', { sessionId, originSeq: seq })
          setState({
            phase: 'confirm',
            count: preview?.messageCount ?? 0,
            jobCount: preview?.jobCount ?? 0,
            emptied: preview?.emptied === true,
          })
        } catch (error) {
          setState({ phase: 'error', message: String(error?.message ?? error) })
        }
      }, [sessionId, seq])

      const confirm = useCallback(async () => {
        if (typeof seq !== 'number') return
        setState({ phase: 'working' })
        const endBusy = beginRollback?.(sessionId)
        let ok = false
        try {
          await post('rollback', { sessionId, originSeq: seq })
          ok = true
        } catch (error) {
          // A concurrent rollback from another window is not a failure of this
          // one worth the host's English text: name the situation instead.
          const message = error?.code === 'busy' ? t('busy') : String(error?.message ?? error)
          setState({ phase: 'error', message })
        } finally {
          // Release the latch as soon as the RPC settles, before restoring the
          // draft and the keyboard, so the composer is interactive again.
          endBusy?.()
        }
        if (!ok) return
        if (autofillEnabled() && inputActions?.setDraft && text !== '') inputActions.setDraft(text)
        // Returning the keyboard to the composer is a guarantee of the dialog,
        // not part of the optional autofill: it runs with the toggle off too.
        focusComposer?.(sessionId)
        setState({ phase: 'idle' })
      }, [sessionId, seq, text, inputActions, focusComposer, beginRollback, t])

      const disabled = typeof seq !== 'number' || busy || state.phase === 'working' || state.phase === 'loading'

      const button = h('button', {
        type: 'button',
        title: t('label'),
        'aria-label': t('label'),
        'data-dsh-rollback': 'action',
        disabled,
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); begin() },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 'calc(28px + var(--dsh-content-font-delta, 0px))',
          height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
          padding: 6, border: 'none',
          background: hover && !disabled ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          borderRadius: 'var(--dsw-radius-sm)',
          color: 'var(--dsw-alias-label-tertiary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.4 : 1,
        },
      }, h('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M3 8h9' }),
      h('path', { d: 'M8.5 4.5 12 8l-3.5 3.5' }),
      h('path', { d: 'M3 3v10' })))

      const row = h('div', {
        style: { display: 'flex', height: 'calc(28px + var(--dsh-content-font-delta, 0px))', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
      }, button)

      if (state.phase === 'idle' || state.phase === 'loading') {
        return h('div', { 'data-dsh-rollback': 'seat', style: { minHeight: 0 } }, row)
      }

      if (state.phase === 'error') {
        return h('div', { 'data-dsh-rollback': 'seat' }, row, h(Overlay, {
          title: t('title'), onClose: close,
          body: h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
            t('failed', { message: state.message })),
          footer: h(ModalButton, { onClick: close, primary: true }, t('cancel')),
        }))
      }

      const working = state.phase === 'working'
      const bodyText = state.emptied ? t('empty') : t('body', { count: state.count ?? 0 })
      const sideEffects = (state.count ?? 0) > 0 || (state.jobCount ?? 0) > 0 ? t('sideEffects') : null
      return h('div', { 'data-dsh-rollback': 'seat' }, row, h(Overlay, {
        title: t('title'),
        onClose: working ? () => {} : close,
        body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          h('div', null, bodyText),
          sideEffects === null ? null : h('div', null, sideEffects),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('warning'))),
        footer: h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(ModalButton, { onClick: close, disabled: working }, t('cancel')),
          h(ModalButton, { onClick: confirm, primary: true, disabled: working }, working ? t('working') : t('confirm'))),
      }))
    }

    function ModalButton(props) {
      const { primary, disabled, onClick, children } = props
      return h('button', {
        type: 'button',
        disabled,
        onClick,
        'data-dsh-rollback': primary ? 'primary' : 'action',
        style: {
          height: 36, padding: '0 14px', fontSize: 14, lineHeight: '22px',
          borderRadius: 'var(--dsw-radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          border: 'none',
          background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
          color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
          boxShadow: primary ? 'none' : 'inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsw-alias-border-l3)',
        },
      }, children)
    }

    function Overlay(props) {
      const { title, body, footer, onClose } = props
      const dialogRef = useRef(null)
      // The dialog has to own the keyboard while it is open: move focus into
      // it on mount, close on Escape, keep Tab inside, and hand focus back to
      // whatever held it before. A plain div is not focusable, so the old
      // onKeyDown on the surface never fired in a real browser.
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      useEffect(() => {
        const dialog = dialogRef.current
        if (dialog === null) return undefined
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        const focusables = () => [...dialog.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        const primary = dialog.querySelector('[data-dsh-rollback="primary"]')
        const initial = primary !== null && typeof primary.focus === 'function' && !primary.disabled ? primary : dialog
        initial.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (items.length === 0) { event.preventDefault(); dialog.focus(); return }
          const first = items[0]
          const last = items[items.length - 1]
          const active = document.activeElement
          const inside = dialog.contains(active)
          if (event.shiftKey) {
            if (!inside || active === first || active === dialog) { event.preventDefault(); last.focus() }
          } else if (!inside || active === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && previous !== document.body && typeof previous.focus === 'function' && previous.isConnected) previous.focus()
        }
      }, [])
      // Mirrors the official dialog chrome: a full-viewport flex root, an
      // absolutely positioned mask painted with the theme alias tokens, and a
      // layer-2 surface. Every token below exists in both palettes, so the
      // dialog follows the light/dark setting instead of pinning a dark fill.
      const dismiss = (event) => { if (event.target === event.currentTarget) onClose() }
      return h('div', {
        role: 'presentation',
        'data-dsh-rollback': 'overlay',
        style: {
          position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
        },
      },
      h('div', {
        'data-dsh-rollback': 'mask',
        onMouseDown: dismiss,
        style: {
          position: 'absolute',
          inset: 'var(--dsh-frame-chrome-top, 0px) 0 0',
          background: 'var(--dsw-alias-bg-mask-1)',
          backdropFilter: 'var(--dsw-mask-blur)',
        },
      }),
      h('div', {
        ref: dialogRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        tabIndex: -1,
        style: {
          position: 'relative', zIndex: 1,
          width: 'min(420px, 100%)',
          display: 'flex', flexDirection: 'column', gap: 16,
          padding: '24px',
          borderRadius: 'var(--dsw-radius-panel)',
          background: 'var(--dsw-alias-bg-layer-2)',
          boxShadow: 'var(--dsw-elevation-prominent)',
        },
      },
      h('div', { style: { fontSize: 16, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } }, title),
      body,
      footer))
    }

    // ---------------------------------------------------------------------
    // Settings card
    // ---------------------------------------------------------------------
    function RollbackSettings(props) {
      const [enabled, setEnabled] = useState(() => autofillEnabled())
      // The seat injects the Locale service under the reserved `hooks` key, so
      // it arrives as a `useLocale(selector)` store hook; subscribing forces the
      // re-render when the interface language changes. `tr` itself reads the
      // live Locale service at call time.
      props.useLocale?.((state) => state.active)
      const toggle = useCallback(() => {
        setEnabled((current) => { setAutofill(!current); return !current })
      }, [])
      // The seat injects `t` bound to this namespace (the same translator the
      // rollback button receives); our own binding is the fallback so the card
      // still renders if a composition omits it. Either way the lookup happens
      // at call time against the live Locale service.
      const tr = typeof props.t === 'function'
        ? props.t
        : typeof props.tr === 'function' ? props.tr : makeTranslate(localeService)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
        h('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, tr('settingsTitle')),
        h('div', null, tr('settingsDesc')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
          h('button', {
            type: 'button', role: 'switch', 'aria-checked': enabled ? 'true' : 'false', onClick: toggle,
            style: {
              boxSizing: 'border-box', flex: '0 0 auto',
              width: 36, height: 20, padding: 2, border: 'none', borderRadius: 999, cursor: 'pointer',
              background: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l3)',
              display: 'inline-flex', alignItems: 'center',
              justifyContent: enabled ? 'flex-end' : 'flex-start',
            },
          }, h('span', { style: { display: 'block', width: 16, height: 16, borderRadius: '50%', background: enabled ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-switch-thumb)' } })),
          h('span', null, tr('autofill'))),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, tr('autofillHint')))
    }

    // ---------------------------------------------------------------------
    // Activation
    // ---------------------------------------------------------------------
    const inject = ['slots', 'locale', 'uiConversation', 'sessions', 'conversation']

    function apply(ctx) {
      // Registering the same namespace/locale twice throws, so the registrations
      // belong to the plugin's effect lifetime and are disposed on unload.
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-rollback: locale')
      localeService = ctx.locale
      const t = makeTranslate(ctx.locale)

      // Retry the rebuild once shadow information arrives late: Definitions are
      // global, so a session whose events were scanned only after the initial
      // replay needs one more pass to claim the newly-known events.
      const rebuildSoon = (sessionId) => {
        try {
          const binding = ctx.uiConversation.binding(sessionId)
          binding?.rebuild?.()
        } catch { /* session not open */ }
      }

      /**
       * Return the keyboard to the composer after the dialog took it away.
       * `InputActions` cannot focus; the per-session input facade can.
       */
      const focusComposer = (sessionId) => {
        try {
          // InputHub.for() insists on a retained Session scope; the binding
          // object carries no context, so resolve one through the sessions
          // service. A missing scope means the Session closed mid-flight.
          const scope = ctx.sessions.scope(sessionId)
          if (scope === undefined) return
          ctx.conversation.input.for(scope).focus()
        } catch { /* session closed mid-flight */ }
      }

      /**
       * One rollback per Session at a time: latch every rollback button of the
       * Session and make its composer inert through the official block
       * registry, so no second confirmation and no new prompt can interleave
       * with the cancel / inbox-clear / job-kill phase.
       */
      const beginRollback = (sessionId) => {
        const endBusy = beginBusy(sessionId)
        try { ctx.conversation.blocks.set(sessionId, { reason: t('working') }) } catch { /* service gone */ }
        return () => {
          try { ctx.conversation.blocks.set(sessionId, undefined) } catch { /* service gone */ }
          endBusy()
        }
      }

      /**
       * Follow every Session that becomes retained. `list.ids` is the Host
       * catalog; a Session only gains a binding once the UI retains it, so a
       * missing binding is retried on each later list publication.
       */
      const watchers = new Map()
      const watch = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (watchers.has(sessionId)) return
        const dispose = watchSession(ctx, sessionId, () => rebuildSoon(sessionId))
        if (dispose !== undefined) watchers.set(sessionId, dispose)
      }
      const watchList = () => {
        try {
          const list = ctx.sessions.list?.getSnapshot?.()
          for (const id of list?.ids ?? []) watch(id)
          const fallback = list?.sessions ?? list?.items
          if (Array.isArray(fallback)) {
            for (const item of fallback) watch(item?.sessionId ?? item?.id)
          }
        } catch { /* listing unavailable in this composition */ }
      }
      watchList()
      try {
        const subscription = ctx.sessions.list?.subscribe?.(watchList)
        ctx.effect?.(() => () => { subscription?.() })
      } catch { /* listing unavailable in this composition */ }

      ctx.effect(() => {
        const chat = ctx.uiConversation.events.register(shadowDefinition('rollback-shadow-chat', 'chat'))
        const trajectory = ctx.uiConversation.events.register(shadowDefinition('rollback-shadow-trajectory', 'trajectory'))
        return () => { chat?.(); trajectory?.() }
      }, 'dsh-rollback: shadow definitions')

      ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
        name: 'conversation.chat.user.before',
        select: (owner) => (owner && owner.source && owner.source.kind === 'user' ? owner : null),
        locale: NS,
        inject: () => ({ ensureWatched: watch, focusComposer, beginRollback }),
      }, RollbackButton))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-rollback',
        order: 100,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ tr: t, hooks: { locale: ctx.locale } }),
      }, RollbackSettings))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
