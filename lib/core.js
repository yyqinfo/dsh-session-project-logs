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
  return {
    root: resolveSessionsRoot(input.root),
    dirName,
    gitignore: input.gitignore !== false,
    routeNewSessions: input.routeNewSessions !== false,
    ignore,
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

/** Session directories the central root holds for one project. */
export function centralSessions(settings, projectDir) {
  const dir = path.join(settings.root, projectKey(projectDir))
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

/**
 * Move every centrally stored session of one project into the project directory.
 * Offline operation: run it with the harness stopped, because a live write handle
 * would keep writing to its original root.
 *
 * @param settings - normalized plugin settings.
 * @param projectDir - the project whose sessions should move.
 * @param options - `dryRun` reports without moving.
 * @returns moved/failed counts and the paths involved.
 */
export function migrateProject(settings, projectDir, options = {}) {
  const blocked = skipReason(settings, projectDir)
  if (blocked !== undefined) return { status: 'skipped', reason: blocked, moved: 0, failed: 0 }
  const { sessions } = centralSessions(settings, projectDir)
  if (sessions.length === 0) return { status: 'empty', moved: 0, failed: 0 }
  const targetRoot = projectSessionRoot(settings, projectDir)
  const key = projectKey(projectDir)
  if (options.dryRun === true) return { status: 'dry-run', moved: sessions.length, failed: 0, sessions }
  ensureProjectRoot(settings, projectDir)
  let moved = 0
  const failures = []
  for (const name of sessions) {
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
  return { status: failures.length === 0 ? 'migrated' : 'partial', moved, failed: failures.length, failures }
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
  const { dir, sessions } = centralSessions(settings, projectDir)
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
    central: { dir, sessions: sessions.length },
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
