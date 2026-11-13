/**
 * Scope Plugins — per-workspace / per-session plugin switches for DSH.
 *
 * DSH itself only knows profile-global plugin enablement (`pluginManager`
 * writes `disabled` into the profile patch). This plugin therefore keeps its
 * own per-workspace / per-session policy and applies it as a per-agent tool
 * mask: on `agent/created` (and after every policy edit) it hides the tools of
 * every plugin the resolved policy switches off, using
 * `agent.ctx.tools.restrict({ deny })`.
 *
 * Resolution model (nearest wins, limited by the child's inherit slider):
 *   session → its workspace → ancestor workspaces (path prefix) → global
 *   workspace → ancestor workspaces → global
 * A rule carries `inheritDepth`:
 *    0  = start from the global defaults (do not read ancestors)
 *   >0  = read that many ancestor levels, then apply own overrides
 *   -1  = inherit nothing: everything off, then apply own overrides
 *
 * State lives in `$DSH_HOME/storages/scope-plugins/state.json`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'scope-plugins'
export const inject = ['webServer', 'tools']

const BASE = '/scope-plugins/api'
const STATE_VERSION = 1

/** Tool names each shipped tool package registers (read from the packages). */
const TOOLS_BY_MODULE = {
  'dsh-tool-ask-user': ['ask_user_question'],
  'dsh-tool-bash': ['bash'],
  'dsh-tool-bash-persistent': ['bash'],
  'dsh-tool-cordis': ['cordis_inspect_list', 'cordis_inspect_query'],
  'dsh-tool-fs': ['apply_patch', 'edit', 'read', 'read_image', 'write'],
  'dsh-tool-fs-search': ['glob', 'grep'],
  'dsh-tool-goal': ['create_goal', 'get_goal', 'update_goal'],
  'dsh-tool-jobs': ['job_kill', 'job_list', 'job_output'],
  'dsh-tool-present': ['present'],
  'dsh-tool-pwsh': ['pwsh'],
  'dsh-tool-pwsh-persistent': ['pwsh'],
  'dsh-tool-ralph': ['ralph'],
  'dsh-tool-schedule': ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'],
  'dsh-tool-session-query': ['session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace'],
  'dsh-tool-skill': ['skill'],
  'dsh-tool-str-replace-editor': ['str_replace_editor'],
  'dsh-tool-subagent': ['list_subagent_models'],
  'dsh-tool-subagent-control': ['interrupt_agent', 'list_agents', 'send_message'],
  'dsh-tool-terminal': ['terminal_close', 'terminal_list', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal'],
  'dsh-tool-todo': ['todo_write'],
  'dsh-tool-web': ['web_fetch', 'web_search'],
  'dsh-tool-working-directory': ['working_directory'],
  'dsh-tool-workspace-dependencies': ['load_workspace_dependencies'],
}

function toolsOf(moduleName) {
  if (!moduleName) return []
  const bare = moduleName.replace(/^@deepseek-ai\//, '')
  return TOOLS_BY_MODULE[moduleName] ?? TOOLS_BY_MODULE[bare] ?? []
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Which profile owns this state file. `DSH_PROFILE` is unreliable here: DSH
 * exports it to profile-started shells, so a server launched from an agent
 * shell inherits the *carrier's* name even when it runs another profile. The
 * only trustworthy cue is where this very plugin was loaded from — walk up
 * from the resolution base to the directory holding the profile manifests.
 */
function profileKeyFrom(baseUrl) {
  const raw = String(baseUrl ?? '').replace(/^file:\/\/\/?/, '')
  let dir = raw
  try {
    dir = decodeURIComponent(raw)
  } catch {
    // keep the undecoded path
  }
  if (dir === '') return envProfileKey()
  if (!path.isAbsolute(dir)) return envProfileKey()
  let current = dir
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'))
      if (manifest && typeof manifest === 'object' && manifest.dsh?.profile?.bundles !== undefined) {
        return sanitizeKey(path.basename(current))
      }
    } catch {
      // not a profile root — keep walking
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return envProfileKey()
}

function sanitizeKey(value) {
  const base = path.basename(String(value).replace(/[\\/]+$/, '')) || 'default'
  return base.replace(/[^A-Za-z0-9._-]+/g, '-')
}

function envProfileKey() {
  return sanitizeKey(process.env.DSH_PROFILE || process.env.DSH_PROFILE_DIR || 'default')
}

function emptyState() {
  return {
    version: STATE_VERSION,
    rules: {},
    archives: [],
    display: { showHidden: false, showHistory: true, showAll: false, hidden: [] },
    seen: [],
  }
}

function normalizeRule(raw) {
  // No rule yet = follow the nearest parent scope (a session follows its
  // workspace, a workspace follows its parent workspace). `inheritDepth: 0`
  // is a deliberate choice — "start from the global defaults" — and only the
  // slider's leftmost position writes it.
  const rule = {
    inheritDepth: 1,
    all: null,
    overrides: {},
  }
  if (raw && typeof raw === 'object') {
    if (typeof raw.inheritDepth === 'number' && Number.isFinite(raw.inheritDepth)) rule.inheritDepth = raw.inheritDepth
    if (raw.all === true || raw.all === false) rule.all = raw.all
    if (raw.overrides && typeof raw.overrides === 'object') {
      for (const [key, value] of Object.entries(raw.overrides)) {
        if (typeof value === 'boolean') rule.overrides[key] = value
      }
    }
  }
  return rule
}

const TITLES_ZH = {
  'tool-fs': '文件读写',
  'tool-fs-search': '文件搜索',
  'tool-bash': '终端命令',
  'tool-bash-persistent': '终端命令（持久会话）',
  'tool-pwsh': 'PowerShell',
  'tool-pwsh-persistent': 'PowerShell（持久会话）',
  'tool-todo': '待办清单',
  'tool-web': '网页检索',
  'tool-skill': '技能加载',
  'tool-goal': '目标管理',
  'tool-schedule': '定时任务',
  'tool-subagent': '子代理模型',
  'tool-subagent-control': '子代理控制',
  'tool-ask-user': '询问用户',
  'tool-present': '交付文件',
  'tool-ralph': '循环执行',
  'tool-jobs': '后台任务',
  'tool-terminal': '互动终端',
  'tool-cordis': 'Cordis 检查',
  'tool-session-query': '会话查询',
  'tool-working-directory': '工作目录',
  'tool-workspace-dependencies': '工作区依赖',
  'tool-str-replace-editor': '文本编辑器',
  'tool-workflow': '工作流',
  'workflow-workerthread': '工作流线程',
  'compact-basic': '上下文压缩',
  'command-compact': '压缩命令',
  'tool-result-prune': '工具结果裁剪',
  'plan-mode': '计划模式',
  'token-meter': 'Token 计量',
  'workspace-context': '工作区上下文',
  'agent-preset': 'Agent 预设',
  'agent-preset-registry': '预设注册表',
  'plugin-manager': '插件管理器',
  'plugin-market': '插件市场',
  'skill-filesystem': '技能目录',
  'bash-env': '终端环境',
  'mcp-client': 'MCP 客户端',
}

function zhTitle(moduleName) {
  const bare = String(moduleName ?? '').replace(/^@[^/]+\//, '')
  const key = bare.startsWith('dsh-') ? bare.slice(4) : bare
  return TITLES_ZH[key]
}

function prettyName(moduleName) {
  const bare = String(moduleName ?? '').replace(/^@[^/]+\//, '')
  const key = bare.startsWith('dsh-') ? bare.slice(4) : bare
  if (TITLES_ZH[key]) return TITLES_ZH[key]
  return key.replace(/^(?:plugin-|client-)/, '').replace(/-/g, ' ')
}

function createStore(home, key = envProfileKey()) {
  const dir = path.join(home, 'storages', 'scope-plugins')
  // One state file per profile: workspace/session ids and the installed plugin
  // set are profile-scoped, and two profiles sharing one file would leak rules
  // and turn the other profile's plugins into bogus "history" rows.
  const file = path.join(dir, `${sanitizeKey(key)}.json`)
  let state = emptyState()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      state = {
        ...emptyState(),
        ...parsed,
        display: { ...emptyState().display, ...(parsed.display ?? {}) },
        archives: Array.isArray(parsed.archives) ? parsed.archives : [],
        seen: Array.isArray(parsed.seen) ? parsed.seen : [],
        rules: parsed.rules && typeof parsed.rules === 'object' ? parsed.rules : {},
      }
    }
  } catch {
    // first run (or unreadable file): defaults are fine
  }
  let pending = null
  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      console.error('[scope-plugins] failed to persist state:', error)
    }
  }
  function mutate(fn) {
    const result = fn(state)
    if (pending === null) save()
    return result
  }
  return { state: () => state, mutate, save, file }
}

function workspaceRecords(ctx) {
  let list = []
  try {
    const registry = ctx.get('workspaceRegistry')
    list = registry?.list?.() ?? []
  } catch {
    list = []
  }
  const out = []
  for (const ws of list) {
    try {
      out.push({
        id: ws.id,
        path: ws.path,
        title: ws.title || path.basename(ws.path || '') || ws.id,
        sessionIds: [...(ws.sessionIds ?? [])],
      })
    } catch {
      // ignore a broken record
    }
  }
  return out
}

function sessionRecords(ctx) {
  let list = []
  try {
    list = ctx.sessions?.list?.() ?? []
  } catch {
    list = []
  }
  const out = []
  for (const session of list) {
    try {
      out.push({
        id: session.header?.id ?? session.id,
        cwd: session.header?.cwd,
        parentSession: session.header?.parentSession ?? null,
      })
    } catch {
      // ignore
    }
  }
  return out
}

function ancestorsOf(workspaces, workspace) {
  if (!workspace?.path) return []
  const own = workspace.path.toLowerCase().replace(/[\\/]+$/, '')
  const matches = workspaces.filter((candidate) => {
    if (!candidate.path || candidate.id === workspace.id) return false
    const p = candidate.path.toLowerCase().replace(/[\\/]+$/, '')
    if (!p || p === own) return false
    return own.startsWith(`${p}${path.sep}`) || own.startsWith(`${p}/`)
  })
  matches.sort((left, right) => right.path.length - left.path.length)
  return matches
}

function workspaceForSession(workspaces, sessions, sessionId) {
  const direct = workspaces.find((ws) => ws.sessionIds.includes(sessionId))
  if (direct) return direct
  const session = sessions.find((s) => s.id === sessionId)
  const cwd = session?.cwd
  if (!cwd) return undefined
  const lowered = cwd.toLowerCase().replace(/[\\/]+$/, '')
  const byPath = workspaces
    .filter((ws) => {
      const p = (ws.path || '').toLowerCase().replace(/[\\/]+$/, '')
      return p && (lowered === p || lowered.startsWith(`${p}${path.sep}`) || lowered.startsWith(`${p}/`))
    })
    .sort((left, right) => right.path.length - left.path.length)
  return byPath[0]
}

function chainFor(ctx, scope) {
  const workspaces = workspaceRecords(ctx)
  const sessions = sessionRecords(ctx)
  if (scope === 'global') return { chain: ['global'], workspaces }
  if (scope.startsWith('workspace:')) {
    const workspace = workspaces.find((ws) => ws.id === scope.slice('workspace:'.length))
    if (!workspace) return { chain: [scope, 'global'], workspaces }
    const parents = ancestorsOf(workspaces, workspace)
    return { chain: [scope, ...parents.map((p) => `workspace:${p.id}`), 'global'], workspaces }
  }
  if (scope.startsWith('session:')) {
    const sessionId = scope.slice('session:'.length)
    const workspace = workspaceForSession(workspaces, sessions, sessionId)
    if (!workspace) return { chain: [scope, 'global'], workspaces }
    const parents = ancestorsOf(workspaces, workspace)
    return {
      chain: [scope, `workspace:${workspace.id}`, ...parents.map((p) => `workspace:${p.id}`), 'global'],
      workspaces,
    }
  }
  return { chain: ['global'], workspaces }
}

function labelForScope(scope, workspaces, sessions) {
  if (scope === 'global') return '全局默认'
  if (scope.startsWith('workspace:')) {
    const ws = workspaces.find((w) => w.id === scope.slice('workspace:'.length))
    return ws ? ws.title : scope
  }
  if (scope.startsWith('session:')) {
    const id = scope.slice('session:'.length)
    const session = sessions.find((s) => s.id === id)
    const short = id.slice(-6)
    return session?.cwd ? `${path.basename(session.cwd)} · ${short}` : `会话 ${short}`
  }
  return scope
}

function levelsFor(chain, workspaces, sessions) {
  const ancestors = Math.max(0, chain.length - 2)
  const levels = [{ value: 0, label: '全局默认', kind: 'global' }]
  for (let depth = 1; depth <= ancestors; depth += 1) {
    const key = chain[depth]
    levels.push({
      value: depth,
      label: labelForScope(key, workspaces, sessions),
      kind: key.startsWith('session:') ? 'session' : 'workspace',
    })
  }
  levels.push({ value: -1, label: '不继承', kind: 'none' })
  return levels
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    for (const key of ['text', 'title', 'label', 'name', 'en', 'zh']) {
      if (typeof value[key] === 'string' && value[key]) return value[key]
    }
  }
  return ''
}

