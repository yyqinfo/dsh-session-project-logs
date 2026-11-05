/**
 * Storage layout, skip rules, and offline migration for project-local session
 * logs.
 *
 * The shipped JSONL backend derives every artifact path as
 * `<root>/<projectKey(cwd)>/<sessionId>/session.vN.jsonl[.zstd]`. A project-local
 * root keeps that layout unchanged, which is what makes an offline move between
 * the central root and a project root a plain directory rename.
 *
 * Node builtins only: a profile-installed bundle is linked into the profile and
 * cannot resolve the harness's own node_modules from here.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const PLUGIN_NAME = 'session-project-logs'
export const DEFAULT_DIR_NAME = '.dsh/sessions'
/** File name the shipped backend writes inside every session directory. */
const SESSION_ARTIFACT = 'session.v4.jsonl.zstd'
const GITIGNORE_BODY = '*\n!.gitignore\n'

/** Expand a leading `~`, `~/`, or `~\` against the operating-system home. */
export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** Resolve the DeepSeek Harness home (`$DSH_HOME`, else `~/.dsh`). */
export function dshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  return fromEnv.length > 0 ? path.resolve(expandHome(fromEnv)) : path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the session root the JSONL backend was configured with. The shipped
 * composition uses `dshHomePath('sessions')`, which is exactly this value.
 */
export function resolveSessionsRoot(configured) {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  if (raw.length > 0) return path.resolve(expandHome(raw))
  return path.join(dshHome(), 'sessions')
}

/**
 * Build the readable directory key for a project path — byte-for-byte the rule
 * used by `@deepseek-ai/dsh-session-persistence-jsonl` (`projectKey`), so the
 * plugin addresses the very directories the backend wrote.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Escape a session id to the single path segment the backend uses. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

const isWin = () => process.platform === 'win32'

/** Case-insensitive identity of a path on Windows, exact elsewhere. */
export function pathKey(target) {
  const resolved = path.resolve(target)
  return isWin() ? resolved.toLowerCase() : resolved
}

export function samePath(a, b) {
  return pathKey(a) === pathKey(b)
}

/** Whether `child` lives strictly below `parent`. */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  if (rel === '') return false
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

