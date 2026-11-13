// Smoke test for the host half: fake Context, real routes, real state file.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-plugins-'))
process.env.DSH_HOME = home

const plugin = await import('../index.js')
assert.equal(plugin.name, 'scope-plugins')
assert.ok(Array.isArray(plugin.inject))

const restrictCalls = []
const routes = []
const listeners = new Map()

const workspaces = [
  { id: 'ws-a', path: 'F:\\work', title: 'work', sessionIds: [] },
  { id: 'ws-b', path: 'F:\\work\\sub', title: 'sub', sessionIds: ['s1'] },
]
const sessions = [{ header: { id: 's1', cwd: 'F:\\work\\sub' } }]
const inventory = {
  entries: [
    { entryId: 'include:fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberPhase: 'active', meta: { title: 'File tools', description: 'read/write' } },
    { entryId: 'include:search', moduleName: '@deepseek-ai/dsh-tool-fs-search', enabled: true, fiberPhase: 'active', meta: { title: 'Search tools' } },
    { entryId: 'include:wallpaper', moduleName: 'dsh-plugin-wallpaper-engine', enabled: true, fiberPhase: 'active', meta: { title: 'Wallpaper' } },
  ],
}

const fakeAgent = {
  id: 's1',
  scope: { kind: 'agent' },
  session: { header: { id: 's1', cwd: 'F:\\work\\sub' } },
  ctx: {
    tools: {
      restrict(filter) {
        restrictCalls.push(filter)
        return () => {}
      },
    },
  },
}

const ctx = {
  webServer: {
    register(options) {
      routes.push(options)
      return () => {}
    },
  },
  tools: {
    view() {
      return { restrictableNames: new Set(['read', 'write', 'apply_patch', 'edit', 'grep', 'glob', 'bash']) }
    },
  },
  agents: { list: () => [fakeAgent] },
  sessions: { list: () => sessions },
  get(name) {
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    if (name === 'pluginInventory') return { list: () => inventory }
    if (name === 'agents') return { list: () => [fakeAgent] }
    return undefined
  },
  on(event, handler) {
    listeners.set(event, handler)
  },
  effect(fn) {
    return fn()
  },
}
ctx.webServer.register = ctx.webServer.register.bind(ctx.webServer)

plugin.apply(ctx, {})
assert.equal(routes.length, 1, 'one prefix route registered')

// ── drive the route with fake request/response objects ───────────────────
function request(method, pathname, body) {
  const listeners = {}
  const req = {
    method,
    url: pathname,
    on(event, handler) {
      listeners[event] = handler
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    statusCode: 0,
    payload: null,
    writeHead(status) {
      this.statusCode = status
    },
    end(text) {
      this.payload = text
    },
    json() {
      return JSON.parse(this.payload)
    },
  }
  const route = routes[0]
  const promise = route.handler(req, res)
  if (body !== undefined) {
    listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
  }
  return { promise, res }
}

{
  const { res } = request('GET', '/scope-plugins/api/state?scope=session:s1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const state = res.json()
  assert.equal(state.scope, 'session:s1')
  assert.deepEqual(state.chain, ['session:s1', 'workspace:ws-b', 'workspace:ws-a', 'global'])
  assert.equal(state.effective['@deepseek-ai/dsh-tool-fs'], true)
  assert.equal(state.catalog.length, 3)
  const wallpaper = state.catalog.find((item) => item.module === 'dsh-plugin-wallpaper-engine')
  assert.equal(wallpaper.gateable, false, 'UI plugin is not gateable')
  assert.equal(state.levels.at(-1).value, -1, 'rightmost level is "no inheritance"')
  assert.equal(state.levels.length, 4, 'global + 2 ancestors + none')
}

// disable file tools on the child workspace, keep depth 0 (global default)
{
  const { res } = request('POST', '/scope-plugins/api/rule', {
    scope: 'workspace:ws-b',
    rule: { inheritDepth: 0, overrides: { '@deepseek-ai/dsh-tool-fs': false } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(res.statusCode, 200, res.payload)
}

// re-apply happens synchronously via handleRule's reapplyAll()
assert.ok(restrictCalls.length >= 1, 'restrict called for the live agent')
assert.deepEqual([...restrictCalls.at(-1).deny].sort(), ['apply_patch', 'edit', 'read', 'write'])

{
  const { res } = request('GET', '/scope-plugins/api/state?scope=session:s1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const state = res.json()
  assert.equal(state.effective['@deepseek-ai/dsh-tool-fs'], false)
  assert.equal(state.effective['@deepseek-ai/dsh-tool-fs-search'], true)
}

// no-inheritance level: everything off, then own overrides
{
  const { res } = request('POST', '/scope-plugins/api/rule', {
    scope: 'workspace:ws-b',
    rule: { inheritDepth: -1, overrides: {} },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(res.statusCode, 200)
}
{
  const { res } = request('GET', '/scope-plugins/api/state?scope=session:s1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const state = res.json()
  assert.equal(state.effective['@deepseek-ai/dsh-tool-fs'], false)
  assert.equal(state.effective['@deepseek-ai/dsh-tool-fs-search'], false)
}

// archives: save → rename → restore
{
  const saved = request('POST', '/scope-plugins/api/archive', { op: 'save', scope: 'workspace:ws-b', name: 'A' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const id = saved.res.json().archives[0].id
  request('POST', '/scope-plugins/api/archive', { op: 'rename', id, name: 'B', scope: 'workspace:ws-b' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const restored = request('POST', '/scope-plugins/api/archive', { op: 'restore', id, scope: 'session:s1' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const state = restored.res.json()
  assert.equal(state.rule.inheritDepth, -1, 'restored rule lands on the target scope')
}

// persistence
{
  const profile = path.basename(process.env.DSH_PROFILE || process.env.DSH_PROFILE_DIR || 'default')
  const file = path.join(home, 'storages', 'scope-plugins', `${profile}.json`)
  assert.ok(fs.existsSync(file), 'state file written')
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(persisted.version, 1)
  assert.ok(Object.keys(persisted.rules).length >= 2)
}

console.log('smoke: ok — workspace chain, depth resolution, gate mask, archives, persistence')