async function readCatalog(ctx) {
  let snapshot = null
  try {
    snapshot = (await ctx.get('pluginInventory')?.list?.()) ?? null
  } catch {
    snapshot = null
  }
  const rows = []
  const packages = ctx.get('pluginPackages')
  const metaFor = (moduleName, given) => {
    if (given) return given
    try {
      const meta = packages?.metaOf?.(moduleName, ctx.baseUrl)
      return meta && !meta.error ? meta : undefined
    } catch {
      return undefined
    }
  }
  for (const entry of snapshot?.entries ?? []) {
    rows.push({ ...entry, meta: metaFor(entry.moduleName, entry.meta), source: 'profile' })
  }
  const presets = snapshot?.agentPresets
  const presetList = Array.isArray(presets) ? presets : Array.isArray(presets?.presets) ? presets.presets : []
  for (const preset of presetList) {
    for (const row of preset?.rows ?? preset?.plugins ?? []) {
      if (!row?.moduleName) continue
      rows.push({
        moduleName: row.moduleName,
        enabled: row.enabled !== false,
        fiberPhase: row.fiberPhase ?? row.phase ?? null,
        entryId: row.entryId ?? null,
        meta: row.meta ?? metaFor(row.moduleName),
        source: 'preset',
      })
    }
  }
  const byModule = new Map()
  for (const row of rows) {
    const moduleName = row.moduleName
    if (typeof moduleName !== 'string' || moduleName.length === 0) continue
    const tools = toolsOf(moduleName)
    const existing = byModule.get(moduleName)
    if (existing) {
      existing.tools = tools.length > 0 ? tools : existing.tools
      existing.gateable = existing.tools.length > 0
      // A preset composition row is the authoritative "this plugin runs in the
      // agent" signal: the host-plane row of the same package is often disabled
      // on purpose in deployments that mount everything through presets.
      existing.profileEnabled =
        row.source === 'preset' ? existing.profileEnabled || row.enabled !== false : existing.profileEnabled && row.enabled !== false
      existing.sources.add(row.source ?? 'profile')
      continue
    }
    byModule.set(moduleName, {
      module: moduleName,
      title: zhTitle(moduleName) || textOf(row.meta?.title) || prettyName(moduleName),
      description: textOf(row.meta?.description),
      profileEnabled: row.enabled !== false,
      phase: row.fiberPhase ?? null,
      entryId: row.entryId ?? null,
      tools,
      gateable: tools.length > 0,
      sources: new Set([row.source ?? 'profile']),
    })
  }
  return [...byModule.values()].sort((left, right) => String(left.title).localeCompare(String(right.title)))
}