function statSafe(target) {
  try {
    return fs.statSync(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/** `lstat` without throwing on absence: links must be recognised, not followed. */
function lstatSafe(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/** Resolve a link's target, interpreting a relative spelling against its directory. */
function readLinkTarget(linkPath) {
  const raw = fs.readlinkSync(linkPath)
  return path.resolve(path.dirname(linkPath), raw)
}

/** Resolve the configured plugin settings, filling every default. */
export function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  const dirName = typeof input.dirName === 'string' && input.dirName.trim().length > 0
    ? input.dirName.trim()
    : DEFAULT_DIR_NAME
  const ignore = Array.isArray(input.ignore)
    ? input.ignore
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => path.resolve(expandHome(entry.trim())))
    : []
  const statePath = input.statePath === false
    ? ''
    : (typeof input.statePath === 'string' && input.statePath.trim().length > 0
      ? path.resolve(expandHome(input.statePath.trim()))
      : path.join(dshHome(), 'logs', 'session-project-logs.state.json'))
  const reportPath = input.reportPath === false
    ? ''
    : (typeof input.reportPath === 'string' && input.reportPath.trim().length > 0
      ? path.resolve(expandHome(input.reportPath.trim()))
      : path.join(dshHome(), 'logs', 'session-project-logs.json'))
  const indexPath = input.indexPath === false
    ? ''
    : (typeof input.indexPath === 'string' && input.indexPath.trim().length > 0
      ? path.resolve(expandHome(input.indexPath.trim()))
      : (statePath === '' ? '' : path.join(path.dirname(statePath), 'session-project-logs.index.json')))
  return {
    root: resolveSessionsRoot(input.root),
    dirName,
    gitignore: input.gitignore !== false,
    routeNewSessions: input.routeNewSessions !== false,
    centralView: input.centralView !== false,
    ignore,
    indexPath,
    reportPath,
    statePath,
  }
}

/**
 * Decide whether a directory may host project-local logs.
 *
 * Kept out of the way: roots of drives, the harness home itself, the central
 * sessions root, the user home, temporary directories, and directories that no
 * longer exist. Projects that merely live under the harness home stay eligible.
 *
 * @param settings - normalized plugin settings.
 * @param projectDir - candidate session cwd.
 * @returns a human-readable skip reason, or `undefined` when the project qualifies.
 */
export function skipReason(settings, projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return 'empty cwd'
  if (!path.isAbsolute(projectDir)) return 'cwd is not absolute'
  const resolved = path.resolve(projectDir)
  const info = statSafe(resolved)
  if (info === undefined) return 'project directory does not exist'
  if (!info.isDirectory()) return 'cwd is not a directory'
  if (path.dirname(resolved) === resolved) return 'cwd is a filesystem root'
  if (samePath(resolved, settings.root)) return 'cwd is the central sessions root'
  if (isInside(settings.root, resolved)) return 'cwd is inside the central sessions root'
  if (samePath(resolved, dshHome())) return 'cwd is the harness home'
  if (samePath(resolved, os.homedir())) return 'cwd is the user home'
  const temporary = expandHome(os.tmpdir())
  if (samePath(resolved, temporary) || isInside(temporary, resolved)) return 'cwd is inside the temporary directory'
  for (const prefix of settings.ignore) {
    if (samePath(prefix, resolved) || isInside(prefix, resolved)) return `cwd matches ignored path ${prefix}`
  }
  return undefined
}

/** The per-project session root for a cwd. */
export function projectSessionRoot(settings, projectDir) {
  return path.join(path.resolve(projectDir), settings.dirName)
}

/** `<root>/<projectKey(cwd)>/<encodedSessionId>` — the backend's session directory. */
export function sessionDirectory(root, cwd, sessionId) {
  return path.join(root, projectKey(cwd), encodeSegment(sessionId))
}

/** Create a project's session root, marking it as generated content for Git. */
export function ensureProjectRoot(settings, projectDir) {
  const root = projectSessionRoot(settings, projectDir)
  if (!isInside(path.resolve(projectDir), root)) throw new Error(`refusing to place logs outside the project: ${root}`)
  fs.mkdirSync(root, { recursive: true })
  if (settings.gitignore) {
    const gitignore = path.join(root, '.gitignore')
    if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, GITIGNORE_BODY, 'utf8')
  }
  return root
}

/**
 * The compatibility view: `<root>/<projectKey>` as a link to the project's own
 * `<dirName>/<projectKey>` directory.
 *
 * Some tools (the session-delete plugin among them) compute a session directory
 * as `<root>/<projectKey>/<sessionId>` by pure path arithmetic instead of asking
 * the persistence service. This view makes that arithmetic resolve to the real
 * files: the shipped backend still ignores links when it lists project
 * directories, and operations *inside* the link (rename a session directory into
 * a trash folder, read its size) act on the real directory in the project.
 *
 * @param settings - normalized plugin settings.
 * @param projectDir - the project whose sessions moved into itself.
 * @returns the view path, or `undefined` when the view is disabled or blocked.
 */
export function ensureCentralView(settings, projectDir) {
  if (settings.centralView !== true) return undefined
  const key = projectKey(projectDir)
  const viewPath = path.join(settings.root, key)
  const target = path.join(projectSessionRoot(settings, projectDir), key)
  if (!fs.existsSync(target)) return undefined
  const existing = lstatSafe(viewPath)
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return undefined // a real directory: still central, migrate handles it
    let pointed
    try {
      pointed = readLinkTarget(viewPath)
    } catch {
      return undefined
    }
    if (samePath(pointed, target)) return viewPath
    try {
      fs.unlinkSync(viewPath)
    } catch {
      return undefined
    }
  }
  try {
    fs.mkdirSync(settings.root, { recursive: true })
    fs.symlinkSync(target, viewPath, process.platform === 'win32' ? 'junction' : 'dir')
    return viewPath
  } catch {
    return undefined
  }
}

