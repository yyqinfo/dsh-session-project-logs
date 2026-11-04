/**
 * Verify the compatibility view against what `@xrn1997/dsh-session-delete` does:
 * path arithmetic for the session directory, then `rename` into a trash folder.
 * Same-volume projects must work; cross-volume ones must fail with EXDEV, which
 * is that plugin's own documented constraint.
 */
import fs from 'node:fs'
import path from 'node:path'
import { migrateProject, normalizeConfig, projectKey, projectSessionRoot } from '../lib/core.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function makeProject(base) {
  const central = path.join(base, 'central')
  const project = path.join(base, 'proj')
  const trash = path.join(base, 'trash')
  fs.mkdirSync(central, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(trash, { recursive: true })
  return { central, project, trash }
}

function seed(central, project, sessionId) {
  const dir = path.join(central, projectKey(project), sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), `log-${sessionId}`)
}

// ---------------------------------------------------------------- same volume
const sameVolume = makeProject('D:\\spl-view-test')
const settingsD = normalizeConfig({ root: sameVolume.central, statePath: path.join(sameVolume.central, 'state.json') })
seed(sameVolume.central, sameVolume.project, 'session-demo')
migrateProject(settingsD, sameVolume.project, { force: true })

const key = projectKey(sameVolume.project)
const view = path.join(sameVolume.central, key)
const sessionDir = path.join(view, 'session-demo') // exactly what the delete plugin computes
check('the computed session directory exists through the view', fs.existsSync(sessionDir))
check('its log is the real project file', fs.readFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'utf8') === 'log-session-demo')

// The delete plugin's move: rename(sessionDir, trashDir)
let moved
try {
  fs.renameSync(sessionDir, path.join(sameVolume.trash, 'session-demo'))
  moved = true
} catch (error) {
  moved = false
  check('rename into the trash succeeds', false, error.code ?? error.message)
}
if (moved) {
  check('rename into the trash succeeds', true)
  check('the real directory left the project', !fs.existsSync(path.join(projectSessionRoot(settingsD, sameVolume.project), key, 'session-demo')))
  check('the trash holds the real log', fs.readFileSync(path.join(sameVolume.trash, 'session-demo', 'session.v4.jsonl.zstd'), 'utf8') === 'log-session-demo')
  // The delete plugin's restore: rename(trashDir, sessionDir)
  fs.renameSync(path.join(sameVolume.trash, 'session-demo'), sessionDir)
  check('restore puts it back through the view', fs.existsSync(path.join(sessionDir, 'session.v4.jsonl.zstd')))
}

// ------------------------------------------------------------- other volume
const otherVolume = makeProject('E:\\Ai\\Study\\26AI\\261103－Dsh\\session-project-logs\\test\\tmp\\view-volume')
const settingsE = normalizeConfig({ root: 'D:\\spl-view-test\\central2', statePath: path.join(otherVolume.project, 'state.json') })
fs.mkdirSync(settingsE.root, { recursive: true })
seed(settingsE.root, otherVolume.project, 'session-remote')
migrateProject(settingsE, otherVolume.project, { force: true })
const remoteSession = path.join(settingsE.root, projectKey(otherVolume.project), 'session-remote')
check('cross-volume view still resolves', fs.existsSync(remoteSession))
try {
  fs.renameSync(remoteSession, path.join(sameVolume.trash, 'session-remote'))
  check('cross-volume rename fails with EXDEV (expected, documented upstream)', false, 'rename unexpectedly succeeded')
} catch (error) {
  check('cross-volume rename fails with EXDEV (expected, documented upstream)', error.code === 'EXDEV', error.code ?? error.message)
}

// ------------------------------------------------------------------ cleanup
for (const dir of ['D:\\spl-view-test', 'E:\\Ai\\Study\\26AI\\261103－Dsh\\session-project-logs\\test\\tmp\\view-volume']) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.log(`cleanup warning: ${dir}: ${error.code ?? error.message}`)
  }
}

const failed = results.filter((entry) => !entry.ok).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