function defaultStates(catalog) {
  const map = new Map()
  for (const item of catalog) map.set(item.module, item.profileEnabled)
  // Gating must work even before the first inventory read (or if the inventory
  // service is absent): every known tool module defaults to enabled.
  for (const bare of Object.keys(TOOLS_BY_MODULE)) {
    const full = `@deepseek-ai/${bare}`
    if (!map.has(full)) map.set(full, true)
  }
  return map
}

function ruleFor(state, scope) {
  return normalizeRule(state.rules?.[scope])
}

function effectiveStates(ctx, catalog, scope) {
  const { chain } = chainFor(ctx, scope)
  const state = ctx.__scopePluginsStore.state()
  const defaults = defaultStates(catalog)
  const seen = new Set()
  function level(index) {
    if (index >= chain.length) return new Map(defaults)
    const key = chain[index]
    if (key === 'global' || seen.has(`${index}:${key}`)) return new Map(defaults)
    seen.add(`${index}:${key}`)
    const rule = ruleFor(state, key)
    let base
    if (rule.inheritDepth < 0) {
      base = new Map([...defaults.keys()].map((k) => [k, false]))
    } else if (rule.inheritDepth === 0) {
      base = new Map(defaults)
    } else {
      base = level(index + 1)
    }
    if (rule.all === true) for (const k of base.keys()) base.set(k, true)
    if (rule.all === false) for (const k of base.keys()) base.set(k, false)
    for (const [k, v] of Object.entries(rule.overrides)) if (base.has(k)) base.set(k, v)
    return base
  }
  return { effective: level(0), chain }
}