/** Remove the compatibility view when it points into the project. */
export function removeCentralView(settings, projectDir) {
  const viewPath = path.join(settings.root, projectKey(projectDir))
  const existing = lstatSafe(viewPath)
  if (existing === undefined || !existing.isSymbolicLink()) return false
  let pointed
  try {
    pointed = readLinkTarget(viewPath)
  } catch {
    return false
  }
  const target = path.join(projectSessionRoot(settings, projectDir), projectKey(projectDir))
  if (!samePath(pointed, target)) return false
  try {
    fs.unlinkSync(viewPath)
    return true
  } catch {
    return false
  }
}

/**
 * Name the shape of one project's compatibility view.
 *
 * The view is a junction (Windows) or a directory symlink, which makes it *machine
 * local*: a sync tool that follows links turns it into a plain directory holding a
 * copy of the project's sessions. `kind` reports exactly which of those happened.
 */
export function inspectView(settings, projectDir) {
  const key = projectKey(projectDir)
  const viewPath = path.join(settings.root, key)
  const target = path.join(projectSessionRoot(settings, projectDir), key)
  const existing = lstatSafe(viewPath)
  const base = { project: projectDir, key, viewPath, expected: target }
  if (existing === undefined) return { ...base, kind: 'missing' }
  if (existing.isSymbolicLink()) {
    let pointed
    try {
      pointed = readLinkTarget(viewPath)
    } catch {
      return { ...base, kind: 'link', target: undefined, correct: false }
    }
    return { ...base, kind: 'link', target: pointed, correct: samePath(pointed, target) }
  }
  // A real directory where a link belongs: either the sessions are still central
  // (nothing to fix) or a sync materialised the link into a copy.
  const central = directoryNames(viewPath)
  const local = directoryNames(target)
  const onlyCentral = central.filter((name) => !local.includes(name))
  const divergent = []
  for (const name of central) {
    if (!local.includes(name)) continue
    const fromCentral = artifactSize(path.join(viewPath, name))
    const fromProject = artifactSize(path.join(target, name))
    if (fromCentral !== undefined && (fromProject === undefined || fromCentral > fromProject)) divergent.push(name)
  }
  return {
    ...base,
    kind: 'directory',
    central: central.length,
    local: local.length,
    onlyCentral,
    divergent,
  }
}

/** Session directory names inside one directory (empty when unreadable). */
function directoryNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Size of a session's log artifact, or `undefined` when the session has no log yet. */
function artifactSize(dir) {
  try {
    return fs.statSync(path.join(dir, SESSION_ARTIFACT)).size
  } catch {
    return undefined
  }
}

/**
 * Remove every compatibility view this plugin owns.
 *
 * Meant to run *before* syncing the harness home to another machine: with no link to
 * follow, a sync tool cannot turn a view into a copied directory. Each machine
 * recreates the views it needs on the next start.
 */
