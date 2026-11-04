/**
 * Self-test for the storage layout, skip rules, and offline migration.
 *
 * The known-answer cases come from the real session root on this machine, so a
 * drift in the project-key rule — the one thing that must match the backend
 * byte-for-byte — shows up here instead of as orphaned logs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  centralSessions,
  dshHome,
  encodeSegment,
  inspectProject,
  migrateProject,
  normalizeConfig,
  projectKey,
  projectSessionRoot,
  readRegistry,
  resolveSessionsRoot,
  restoreProject,
  sessionDirectory,
  skipReason,
  writeRegistry,
} from '../lib/core.js'

let passed = 0
const failures = []
function test(name, body) {
  try {
    body()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ------------------------------------------------------------- known answers
test('projectKey matches directory names the backend actually created', () => {
  assert.equal(projectKey('E:\\Ai\\Study\\26AI\\261103－Dsh'), '--E-Ai-Study-26AI-261103~FF0DDsh--')
  assert.equal(projectKey('C:\\Users\\xy'), '--C-Users-xy--')
  assert.equal(projectKey('D:\\AiProg\\dsh\\260922－黑客松'), '--D-AiProg-dsh-260922~FF0D~9ED1~5BA2~677E--')
  assert.equal(projectKey('/home/me/proj'), '--home-me-proj--')
})

test('encodeSegment matches the backend escaping', () => {
  assert.equal(encodeSegment('session-123'), 'session-123')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('sessions root follows $DSH_HOME and explicit config', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:\\AiProg\\dsh'
  try {
    assert.equal(resolveSessionsRoot(''), path.join('D:\\AiProg\\dsh', 'sessions'))
    assert.equal(dshHome(), 'D:\\AiProg\\dsh')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(resolveSessionsRoot('~/logs/sessions'), path.join(os.homedir(), 'logs', 'sessions'))
})

// ---------------------------------------------------------------- fixtures
// Fixtures live beside the tests, not under the OS temp directory: the plugin
// deliberately refuses to route sessions into a temporary directory.
const SANDBOX = path.join(import.meta.dirname, 'tmp')

function fixture() {
  fs.mkdirSync(SANDBOX, { recursive: true })
  const base = fs.mkdtempSync(path.join(SANDBOX, 'core-'))
  const central = path.join(base, 'central')
  const project = path.join(base, 'project')
  fs.mkdirSync(central, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const settings = normalizeConfig({ root: central, statePath: path.join(base, 'state.json') })
  return { base, central, project, settings }
}

function fakeCentralSessions(settings, project, ids) {
  const dir = path.join(settings.root, projectKey(project))
  fs.mkdirSync(dir, { recursive: true })
  for (const id of ids) {
    const sessionDir = path.join(dir, encodeSegment(id))
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), `log-${id}`)
  }
  return dir
}

function localSessionDirs(settings, project) {
  const dir = path.join(projectSessionRoot(settings, project), projectKey(project))
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

// --------------------------------------------------------------- behaviour
test('session directories follow the backend layout on either root', () => {
  const { base, central, project, settings } = fixture()
  assert.equal(sessionDirectory(central, project, 'session-1'), path.join(central, projectKey(project), 'session-1'))
  assert.equal(projectSessionRoot(settings, project), path.join(project, '.dsh', 'sessions'))
  fs.rmSync(base, { recursive: true, force: true })
})

test('skip rules keep routing out of meaningless locations', () => {
  const { base, central, project, settings } = fixture()
  const insideRoot = path.join(central, '--x--')
  fs.mkdirSync(insideRoot, { recursive: true })
  assert.equal(skipReason(settings, project), undefined)
  assert.match(String(skipReason(settings, path.join(base, 'missing'))), /does not exist/)
  assert.match(String(skipReason(settings, 'relative/path')), /not absolute/)
  assert.match(String(skipReason(settings, path.parse(project).root)), /filesystem root/)
  assert.match(String(skipReason(settings, dshHome())), /harness home/)
  assert.match(String(skipReason(settings, central)), /sessions root/)
  assert.match(String(skipReason(settings, insideRoot)), /inside the central sessions root/)
  assert.match(String(skipReason(settings, os.homedir())), /user home/)
  const ignored = normalizeConfig({ root: central, ignore: [base] })
  assert.match(String(skipReason(ignored, project)), /ignored path/)
  fs.rmSync(base, { recursive: true, force: true })
})

test('migrateProject moves every central session into the project', () => {
  const { base, project, settings } = fixture()
  fakeCentralSessions(settings, project, ['session-a', 'session-b'])
  assert.equal(centralSessions(settings, project).sessions.length, 2)
  const dry = migrateProject(settings, project, { dryRun: true, force: true })
  assert.equal(dry.status, 'dry-run')
  assert.equal(dry.moved, 2)
  assert.equal(localSessionDirs(settings, project).length, 0)

  const result = migrateProject(settings, project, { force: true })
  assert.equal(result.status, 'migrated')
  assert.equal(result.moved, 2)
  assert.deepEqual(localSessionDirs(settings, project), ['session-a', 'session-b'])
  assert.equal(centralSessions(settings, project).sessions.length, 0)
  assert.equal(fs.readFileSync(path.join(projectSessionRoot(settings, project), projectKey(project), 'session-a', 'session.v4.jsonl.zstd'), 'utf8'), 'log-session-a')
  assert.equal(fs.existsSync(path.join(projectSessionRoot(settings, project), '.gitignore')), true)
  fs.rmSync(base, { recursive: true, force: true })
})

test('migrateProject is a no-op for an empty project and reports skipped ones', () => {
  const { base, project, settings } = fixture()
  assert.equal(migrateProject(settings, project, { force: true }).status, 'empty')
  const missing = path.join(base, 'does-not-exist')
  const skipped = migrateProject(settings, missing, { force: true })
  assert.equal(skipped.status, 'skipped')
  assert.match(String(skipped.reason), /does not exist/)
  fs.rmSync(base, { recursive: true, force: true })
})

test('restoreProject moves the sessions back to the central root', () => {
  const { base, project, settings } = fixture()
  fakeCentralSessions(settings, project, ['session-a', 'session-b'])
  migrateProject(settings, project, { force: true })
  const result = restoreProject(settings, project)
  assert.equal(result.status, 'restored')
  assert.equal(result.moved, 2)
  assert.deepEqual(centralSessions(settings, project).sessions.sort(), ['session-a', 'session-b'])
  assert.deepEqual(localSessionDirs(settings, project), [])
  fs.rmSync(base, { recursive: true, force: true })
})

test('a name clash is reported instead of overwritten', () => {
  const { base, project, settings } = fixture()
  fakeCentralSessions(settings, project, ['session-a'])
  const target = path.join(projectSessionRoot(settings, project), projectKey(project), 'session-a')
  fs.mkdirSync(target, { recursive: true })
  const result = migrateProject(settings, project, { force: true })
  assert.equal(result.status, 'partial')
  assert.equal(result.failed, 1)
  assert.equal(fs.existsSync(path.join(settings.root, projectKey(project), 'session-a')), true)
  fs.rmSync(base, { recursive: true, force: true })
})

test('inspectProject reports both sides', () => {
  const { base, project, settings } = fixture()
  fakeCentralSessions(settings, project, ['session-a', 'session-b'])
  migrateProject(settings, project, { dryRun: true, force: true })
  const report = inspectProject(settings, project)
  assert.equal(report.central.sessions, 2)
  assert.equal(report.local.sessions, 0)
  assert.equal(report.skipped, undefined)
  fs.rmSync(base, { recursive: true, force: true })
})

test('the registry round-trips through the state file', () => {
  const { base, project, settings } = fixture()
  assert.deepEqual(readRegistry(settings).projects, [])
  writeRegistry(settings, [project, project, path.join(base, 'other')])
  const stored = readRegistry(settings).projects.map((entry) => path.resolve(entry)).sort()
  assert.deepEqual(stored, [path.resolve(project), path.resolve(base, 'other')].sort())
  fs.rmSync(base, { recursive: true, force: true })
})

test('projects living under the harness home stay eligible', () => {
  const previous = process.env.DSH_HOME
  const fakeHome = path.join(SANDBOX, 'fake-home')
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env.DSH_HOME = fakeHome
  try {
    const settings = normalizeConfig({})
    const inner = path.join(fakeHome, 'nested-project')
    fs.mkdirSync(inner, { recursive: true })
    assert.equal(skipReason(settings, inner), undefined)
    assert.match(String(skipReason(settings, fakeHome)), /harness home/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('the activity guard leaves a session that looks live in place', () => {
  const { base, project, settings } = fixture()
  fakeCentralSessions(settings, project, ['session-live', 'session-idle'])
  // Age one session so it is clearly idle, keep the other one fresh.
  const stale = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(path.join(settings.root, projectKey(project), 'session-idle', 'session.v4.jsonl.zstd'), stale, stale)

  const preview = migrateProject(settings, project, { dryRun: true, quietMinutes: 10 })
  assert.equal(preview.status, 'dry-run-active')
  assert.equal(preview.moved, 1)
  assert.deepEqual(preview.skipped.map((entry) => entry.name), ['session-live'])

  const result = migrateProject(settings, project, { quietMinutes: 10 })
  assert.equal(result.status, 'migrated-with-skips')
  assert.equal(result.moved, 1)
  assert.deepEqual(localSessionDirs(settings, project), [encodeSegment('session-idle')])
  assert.deepEqual(centralSessions(settings, project).sessions, [encodeSegment('session-live')])

  const forced = migrateProject(settings, project, { force: true })
  assert.equal(forced.moved, 1)
  assert.equal(centralSessions(settings, project).sessions.length, 0)
  fs.rmSync(base, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failures.length} failed`)

process.exit(failures.length === 0 ? 0 : 1)