function sameMap(left, right) {
  if (left.size !== right.size) return false
  for (const [key, value] of left) if (right.get(key) !== value) return false
  return true
}

export function apply(ctx, _config) {
  const store = createStore(dshHome(), profileKeyFrom(ctx.baseUrl))
  ctx.__scopePluginsStore = store
  let catalogCache = []
  async function refreshCatalog() {
    try {
      const list = await readCatalog(ctx)
      catalogCache = list
      store.mutate((state) => {
        const seen = new Set(state.seen)
        for (const item of list) seen.add(item.module)
        state.seen = [...seen]
      })
      return list
    } catch {
      return catalogCache
    }
  }
  const catalog = () => catalogCache
  const gates = new Map()

  function release(agentId) {
    const dispose = gates.get(agentId)
    if (!dispose) return
    gates.delete(agentId)
    try {
      dispose()
    } catch {
      // already disposed with the agent
    }
  }

  function reapply(agent) {
    const agentId = agent?.id
    if (!agentId) return
    const sessionId = agent.session?.header?.id ?? agent.session?.id ?? agentId
    const list = catalog()
    const { effective } = effectiveStates(ctx, list, `session:${sessionId}`)
    let view
    try {
      view = ctx.tools.view(agent.scope)
    } catch {
      return
    }
    const restrictable = view?.restrictableNames
    if (!restrictable) return
    const allowed = new Set(restrictable)
    const denied = new Set()
    // Walk the resolved states, not the catalog: before the first inventory read
    // the catalog is empty, yet a rule that switches a known tool plugin off
    // must already take effect.
    for (const [moduleName, enabled] of effective) {
      if (enabled !== false) continue
      for (const tool of toolsOf(moduleName)) if (allowed.has(tool)) denied.add(tool)
    }
    const previous = gates.get(agentId)
    if (denied.size === 0) {
      if (previous) release(agentId)
      return
    }
    if (previous) release(agentId)
    try {
      const target = agent.ctx ?? ctx
      const filter = denied.size >= allowed.size ? { deny: [...allowed] } : { deny: [...denied] }
      const dispose = target.tools.restrict(filter)
      gates.set(agentId, dispose)
    } catch (error) {
      console.error('[scope-plugins] could not apply tool mask:', error)
    }
  }

  function reapplyAll() {
    let agents = []
    try {
      agents = ctx.get('agents')?.list?.() ?? []
    } catch {
      agents = []
    }
    for (const agent of agents) reapply(agent)
  }

  ctx.on('agent/created', ({ agent }) => reapply(agent))
  ctx.on('agent/disposed', ({ agent }) => release(agent?.id))
  ctx.effect(() => {
    reapplyAll()
    return () => {
      for (const id of [...gates.keys()]) release(id)
    }
  }, 'scope-plugins initial gate')

  // ── HTTP surface ────────────────────────────────────────────────────────
  async function statePayload(scope) {
    const sessions = sessionRecords(ctx)
    const list = await refreshCatalog()
    const { effective, chain } = effectiveStates(ctx, list, scope)
    const state = store.state()
    const workspaces = workspaceRecords(ctx)
    const hidden = new Set(state.display.hidden ?? [])
    const installed = new Set(list.map((item) => item.module))
    const history = (state.seen ?? []).filter((mod) => !installed.has(mod))
    const tree = workspaces.map((ws) => ({
      id: ws.id,
      title: ws.title,
      path: ws.path,
      depth: ancestorsOf(workspaces, ws).length,
      sessions: ws.sessionIds.map((id) => ({
        id,
        label: labelForScope(`session:${id}`, workspaces, sessions),
        workspaceId: ws.id,
      })),
    }))
    return {
      scope,
      chain,
      levels: levelsFor(chain, workspaces, sessions),
      rule: ruleFor(state, scope),
      effective: Object.fromEntries(effective),
      catalog: list.map((item) => ({
        module: item.module,
        title: item.title,
        description: item.description,
        tools: item.tools,
        gateable: item.gateable,
        profileEnabled: item.profileEnabled,
        phase: item.phase,
        sources: [...item.sources],
        history: false,
      })),
      history: history.map((mod) => ({
        module: mod,
        title: prettyName(mod),
        gateable: toolsOf(mod).length > 0,
        tools: toolsOf(mod),
      })),
      archives: state.archives ?? [],
      display: {
        showHidden: state.display.showHidden === true,
        showHistory: state.display.showHistory !== false,
        showAll: state.display.showAll === true,
        hidden: [...hidden],
      },
      tree,
      sessionScopes: sessions.map((session) => ({
        id: session.id,
        label: labelForScope(`session:${session.id}`, workspaces, sessions),
      })),
    }
  }

  function readBody(request) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 1_000_000) {
          request.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(null)
        }
      })
      request.on('error', () => resolve(null))
    })
  }

  function send(response, status, value) {
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  async function handleRule(body) {
    const scope = typeof body?.scope === 'string' ? body.scope : 'global'
    const patch = body?.rule
    await refreshCatalog()
    store.mutate((state) => {
      const current = ruleFor(state, scope)
      state.rules[scope] = normalizeRule({ ...current, ...(patch ?? {}) })
    })
    reapplyAll()
    return await statePayload(scope)
  }

  async function handleArchive(body) {
    const op = body?.op
    const state = store.state()
    if (op === 'save') {
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : `存档 ${(state.archives?.length ?? 0) + 1}`
      const scope = typeof body?.scope === 'string' ? body.scope : 'global'
      const rule = ruleFor(state, scope)
      const entry = {
        id: `archive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        rule: { inheritDepth: rule.inheritDepth, all: rule.all, overrides: { ...rule.overrides } },
        createdAt: Date.now(),
      }
      store.mutate((s) => {
        s.archives = [...(s.archives ?? []), entry]
      })
    } else if (op === 'rename') {
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (name) {
        store.mutate((s) => {
          const found = (s.archives ?? []).find((a) => a.id === body?.id)
          if (found) found.name = name
        })
      }
    } else if (op === 'delete') {
      store.mutate((s) => {
        s.archives = (s.archives ?? []).filter((a) => a.id !== body?.id)
      })
    } else if (op === 'restore') {
      const archive = (state.archives ?? []).find((a) => a.id === body?.id)
      const scope = typeof body?.scope === 'string' ? body.scope : 'global'
      if (archive) {
        store.mutate((s) => {
          s.rules[scope] = normalizeRule(archive.rule)
        })
        reapplyAll()
        return { ...(await statePayload(scope)), restored: archive.name }
      }
      return { error: 'archive-not-found' }
    }
    const scope = typeof body?.scope === 'string' ? body.scope : 'global'
    return await statePayload(scope)
  }

  async function handleDisplay(body) {
    const scope = typeof body?.scope === 'string' ? body.scope : 'global'
    store.mutate((s) => {
      if (typeof body?.showHidden === 'boolean') s.display.showHidden = body.showHidden
      if (typeof body?.showHistory === 'boolean') s.display.showHistory = body.showHistory
      if (typeof body?.showAll === 'boolean') s.display.showAll = body.showAll
      if (Array.isArray(body?.hidden)) s.display.hidden = body.hidden.filter((v) => typeof v === 'string')
      if (typeof body?.hide === 'string' && !s.display.hidden.includes(body.hide)) s.display.hidden.push(body.hide)
      if (typeof body?.unhide === 'string') s.display.hidden = s.display.hidden.filter((v) => v !== body.unhide)
    })
    return await statePayload(scope)
  }

  async function handleInstall(body) {
    const moduleName = typeof body?.module === 'string' ? body.module : ''
    const enabled = body?.enabled !== false
    const row = (await refreshCatalog()).find((item) => item.module === moduleName)
    const manager = ctx.get('pluginManager')
    if (!row?.entryId || !manager) return { error: 'not-manageable' }
    try {
      await manager.setPluginEnabled(row.entryId, enabled)
      return { ok: true }
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  void refreshCatalog()

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? BASE, 'http://localhost')
          const route = url.pathname.slice(BASE.length)
          if (request.method === 'GET' && route === '/state') {
            const scope = url.searchParams.get('scope') || 'global'
            send(response, 200, await statePayload(scope))
            return
          }
          if (request.method === 'POST') {
            const body = await readBody(request)
            if (body === null) {
              send(response, 400, { error: 'bad-json' })
              return
            }
            if (route === '/rule') {
              send(response, 200, await handleRule(body))
              return
            }
            if (route === '/archive') {
              send(response, 200, await handleArchive(body))
              return
            }
            if (route === '/display') {
              send(response, 200, await handleDisplay(body))
              return
            }
            if (route === '/install') {
              send(response, 200, await handleInstall(body))
              return
            }
          }
          send(response, 404, { error: 'not-found' })
        } catch (error) {
          console.error('[scope-plugins] route failed:', error)
          try {
            send(response, 500, { error: String(error?.message ?? error) })
          } catch {
            // response already gone
          }
        }
      },
    })
    return () => dispose()
  }, 'scope-plugins routes')

  void sameMap
}