export function stripViews(settings, projects) {
  const wanted = projects === undefined || projects.length === 0
    ? undefined
    : new Set(projects.map((project) => projectKey(project)))
  const removed = []
  let entries
  try {
    entries = fs.readdirSync(settings.root, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    if (wanted !== undefined && !wanted.has(entry.name)) continue
    const viewPath = path.join(settings.root, entry.name)
    let pointed
    try {
      pointed = readLinkTarget(viewPath)
    } catch {
      continue
    }
    // Only links that mimic the backend layout: `<root>/<key> -> <project>/<dir>/<key>`.
    // `dirName` may span several segments (`.dsh/sessions`), so compare the tail.
    const suffix = path.join(settings.dirName, entry.name).toLowerCase()
    if (!pointed.toLowerCase().endsWith(suffix)) continue
    try {
      fs.unlinkSync(viewPath)
      removed.push(viewPath)
    } catch {
      // Leave it; the caller reports what it could not do.
    }
  }
  return removed
}

/**
 * Make one project's view a link again after a sync materialised it into a directory.
 *
 * A copy is only dropped when every session in it also exists inside the project and
 * none of those copies is larger than the original — otherwise the copy may hold
 * writes the project never saw, so the view is reported as `blocked` and the caller is
 * told to migrate first (`migrate` moves those sessions into the project, after which
 * the repair has nothing to lose).
 */
export function repairViews(settings, projects, options = {}) {
  const dryRun = options.dryRun === true
  const force = options.force === true
  const results = []
  for (const project of projects) {
    const view = inspectView(settings, project)
    if (view.kind === 'link' && view.correct) {
      results.push({ ...view, status: 'ok' })
      continue
    }
    if (view.kind === 'missing') {
      const created = dryRun ? undefined : ensureCentralView(settings, project)
      results.push({ ...view, status: dryRun ? 'would-create' : (created === undefined ? 'skipped' : 'created') })
      continue
    }
    if (view.kind === 'link') {
      if (!dryRun) {
        removeCentralView(settings, project)
        ensureCentralView(settings, project)
      }
      results.push({ ...view, status: pureDry(dryRun, 'would-repoint', 'repointed') })
      continue
    }
    // kind === 'directory'
    if (view.onlyCentral.length > 0) {
      results.push({ ...view, status: 'blocked', reason: 'the central copy holds sessions the project does not have; run "migrate <project>" first' })
      continue
    }
    if (view.divergent.length > 0 && !force) {
      results.push({ ...view, status: 'blocked', reason: `the central copy has larger logs for ${view.divergent.length} session(s); pass --force to drop them anyway` })
      continue
    }
    if (dryRun) {
      results.push({ ...view, status: 'would-replace' })
      continue
    }
    try {
      fs.rmSync(view.viewPath, { recursive: true, force: true })
    } catch (error) {
      results.push({ ...view, status: 'error', reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const created = ensureCentralView(settings, project)
    results.push({ ...view, status: created === undefined ? 'error' : 'replaced' })
  }
  return results
}

function pureDry(dryRun, whenDry, whenNot) {
  return dryRun ? whenDry : whenNot
}

/** Session directories the central root holds for one project. */
export function centralSessions(settings, projectDir) {  const dir = path.join(settings.root, projectKey(projectDir))
  const existing = lstatSafe(dir)
  // A compatibility view resolves into the project: every session is already
  // local, so nothing here is central.
  if (existing !== undefined && existing.isSymbolicLink()) return { dir, sessions: [], linked: true }
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { dir, sessions: [] }
  }
  return { dir, sessions: names.filter((entry) => entry.isDirectory()).map((entry) => entry.name) }
}

/**
 * Read a session artifact's header line to recover the session's cwd.
 * Compressed artifacts are concatenated Zstandard frames and the first frame is
 * the header alone, which is all this needs.
 */
function readHeaderCwd(file) {
  let text
  try {
    const buffer = fs.readFileSync(file)
    text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
  } catch {
    return undefined
  }
  const line = text.split('\n', 1)[0]
  try {
    const header = JSON.parse(line)
    return typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Recover every project that still keeps sessions on the central root by reading
 * one session header per project directory. This is what makes `migrate --all`
 * possible without a prior registry entry.
 *
 * @param settings - normalized plugin settings.
 * @returns `{ project, sessions }` per discovered project directory.
 */
export function discoverCentralProjects(settings) {
  let entries
  try {
    entries = fs.readdirSync(settings.root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = new Map()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(settings.root, entry.name)
    let sessions
    try {
      sessions = fs.readdirSync(dir, { withFileTypes: true }).filter((child) => child.isDirectory())
    } catch {
      continue
    }
    let project
    for (const session of sessions) {
      const sessionDir = path.join(dir, session.name)
      let files
      try {
        files = fs.readdirSync(sessionDir)
      } catch {
        continue
      }
      const artifact = files.find((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
      if (artifact === undefined) continue
      project = readHeaderCwd(path.join(sessionDir, artifact))
      if (project !== undefined) break
    }
    if (project === undefined) continue
    const key = pathKey(project)
    const previous = found.get(key)
    found.set(key, { project, sessions: (previous?.sessions ?? 0) + sessions.length })
  }
  return [...found.values()]
}

/** Move one session directory between roots, copying across volumes. */
function moveDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
      fs.rmSync(from, { recursive: true, force: true })
      return
    }
    throw error
  }
}

/** Newest modification time inside one session directory, in epoch milliseconds. */
function sessionActivity(name, root, key) {
  const dir = path.join(root, key, name)
  let newest = 0
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) walk(child)
        else newest = Math.max(newest, fs.statSync(child).mtimeMs)
      } catch {
        // An unreadable entry just does not contribute to the activity estimate.
      }
    }
  }
  walk(dir)
  return newest
}

/**
 * Move every centrally stored session of one project into the project directory.
 *
 * Offline operation: a live write handle keeps writing to the root it opened on,
 * so the harness must be stopped. As a guard against running it anyway, a session
 * whose artifact changed within `quietMinutes` is left in place (it is almost
 * certainly being written right now) unless `force` is set.
 *
 * @param settings - normalized plugin settings.
 * @param projectDir - the project whose sessions should move.
 * @param options - `dryRun` reports without moving, `force` ignores the activity
 *   guard, `quietMinutes` sets its window (default 10).
 * @returns moved/failed/skipped counts and the paths involved.
 */
export function migrateProject(settings, projectDir, options = {}) {
  const blocked = skipReason(settings, projectDir)
  if (blocked !== undefined) return { status: 'skipped', reason: blocked, moved: 0, failed: 0, skipped: [] }
  const central = centralSessions(settings, projectDir)
  if (central.linked === true) {
    return { status: 'already-local', reason: 'the central path is the compatibility view', moved: 0, failed: 0, skipped: [] }
  }
  const { sessions } = central
  if (sessions.length === 0) return { status: 'empty', moved: 0, failed: 0, skipped: [] }
  const targetRoot = projectSessionRoot(settings, projectDir)
  const key = projectKey(projectDir)
  const quietMinutes = Number.isFinite(options.quietMinutes) ? options.quietMinutes : 10
  const active = []
  const movable = []
  const now = Date.now()
  for (const name of sessions) {
    const lastWrite = sessionActivity(name, settings.root, key)
    if (options.force !== true && quietMinutes > 0 && lastWrite > 0 && now - lastWrite < quietMinutes * 60_000) {
      active.push({ name, minutesAgo: Math.round((now - lastWrite) / 60_000) })
    } else {
      movable.push(name)
    }
  }
  if (options.dryRun === true) {
    return {
      status: active.length > 0 ? 'dry-run-active' : 'dry-run',
      moved: movable.length,
      failed: 0,
      skipped: active,
      sessions: movable,
    }
  }
  ensureProjectRoot(settings, projectDir)
  let moved = 0
  const failures = []
  for (const name of movable) {
    const from = path.join(settings.root, key, name)
    const to = path.join(targetRoot, key, name)
    if (fs.existsSync(to)) {
      failures.push({ name, reason: 'already present in the project directory' })
      continue
    }
    try {
      moveDirectory(from, to)
      moved += 1
    } catch (error) {
      failures.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  // Drop the now-empty project directory from the central root when possible.
  try {
    const leftover = fs.readdirSync(path.join(settings.root, key))
    if (leftover.length === 0) fs.rmdirSync(path.join(settings.root, key))
  } catch {
    // A remaining entry means a session could not move; keep the directory.
  }
  // Re-publish the path-based view so tools that compute the session directory
  // keep resolving to the real, now project-local, directories.
  if (failures.length === 0) ensureCentralView(settings, projectDir)
  const status = failures.length > 0 ? 'partial' : (active.length > 0 ? 'migrated-with-skips' : 'migrated')
  return { status, moved, failed: failures.length, failures, skipped: active }
}

/** Move one project's sessions back to the central root (undo). */
export function restoreProject(settings, projectDir, options = {}) {
  const targetRoot = projectSessionRoot(settings, projectDir)
  const key = projectKey(projectDir)
  const dir = path.join(targetRoot, key)
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { status: 'absent', moved: 0, failed: 0 }
  }
  if (names.length === 0) return { status: 'absent', moved: 0, failed: 0 }
  if (options.dryRun === true) return { status: 'dry-run', moved: names.length, failed: 0, sessions: names }
  // The compatibility view occupies the central path; drop it so the sessions can
  // land in a real directory there.
  removeCentralView(settings, projectDir)
  let moved = 0
  const failures = []
  for (const name of names) {
    const from = path.join(dir, name)
    const to = path.join(settings.root, key, name)
    if (fs.existsSync(to)) {
      failures.push({ name, reason: 'already present in the central root' })
      continue
    }
    try {
      moveDirectory(from, to)
      moved += 1
    } catch (error) {
      failures.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { status: failures.length === 0 ? 'restored' : 'partial', moved, failed: failures.length, failures }
}

/** What one project currently holds on each side, for diagnostics. */
export function inspectProject(settings, projectDir) {
  const { dir, sessions, linked } = centralSessions(settings, projectDir)
  const projectRoot = projectSessionRoot(settings, projectDir)
  const key = projectKey(projectDir)
  let local = []
  try {
    local = fs.readdirSync(path.join(projectRoot, key), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    local = []
  }
  return {
    project: path.resolve(projectDir),
    central: { dir, sessions: sessions.length, view: linked === true },
    local: { dir: path.join(projectRoot, key), sessions: local.length },
    skipped: skipReason(settings, projectDir),
  }
}

/** Read the plugin's persisted project registry. */
export function readRegistry(settings) {
  if (settings.statePath === '') return { projects: [] }
  try {
    const raw = fs.readFileSync(settings.statePath, 'utf8')
    const parsed = JSON.parse(raw)
    const projects = Array.isArray(parsed?.projects)
      ? parsed.projects.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : []
    return { projects }
  } catch {
    return { projects: [] }
  }
}

/** Persist the project registry (best effort, atomic-ish). */
export function writeRegistry(settings, projects) {
  if (settings.statePath === '') return
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    root: settings.root,
    dirName: settings.dirName,
    projects: [...new Set(projects)].sort(),
  }
  try {
    fs.mkdirSync(path.dirname(settings.statePath), { recursive: true })
    const temporary = `${settings.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, settings.statePath)
  } catch {
    // The registry is an accelerator; losing a write only costs a rescan.
  }
}

/**
 * Read the persisted session index: which root owns each session id.
 *
 * Looking a session up used to scan every project backend (823 directory
 * operations for 36 backends), and a page load asks for dozens of sessions —
 * that storm is what made loading slow. The index turns the common lookup into a
 * map hit.
 *
 * @param settings - normalized plugin settings.
 * @returns `{ sessions: Map<id, root|'central'> }`.
 */
export function readIndex(settings) {
  const sessions = new Map()
  if (settings.indexPath === '') return { sessions }
  try {
    const parsed = JSON.parse(fs.readFileSync(settings.indexPath, 'utf8'))
    const entries = parsed?.sessions
    if (entries !== null && typeof entries === 'object') {
      for (const [id, root] of Object.entries(entries)) {
        if (typeof id === 'string' && typeof root === 'string') sessions.set(id, root)
      }
    }
  } catch {
    // A missing or damaged index only costs a rescan.
  }
  return { sessions }
}

/** Persist the session index (best effort, atomic-ish). */
export function writeIndex(settings, sessions) {
  if (settings.indexPath === '') return
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    root: settings.root,
    sessions: Object.fromEntries([...sessions].sort(([left], [right]) => left.localeCompare(right))),
  }
  try {
    fs.mkdirSync(path.dirname(settings.indexPath), { recursive: true })
    const temporary = `${settings.indexPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8')
    fs.renameSync(temporary, settings.indexPath)
  } catch {
    // The index is an accelerator.
  }
}

/**
 * Every session id one project root currently holds.
 * A root keeps `<root>/<projectKey(cwd)>/<encoded id>/`, and the key belongs to
 * the session's cwd — not to the root — so the ids are collected by walking the
 * root instead of recomputing a path.
 */
function collectSessionIds(root, cache) {
  const cached = cache.get(root)
  if (cached !== undefined) return cached
  const ids = new Set()
  let keys
  try {
    keys = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    cache.set(root, ids)
    return ids
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue
    let entries
    try {
      entries = fs.readdirSync(path.join(root, key.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) ids.add(entry.name)
  }
  cache.set(root, ids)
  return ids
}

/**
 * The set of session directory names (`encodeSegment(id)`) one root holds.
 *
 * Directory names only — no session header is read — so this is the cheap way to
 * answer "does this root own that id?" without paying for 800 zstd header decodes.
 * Asynchronous on purpose: it runs while the host is serving requests.
 */
export async function sessionIdSet(root) {
  const ids = new Set()
  let keys
  try {
    keys = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return ids
  }
  await Promise.all(keys.map(async (key) => {
    if (!key.isDirectory()) return
    try {
      const entries = await fs.promises.readdir(path.join(root, key.name), { withFileTypes: true })
      for (const entry of entries) if (entry.isDirectory()) ids.add(entry.name)
    } catch {
      // An unreadable project directory contributes nothing.
    }
  }))
  return ids
}

/** Forget index entries whose session directory no longer exists in their root. */
export function pruneIndex(settings, sessions) {
  const removed = []
  const cache = new Map()
  for (const [id, root] of sessions) {
    if (root === CENTRAL_MARKER) continue
    const ids = collectSessionIds(root, cache)
    if (!ids.has(encodeSegment(id))) {
      removed.push(id)
      sessions.delete(id)
    }
  }
  return removed
}

export const CENTRAL_MARKER = 'central'

// ---------------------------------------------------------------- log health

const LOG_ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
/** Markers a sync tool puts in the name of a conflict copy next to the real log. */
const CONFLICT_MARKERS = ['冲突', '.sync-conflict', 'conflicted copy', 'Konflikt']

/**
 * Decode a concatenated-frame session log into its rows.
 *
 * Appends write one Zstandard frame per batch, so a record may span frames and a
 * killed write can leave a record cut in half. Both are reported as `torn` — the
 * backend (0.2.2+) refuses such a log with
 * "complete frame contains a torn JSONL record".
 */
function decodeSessionLog(file) {
  const buffer = fs.readFileSync(file)
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (LOG_ZSTD_MAGIC.every((byte, offset) => buffer[index + offset] === byte)) offsets.push(index)
  }
  const seqs = []
  const torn = []
  const rows = []
  for (let index = 0; index < offsets.length; index += 1) {
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length))
    } catch {
      torn.push(`frame ${index + 1} does not decompress`)
      continue
    }
    const raw = text.toString('utf8')
    if (raw.length > 0 && !raw.endsWith('\n')) torn.push(`frame ${index + 1} stops mid-record`)
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const row = JSON.parse(line)
        rows.push(row)
        if (typeof row?.seq === 'number') seqs.push(row.seq)
      } catch {
        torn.push(`frame ${index + 1} ends with an incomplete row`)
      }
    }
  }
  return { seqs, torn, rows }
}

/**
 * Replay the durable inbox fold (`@deepseek-ai/dsh-agent-loop`) and report the first
 * splice it would refuse.
 *
 * A log can read perfectly and still fail to *project*: the fold requires every
 * `agent/inbox/spliced` row's `start`/`removedCount` to fit the pending queue, so a
 * merge of two writers that each cancelled the same pending message leaves one
 * cancellation removing an item that is already gone
 * ("invalid persisted inbox splice at session seq N").
 */
function inboxSpliceIssue(rows) {
  const state = { 'next-turn': [], 'next-step': [] }
  for (const row of rows) {
    if (row?.type !== 'agent/inbox/spliced') continue
    const data = row.data ?? {}
    const target = data.target === 'next-step' ? 'next-step' : 'next-turn'
    const inbox = state[target]
    const start = Number.isSafeInteger(data.start) ? data.start : 0
    const removedCount = Number.isSafeInteger(data.removedCount) ? data.removedCount : 0
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    if (start < 0 || start > inbox.length) return { seq: row.seq, target, problem: `start ${start} out of 0..${inbox.length}` }
    if (removedCount < 0 || start + removedCount > inbox.length) {
      return { seq: row.seq, target, problem: `removedCount ${removedCount} exceeds ${inbox.length - start} pending` }
    }
    const next = inbox.slice(0, start).concat(inserted, inbox.slice(start + removedCount))
    const union = target === 'next-turn' ? [...next, ...state['next-step']] : [...state['next-turn'], ...next]
    const ids = new Set()
    for (const message of union) {
      if (ids.has(message?.id)) return { seq: row.seq, target, problem: `duplicate pending id ${message?.id}` }
      ids.add(message?.id)
    }
    state[target] = next
  }
  return undefined
}

/** The ranges a seq list is missing (`[[from, to], ...]`). */
function seqGaps(seqs) {
  const sorted = [...new Set(seqs)].sort((left, right) => left - right)
  const gaps = []
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] !== sorted[index - 1] + 1) gaps.push([sorted[index - 1] + 1, sorted[index] - 1])
  }
  if (sorted.length > 0 && sorted[0] !== 0) gaps.unshift([0, sorted[0] - 1])
  return gaps
}

