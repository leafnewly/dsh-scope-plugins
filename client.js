/**
 * Scope Plugins — browser half.
 *
 * Two surfaces, one component:
 *   · right sidebar tab (per session): shows the current session scope with its
 *     workspace chain, inheritance slider, master switch, archives, plugin list
 *   · left sidebar panel (root): the same UI plus a scope picker over every
 *     workspace and session, for workspace-level configuration
 *
 * The host half (index.js) owns all state; this file only renders and calls it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-scope-plugins',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const BASE = '/scope-plugins/api'
    const PANEL_ID = 'scope-plugins'
    const NS = 'scopePlugins'
    const TAB_KIND = 'scope-plugins'
    const NAME_ZH = '插件分区系统'
    const NAME_EN = 'Plugin Scopes'
    const GUIDE_ZH = '按工作区 / 对话查看与切换插件'
    const GUIDE_EN = 'View and switch plugins per workspace / conversation'

    const colors = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      accent: 'var(--dsw-alias-state-business-primary)',
    }

    async function readState(scope, signal) {
      const response = await fetch(`${BASE}/state?scope=${encodeURIComponent(scope)}`, { cache: 'no-store', signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    async function post(path, payload, signal) {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    // ── primitives ────────────────────────────────────────────────────────
    function Text({ children, size = 13, color = colors.primary, weight = 400, style }) {
      return h('span', { style: { fontSize: size, color, fontWeight: weight, ...style } }, children)
    }

    function Toggle({ checked, disabled, onChange, title, tone }) {
      const active = checked === true
      const disabledStyle = disabled ? { opacity: 0.45, cursor: 'not-allowed' } : { cursor: 'pointer' }
      const track = tone === 'attention' && active ? 'var(--dsw-alias-state-warning-primary, #d8a12a)' : active ? colors.accent : 'var(--dsw-alias-fill-l3, rgba(127,127,127,0.35))'
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': active,
          title,
          disabled,
          onClick: () => {
            if (!disabled) onChange(!active)
          },
          style: {
            width: 34,
            height: 20,
            borderRadius: 10,
            border: '1px solid ' + (active ? track : colors.border),
            background: track,
            padding: 0,
            position: 'relative',
            transition: 'background 120ms ease',
            flex: 'none',
            ...disabledStyle,
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: active ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 120ms ease',
          },
        }),
      )
    }

    function Button({ children, onClick, disabled, tone, title, style }) {
      const danger = tone === 'danger'
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          title,
          style: {
            appearance: 'none',
            border: `1px solid ${colors.border}`,
            background: 'transparent',
            color: danger ? 'var(--dsw-alias-state-error-primary, #d05555)' : colors.primary,
            borderRadius: 6,
            padding: '4px 9px',
            fontSize: 12,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.45 : 1,
            ...style,
          },
        },
        children,
      )
    }

    function Section({ title, auxiliary, children, gap = 10 }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h(Text, { size: 12, weight: 600, color: colors.secondary }, title),
          auxiliary,
        ),
        children,
      )
    }

    function Row({ children, style }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '9px 2px',
            borderTop: `0.5px solid ${colors.border}`,
            ...style,
          },
        },
        children,
      )
    }

    // ── scope control ─────────────────────────────────────────────────────
    function Slider({ levels, value, onChange }) {
      const index = Math.max(0, levels.findIndex((level) => level.value === value))
      const current = levels[index] ?? levels[0]
      const last = levels.length - 1
      const pct = last === 0 ? 0 : (index / last) * 100
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h(Text, { size: 11, color: colors.tertiary }, '全局默认'),
          h(Text, { size: 12, weight: 600 }, current?.label ?? ''),
          h(Text, { size: 11, color: colors.tertiary }, '不继承'),
        ),
        h('input', {
          type: 'range',
          min: 0,
          max: Math.max(1, last),
          step: 1,
          value: Math.min(index, Math.max(1, last)),
          onChange: (event) => {
            const next = levels[Number(event.target.value)]
            if (next) onChange(next.value)
          },
          style: {
            width: '100%',
            accentColor: colors.accent,
          },
        }),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: colors.tertiary } },
          h('span', null, '从全局默认开始'),
          h('span', null, `${Math.max(0, levels.length - 2)} 档上级`),
          h('span', null, pct > 50 ? '由近到远叠加' : ''),
        ),
      )
    }

    function ScopePicker({ data, scope, onChange }) {
      const options = [{ value: 'global', label: '全局默认' }]
      for (const workspace of data.tree ?? []) {
        options.push({ value: `workspace:${workspace.id}`, label: `🗂 ${workspace.title}` })
        if (workspace.depth > 0) options[options.length - 1].label = `🗂 ${workspace.title}（上级 ${workspace.depth} 层）`
        for (const session of workspace.sessions ?? []) {
          options.push({ value: `session:${session.id}`, label: `　💬 ${session.label}` })
        }
      }
      return h(
        'select',
        {
          value: scope,
          onChange: (event) => onChange(event.target.value),
          style: {
            width: '100%',
            padding: '5px 7px',
            fontSize: 12,
            borderRadius: 6,
            border: `1px solid ${colors.border}`,
            background: 'transparent',
            color: colors.primary,
          },
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    // ── plugin row ────────────────────────────────────────────────────────
    function PluginRow({ item, effective, display, hidden, onToggle, onHide, onInstall, busy }) {
      const enabled = effective[item.module] === true
      const isHistory = item.history === true
      const grey = isHistory || hidden
      const note = isHistory
        ? '历史插件 · 已不在当前安装列表'
        : item.gateable
          ? `${item.tools.join(' / ')}`
          : '无工具可门控（仅全局生效）'
      return h(
        Row,
        null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(Text, { size: 13, weight: 500, color: grey ? colors.tertiary : colors.primary }, item.title),
            isHistory
              ? h(Text, { size: 10, color: colors.tertiary, style: { border: `0.5px solid ${colors.border}`, borderRadius: 4, padding: '0 4px' } }, '历史')
              : null,
            !isHistory && !item.gateable
              ? h(Text, { size: 10, color: colors.tertiary, style: { border: `0.5px solid ${colors.border}`, borderRadius: 4, padding: '0 4px' } }, '全局型')
              : null,
          ),
          h(Text, { size: 11, color: colors.tertiary, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, note),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
          display
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 4 }, title: hidden ? '在插件列表隐藏' : '在插件列表显示' },
                h(Toggle, { checked: !hidden, tone: 'attention', disabled: busy, onChange: () => onHide(item, !hidden) }),
              )
            : null,
          display
            ? h(Button, { disabled: busy || isHistory, title: '安装（启用该插件）', onClick: () => onInstall(item, true) }, '＋')
            : null,
          display
            ? h(Button, { disabled: busy, tone: 'danger', title: isHistory ? '从历史中删除' : '禁用并从列表移除', onClick: () => onHide(item, true) }, '－')
            : null,
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 } },
            h(Toggle, {
              checked: enabled,
              disabled: busy || isHistory || !item.gateable,
              title: item.gateable ? (enabled ? '关闭该插件的工具' : '开启该插件的工具') : '该插件没有可按会话门控的工具',
              onChange: (value) => onToggle(item, value),
            }),
          ),
        ),
      )
    }

    // ── panel ─────────────────────────────────────────────────────────────
    function useScopeState(initialScope) {
      const [scope, setScope] = useState(initialScope)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const generation = useRef(0)

      const load = useCallback(
        async (target, signal) => {
          const mine = ++generation.current
          try {
            const next = await readState(target, signal)
            if (mine !== generation.current) return
            setData(next)
            setError(null)
          } catch (cause) {
            if (signal?.aborted) return
            if (mine !== generation.current) return
            setError(String(cause?.message ?? cause))
          }
        },
        [],
      )

      useEffect(() => {
        const controller = new AbortController()
        setBusy(true)
        load(scope, controller.signal).finally(() => {
          if (!controller.signal.aborted) setBusy(false)
        })
        return () => controller.abort()
      }, [scope, load])

      const mutate = useCallback(
        async (path, payload) => {
          setBusy(true)
          try {
            const next = await post(path, { ...payload, scope })
            if (next && next.scope) setData(next)
            else await load(scope)
          } catch (cause) {
            setError(String(cause?.message ?? cause))
          } finally {
            setBusy(false)
          }
        },
        [scope, load],
      )

      return { scope, setScope, data, setData, error, busy, mutate, reload: () => load(scope) }
    }

    function Panel({ sessionId, standalone }) {
      const initial = standalone ? 'global' : sessionId ? `session:${sessionId}` : 'global'
      const state = useScopeState(initial)
      const { data, scope, setScope, busy, error, mutate, setData } = state
      const [displayMode, setDisplayMode] = useState(false)
      const [archiveId, setArchiveId] = useState('')
      // Electron has no window.prompt, so naming happens inline: {mode, id?, draft}.
      const [archiving, setArchiving] = useState(null)
      const [deleteArmed, setDeleteArmed] = useState(false)

      useEffect(() => {
        if (!deleteArmed) return undefined
        const timer = setTimeout(() => setDeleteArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [deleteArmed, archiveId])

      const startSaveArchive = () => {
        setDeleteArmed(false)
        setArchiving({ mode: 'save', draft: `存档 ${(data?.archives ?? []).length + 1}` })
      }

      const startRenameArchive = () => {
        const current = (data?.archives ?? []).find((item) => item.id === archiveId)
        if (!current) return
        setDeleteArmed(false)
        setArchiving({ mode: 'rename', id: current.id, draft: current.name })
      }

      const commitArchiveName = async () => {
        if (!archiving) return
        const name = archiving.draft.trim()
        if (name.length > 0) {
          const payload = archiving.mode === 'save'
            ? { op: 'save', name }
            : { op: 'rename', id: archiving.id, name }
          await mutate('/archive', payload)
        }
        setArchiving(null)
      }

      useEffect(() => {
        if (!standalone && sessionId) setScope(`session:${sessionId}`)
      }, [sessionId, standalone, setScope])

      useEffect(() => {
        const archives = data?.archives ?? []
        if (archives.length === 0) {
          if (archiveId !== '') setArchiveId('')
          return
        }
        if (!archives.some((item) => item.id === archiveId)) setArchiveId(archives[0].id)
      }, [data?.archives, archiveId])

      if (!data) {
        return h(
          'div',
          { style: { padding: 16, fontSize: 12, color: colors.tertiary } },
          error ? `${NAME_ZH}不可用：${error}` : `正在读取${NAME_ZH}…`,
        )
      }

      const hiddenSet = new Set(data.display?.hidden ?? [])
      const rule = data.rule ?? { inheritDepth: 0, all: null, overrides: {} }
      const visible = (data.catalog ?? []).filter(
    (item) => (data.display?.showAll || item.gateable) && (data.display?.showHidden || !hiddenSet.has(item.module)),
  )
      const history = data.display?.showHistory ? (data.history ?? []).filter((item) => data.display?.showHidden || !hiddenSet.has(item.module)) : []
      const rows = [
        ...visible.map((item) => ({ ...item, history: false })),
        ...history.map((item) => ({ ...item, description: '', history: true })),
      ]
      const chainLabel = (data.levels ?? []).map((level) => level.label).join('  ›  ')

      const patchRule = (patch) => mutate('/rule', { rule: { ...rule, ...patch } })
      const togglePlugin = (item, value) =>
        mutate('/rule', { rule: { ...rule, overrides: { ...(rule.overrides ?? {}), [item.module]: value } } })
      const hidePlugin = (item, hidden) =>
        mutate('/display', hidden ? { hide: item.module } : { unhide: item.module })

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            overflow: 'auto',
            padding: '14px 16px 24px',
            gap: 18,
            color: colors.primary,
            fontFamily: 'inherit',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h(Text, { size: 15, weight: 600 }, NAME_ZH),
          h(Text, { size: 11, color: colors.tertiary }, busy ? '同步中…' : '按工作区 / 会话'),
        ),
        error ? h(Text, { size: 11, color: 'var(--dsw-alias-state-error-primary, #d05555)' }, error) : null,

        standalone
          ? h(ScopePicker, { data, scope, onChange: (next) => setScope(next) })
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h(Text, { size: 11, color: colors.tertiary }, '当前作用域'),
              h(Text, { size: 12, weight: 600 }, chainLabel),
              h(
                'div',
                { style: { display: 'flex', gap: 6 } },
                h(Button, { onClick: () => setScope('global'), disabled: scope === 'global' }, '查看全局'),
                scope.startsWith('session:')
                  ? h(
                      Button,
                      {
                        disabled: busy,
                        onClick: () => {
                          const own = String(scope).slice('session:'.length)
                          const ws = (data.tree ?? []).find((item) => (item.sessions ?? []).some((s) => s.id === own))
                          if (ws) setScope(`workspace:${ws.id}`)
                        },
                      },
                      '查看工作区',
                    )
                  : null,
              ),
            ),

        h(
          Section,
          { title: '插件继承' },
          h(Slider, {
            levels: data.levels ?? [{ value: 0, label: '全局默认', kind: 'global' }],
            value: rule.inheritDepth,
            onChange: (value) => patchRule({ inheritDepth: value }),
          }),
          h(
            Text,
            { size: 11, color: colors.tertiary },
            rule.inheritDepth < 0
              ? '不继承任何上级设置：默认全关，仅本层开启的插件生效。'
              : rule.inheritDepth === 0
                ? '从全局默认开始，不读取上级工作区。'
                : `叠加最近 ${rule.inheritDepth} 档上级设置后，再应用本层覆盖。`,
          ),
        ),

        h(
          Section,
          {
            title: '全开 / 全关',
            auxiliary: rule.all === null ? null : h(Button, { onClick: () => patchRule({ all: null }) }, '恢复跟随继承'),
          },
          h(
            Row,
            { style: { borderTop: 'none', paddingTop: 0 } },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h(Text, { size: 13 }, rule.all === true ? '全部开启' : rule.all === false ? '全部关闭' : '跟随继承'),
              h(Text, { size: 11, color: colors.tertiary }, '开关打开＝本层全部插件启动；关闭＝全部停用；恢复后按继承结果决定。'),
            ),
            h(Toggle, {
              checked: rule.all === true,
              disabled: busy,
              onChange: (value) => patchRule({ all: value }),
            }),
          ),
        ),

        h(
          Section,
          {
            title: '插件存档',
            auxiliary: h(Text, { size: 11, color: colors.tertiary }, `${(data.archives ?? []).length} 个存档`),
          },
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            archiving
              ? [
                  h('input', {
                    key: 'archive-name',
                    name: 'scope-plugins-archive-name',
                    value: archiving.draft,
                    autoFocus: true,
                    onFocus: (event) => event.target.select(),
                    onChange: (event) => setArchiving({ ...archiving, draft: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitArchiveName()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setArchiving(null)
                      }
                    },
                    style: {
                      flex: 1,
                      minWidth: 0,
                      padding: '5px 7px',
                      fontSize: 12,
                      borderRadius: 6,
                      border: `1px solid ${colors.border}`,
                      background: 'transparent',
                      color: colors.primary,
                    },
                  }),
                  h(Button, { key: 'ok', disabled: busy, onClick: () => void commitArchiveName() }, '保存'),
                  h(Button, { key: 'cancel', onClick: () => setArchiving(null) }, '取消'),
                ]
              : [
                  h(
                    'select',
                    {
                      key: 'picker',
                      value: archiveId,
                      onChange: (event) => {
                        setArchiveId(event.target.value)
                        setDeleteArmed(false)
                      },
                      style: {
                        flex: 1,
                        minWidth: 0,
                        padding: '5px 7px',
                        fontSize: 12,
                        borderRadius: 6,
                        border: `1px solid ${colors.border}`,
                        background: 'transparent',
                        color: colors.primary,
                      },
                    },
                    (data.archives ?? []).length === 0
                      ? h('option', { value: '' }, '还没有存档')
                      : (data.archives ?? []).map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                  ),
                  h(
                    Button,
                    { key: 'save', title: '把当前作用域的设置存成新存档（可先改名）', disabled: busy, onClick: startSaveArchive },
                    '＋',
                  ),
                  h(
                    Button,
                    {
                      key: 'restore',
                      disabled: !archiveId || busy,
                      title: '恢复该存档到当前作用域',
                      onClick: () => void mutate('/archive', { op: 'restore', id: archiveId }),
                    },
                    '恢复',
                  ),
                  h(
                    Button,
                    { key: 'rename', disabled: !archiveId || busy, title: '重命名选中的存档', onClick: startRenameArchive },
                    '重命名',
                  ),
                  h(
                    Button,
                    {
                      key: 'delete',
                      tone: 'danger',
                      disabled: !archiveId || busy,
                      title: deleteArmed ? '再点一次确认删除' : '删除选中的存档',
                      onClick: async () => {
                        if (!deleteArmed) {
                          setDeleteArmed(true)
                          return
                        }
                        setDeleteArmed(false)
                        await mutate('/archive', { op: 'delete', id: archiveId })
                      },
                    },
                    deleteArmed ? '确认删除' : '删除',
                  ),
                ],
          ),
          h(Text, { size: 11, color: colors.tertiary }, '存档只保存本层的继承档位、全开关和插件覆盖，不改变插件安装状态。恢复时若插件未安装，需要先在“显示设置”里安装。'),
        ),

        h(
          Section,
          {
            title: '显示设置',
            auxiliary: h(Toggle, {
              checked: displayMode,
              onChange: (value) => setDisplayMode(value),
            }),
          },
          displayMode
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(
                  'div',
                  { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
                  h(
                    'label',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.secondary } },
                    h(Toggle, {
                      checked: data.display?.showHidden === true,
                      onChange: (value) => mutate('/display', { showHidden: value }),
                    }),
                    '显示已隐藏的插件',
                  ),
                  h(
                    'label',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.secondary } },
                    h(Toggle, {
                      checked: data.display?.showHistory !== false,
                      onChange: (value) => mutate('/display', { showHistory: value }),
                    }),
                    '显示历史插件',
                  ),
                  h(
                    'label',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.secondary } },
                    h(Toggle, {
                      checked: data.display?.showAll === true,
                      onChange: (value) => mutate('/display', { showAll: value }),
                    }),
                    '显示全局型插件',
                  ),
                ),
                h(Text, { size: 11, color: colors.tertiary }, '显示设置里每行多出黄色可见开关和 ＋/－：黄色开关决定退出设置后该插件是否出现在列表，＋ 安装/启用，－ 删除（历史插件直接移除）。'),
              )
            : null,
        ),

        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 } },
            h(Text, { size: 12, weight: 600, color: colors.secondary }, '插件列表'),
            h(Text, { size: 11, color: colors.tertiary }, `${rows.filter((item) => !item.history).length} 个已安装`),
          ),
          rows.length === 0
            ? h(Text, { size: 12, color: colors.tertiary }, '没有可显示的插件。打开“显示设置”查看已隐藏或历史插件。')
            : rows.map((item) =>
                h(PluginRow, {
                  key: `${item.history ? 'h' : 'i'}:${item.module}`,
                  item,
                  effective: data.effective ?? {},
                  display: displayMode,
                  hidden: hiddenSet.has(item.module),
                  busy,
                  onToggle: togglePlugin,
                  onHide: (row, hidden) => hidePlugin(row, hidden),
                  onInstall: async (row, enabled) => {
                    const result = await post('/install', { module: row.module, enabled })
                    if (result?.error) window.alert(`无法安装：${result.error}`)
                    else await mutate('/display', { unhide: row.module })
                  },
                }),
              ),
        ),

        h(
          Text,
          { size: 11, color: colors.tertiary },
          '说明：本插件通过隐藏工具实现按工作区/会话开关，对“有工具”的插件立即生效；没有工具的插件（壁纸、皮肤等）只能全局启停。',
        ),
      )
    }

    function StandalonePage() {
      return h(
        'div',
        { style: { height: '100%', minHeight: 0, overflow: 'hidden' } },
        h(Panel, { standalone: true }),
      )
    }

    function RightTabBody(props) {
      return h(Panel, { sessionId: props.sessionId, standalone: false })
    }

    function PanelIcon({ size = 18, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'data-active': active,
          'aria-hidden': true,
        },
        h('path', {
          d: 'M4 5h5v4H4zM11 5h5v4h-5zM4 11h5v4H4zM11 11h5v4h-5z',
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        active ? h('path', { d: 'M4 5h5v4H4zM11 11h5v4h-5z', fill: 'currentColor' }) : null,
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: {
              panel: NAME_ZH,
              tab: NAME_ZH,
              guide: GUIDE_ZH,
            },
            en: {
              panel: NAME_EN,
              tab: NAME_EN,
              guide: GUIDE_EN,
            },
          }),
        'scope-plugins locale',
      )

      const FALLBACK = {
        panel: NAME_ZH,
        tab: NAME_ZH,
        guide: GUIDE_ZH,
      }

      const t = (key) => {
        try {
          const resolved = ctx.locale.bind?.(NS)?.(key)
          if (typeof resolved === 'string' && resolved.length > 0) return resolved
        } catch {
          // fall through to the plain label
        }
        return FALLBACK[key] ?? key
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 12,
            label: () => t('panel'),
            locale: NS,
          },
          PanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          StandalonePage,
        ),
      )

      ctx.effect(() => {
        const registration = ctx.sidebarRightTabs.register({
          id: 'dsh-scope-plugins',
          kind: TAB_KIND,
          priority: 20,
          title: () => t('tab'),
          guide: [
            {
              id: 'dsh-scope-plugins',
              order: 40,
              title: () => t('tab'),
              description: () => t('guide'),
            },
          ],
        })
        const body = ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: 'dsh-scope-plugins',
            locale: NS,
          },
          RightTabBody,
        )
        return () => {
          body()
          registration()
        }
      }, 'scope-plugins right tab')
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs']

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
