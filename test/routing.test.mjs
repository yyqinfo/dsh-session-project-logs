/**
 * Integration test: the plugin's routing, against the real harness modules.
 *
 * Builds the same shape the host has — a Context with the shipped JSONL backend
 * mounted on a central root — activates the plugin, and checks that new sessions
 * land in their project, that centrally stored sessions stay reachable, and that
 * unloading restores the shipped provider.
 *
 * The harness packages are resolved through the running CLI, exactly as the
 * plugin does it, so this test fails loudly on an incompatible installation
 * instead of silently testing something else. Set DSH_HARNESS_ANCHOR when the
 * default path does not exist on this machine.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as core from '../lib/core.js'
import { loadHarnessModules, resolveHarnessModuleUrls } from '../lib/harness.js'

const DEFAULT_ANCHOR = path.join(
  os.homedir(),
  'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
)
if (process.env.DSH_HARNESS_ANCHOR === undefined && fs.existsSync(DEFAULT_ANCHOR)) {
  process.env.DSH_HARNESS_ANCHOR = DEFAULT_ANCHOR
}

const urls = resolveHarnessModuleUrls()
if (urls === undefined) {
  console.error('SKIP: cannot resolve the harness persistence packages; set DSH_HARNESS_ANCHOR to <dsh>/lib/bin.js')
  process.exit(0)
}

const { jsonl, seam } = await loadHarnessModules(urls)
const cordisUrl = new URL('../../cordis/lib/index.js', urls.jsonlUrl).href
const { Context } = await import(cordisUrl)
const plugin = await import('../index.js')

const SANDBOX = path.join(import.meta.dirname, 'tmp')
fs.mkdirSync(SANDBOX, { recursive: true })
const base = fs.mkdtempSync(path.join(SANDBOX, 'routing-'))
const central = path.join(base, 'central')
const projectA = path.join(base, 'project-a')
const projectB = path.join(base, 'project-b')
for (const dir of [central, projectA, projectB]) fs.mkdirSync(dir, { recursive: true })
const statePath = path.join(base, 'state.json')

let passed = 0
const failures = []
const test = async (name, body) => {
  try {
    await body()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    const detail = error instanceof Error ? (error.stack ?? error.message).split('\n').slice(0, 4).join('\n     ') : String(error)
    console.log(`FAIL ${name}\n     ${detail}`)
  }
}

const ctx = new Context()
const shipped = ctx.plugin({ name: 'shipped-jsonl', apply: (inner) => jsonl.apply(inner, { root: central }) })
await shipped.await()
const service = ctx.get('sessionPersistence')

const settings = core.normalizeConfig({ root: central, statePath })
const header = (cwd, id) => ({
  version: 4,
  id,
  createdAt: Date.now(),
  ...(cwd === undefined ? {} : { cwd }),
  isSeeded: false,
  delegationDepth: 0,
})
const localFile = (project, sessionId) => path.join(
  core.projectSessionRoot(settings, project),
  core.projectKey(project),
  core.encodeSegment(sessionId),
  'session.v4.jsonl.zstd',
)
const centralFile = (project, sessionId) => path.join(central, core.projectKey(project), core.encodeSegment(sessionId), 'session.v4.jsonl.zstd')

// A session that predates the plugin, stored centrally.
const legacyHandle = await service.create(header(projectA, 'session-legacy-a'), {})
await legacyHandle.flush()
await legacyHandle.close()

const fiber = ctx.plugin({
  name: 'session-project-logs',
  apply: (inner) => plugin.apply(inner, { root: central, statePath, reportPath: path.join(base, 'report.json') }),
})
await fiber.await()
const routed = ctx.get('sessionPersistence')

await test('the provider keeps its class identity', () => {
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(routed)).constructor, seam.SessionPersistence)
})

await test('legacy sessions stay visible and openable', async () => {
  assert.equal((await routed.stat('session-legacy-a'))?.header.id, 'session-legacy-a')
  const handle = await routed.open('session-legacy-a', 'read')
  await handle.close()
  assert.equal(fs.existsSync(centralFile(projectA, 'session-legacy-a')), true)
})

await test('a new session in a project lands inside the project', async () => {
  const handle = await routed.create(header(projectA, 'session-a1'), {})
  await handle.flush()
  await handle.close()
  assert.equal(fs.existsSync(localFile(projectA, 'session-a1')), true, `expected ${localFile(projectA, 'session-a1')}`)
  assert.equal(fs.existsSync(centralFile(projectA, 'session-a1')), false)
  assert.equal(
    fs.readFileSync(path.join(projectA, '.dsh', 'sessions', '.gitignore'), 'utf8').trim(),
    '*\n!.gitignore',
  )
})

await test('a second project gets its own backend', async () => {
  const handle = await routed.create(header(projectB, 'session-b1'), {})
  await handle.flush()
  await handle.close()
  assert.equal(fs.existsSync(localFile(projectB, 'session-b1')), true)
})

await test('list() merges central and project roots', async () => {
  const ids = (await routed.list()).map((snapshot) => snapshot.header.id).sort()
  assert.deepEqual(ids, ['session-a1', 'session-b1', 'session-legacy-a'])
})

await test('stat/open route to the owning backend', async () => {
  assert.equal((await routed.stat('session-a1'))?.header.id, 'session-a1')
  assert.equal((await routed.stat('session-b1'))?.header.id, 'session-b1')
  assert.equal(await routed.stat('session-does-not-exist'), undefined)
  const handle = await routed.open('session-b1', 'read')
  const read = await handle.read()
  await handle.close()
  assert.equal(Array.isArray(read.events), true)
})

await test('opening a missing session throws the harness not-found error', async () => {
  let caught
  try {
    await routed.open('session-nope', 'read')
  } catch (error) {
    caught = error
  }
  assert.equal(caught?.constructor?.name, 'SessionPersistenceNotFoundError')
  assert.equal(caught instanceof seam.SessionPersistenceNotFoundError, true)
})

await test('a session without cwd stays central', async () => {
  const handle = await routed.create(header(undefined, 'session-nocwd'), {})
  await handle.flush()
  await handle.close()
  assert.equal(
    fs.existsSync(path.join(central, '_no-cwd', core.encodeSegment('session-nocwd'), 'session.v4.jsonl.zstd')),
    true,
  )
})

await test('flush() reaches project backends', async () => {
  await routed.flush()
  assert.equal(fs.existsSync(localFile(projectA, 'session-a1')), true)
})

await test('the registry records the routed projects', () => {
  const stored = core.readRegistry(settings).projects.map((entry) => path.resolve(entry)).sort()
  assert.deepEqual(stored, [path.resolve(projectA), path.resolve(projectB)].sort())
})

await test('a plugin reload keeps a live session handle writable', async () => {
  // The host replaces plugins while sessions run (`dsh plugin add`, HMR). The
  // mounted project backends are parented to the root context for exactly this
  // reason: unloading the plugin must not close a live session's write handle.
  const handle = await routed.create(header(projectA, 'session-survivor'), {})
  await handle.flush()
  await fiber.dispose()
  const second = ctx.plugin({
    name: 'session-project-logs',
    apply: (inner) => plugin.apply(inner, { root: central, statePath, reportPath: path.join(base, 'report.json') }),
  })
  await second.await()
  await handle.flush() // throws SessionHandleClosedError if the reload closed it
  await handle.close()
  assert.equal(fs.existsSync(localFile(projectA, 'session-survivor')), true)
  await second.dispose()
})

await test('unloading restores the shipped provider', async () => {
  await fiber.dispose()
  const handle = await ctx.get('sessionPersistence').create(header(projectA, 'session-after-unload'), {})
  await handle.flush()
  await handle.close()
  assert.equal(fs.existsSync(centralFile(projectA, 'session-after-unload')), true)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
fs.rmSync(base, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