/**
 * The backend also requires seq numbers to increase by one *in file order*.
 *
 * A replayed append (a resume that re-wrote the tail) leaves a seq twice, or a seq
 * that goes backwards, and the reader reports it as
 * "released v2 row N has seq gap (expected N, got M)". Sorted-set continuity does not
 * catch that, so the order is checked separately.
 */
function seqOrderIssue(seqs) {
  for (let index = 1; index < seqs.length; index += 1) {
    if (seqs[index] !== seqs[index - 1] + 1) return { at: index, expected: seqs[index - 1] + 1, actual: seqs[index] }
  }
  if (seqs.length > 0 && seqs[0] !== 0) return { at: 0, expected: 0, actual: seqs[0] }
  return undefined
}

/** `<root>/<projectKey>/<sessionId>` directories of one root. */
function sessionDirectoriesUnder(root) {
  const out = []
  let keys
  try {
    keys = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue
    const keyDir = path.join(root, key.name)
    let sessions
    try {
      sessions = fs.readdirSync(keyDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) if (session.isDirectory()) out.push(path.join(keyDir, session.name))
  }
  return out
}

/**
 * Check every session log a project (or the whole harness) keeps for the damage a
 * sync or an interrupted write leaves behind.
 *
 * A log is reported when its seq numbers have a hole, when a frame ends mid-record,
 * or when a frame cannot be decompressed. `conflicts` lists the sync conflict copies
 * sitting next to the log: those carry the rows a block-level sync dropped, so a
 * merge can be lossless.
 *
 * @param settings - normalized plugin settings.
 * @param options - `{ projects }` to limit the scan (default: the registry plus the
 *   central root).
 * @returns `{ scanned, roots, findings }`.
 */
export function scanSessionLogs(settings, options = {}) {
  const projects = options.projects ?? readRegistry(settings).projects
  const roots = [...new Set([...projects.map((project) => projectSessionRoot(settings, project)), settings.root])]
  const findings = []
  let scanned = 0
  for (const root of roots) {
    for (const sessionDir of sessionDirectoriesUnder(root)) {
      const artifact = path.join(sessionDir, SESSION_ARTIFACT)
      if (!fs.existsSync(artifact)) continue
      scanned += 1
      let decoded
      try {
        decoded = decodeSessionLog(artifact)
      } catch (error) {
        findings.push({ session: sessionDir, kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      const gaps = seqGaps(decoded.seqs)
      const order = seqOrderIssue(decoded.seqs)
      const splice = gaps.length === 0 && decoded.torn.length === 0 && order === undefined ? inboxSpliceIssue(decoded.rows) : undefined
      if (gaps.length === 0 && decoded.torn.length === 0 && splice === undefined && order === undefined) continue
      let conflicts = []
      try {
        conflicts = fs.readdirSync(sessionDir)
          .filter((name) => name !== SESSION_ARTIFACT && name.startsWith('session.v4.jsonl'))
          .filter((name) => CONFLICT_MARKERS.some((marker) => name.includes(marker)))
      } catch {
        // A directory we cannot list simply has no visible conflict copy.
      }
      const kind = order !== undefined
        ? 'order'
        : (gaps.length > 0 || decoded.torn.length > 0
          ? (gaps.length > 0 ? (decoded.torn.length > 0 ? 'gaps+torn' : 'gaps') : 'torn')
          : 'splice')
      findings.push({
        session: sessionDir,
        kind,
        rows: decoded.seqs.length,
        lastSeq: decoded.seqs.length > 0 ? Math.max(...decoded.seqs) : -1,
        gaps: gaps.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)),
        missing: gaps.reduce((sum, [from, to]) => sum + (to - from + 1), 0),
        order,
        torn: decoded.torn.slice(0, 3),
        splice,
        conflicts,
      })
    }
  }
  return { scanned, roots, findings }
}
