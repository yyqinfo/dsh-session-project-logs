/**
 * Project-local session logs — Host plugin.
 *
 * The shipped JSONL persistence backend owns exactly one root and derives every
 * artifact path from it, so it cannot be pointed at a project per session. This
 * plugin therefore keeps the shipped provider and wraps its routing surface:
 *
 * - a session created with a project cwd is stored by a JSONL backend mounted on
 *   that project's own root (`<project>/.dsh/sessions`), one backend per project;
 * - sessions that already live under the central root, and sessions whose cwd is
 *   unsuitable (home, temp, drive root, …), keep using the original provider;
 * - `open`, `stat`, `list`, and `flush` fan out across both.
 *
 * Nothing in the storage format changes: each project backend is the shipped
 * backend, so logs stay standard `session.vN.jsonl[.zstd]` artifacts and a plain
 * directory move is all an offline migration needs.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as core from './lib/core.js'
import {
  loadHarnessModules,
  mountBackend,
  providerBaseClass,
  resolveHarnessModuleUrls,
} from './lib/harness.js'

export const name = 'session-project-logs'

/** The shipped persistence service must exist before it can be wrapped. */
export const inject = ['sessionPersistence']

const CENTRAL = Symbol('central')

/**
 * Activate project-local routing.
 * @param ctx - the plugin's Cordis context.
 * @param config - the loader row's config (all fields optional).
 */
export function apply(ctx, config) {
  const log = createLogger(ctx)
  const settings = core.normalizeConfig(config)
  const service = ctx.get('sessionPersistence')
  if (service === undefined || service === null) {
    log.error('no session persistence service to wrap; sessions stay on the central root')
    return
  }
  if (!settings.routeNewSessions) {
    log.info('routeNewSessions is off; the plugin only provides the offline migration command')
    return
  }

  const urls = resolveHarnessModuleUrls()
  if (urls === undefined) {
    log.error('cannot locate the harness persistence packages from this process; leaving the central root in place')
    return
  }

  return install(ctx, settings, service, urls, log)
}

async function install(ctx, settings, service, urls, log) {
  let modules
  try {
    modules = await loadHarnessModules(urls)
  } catch (error) {
    log.error(`cannot import the harness persistence packages: ${describe(error)}`)
    return
  }
  const { jsonl, seam } = modules

  const baseClass = providerBaseClass(service)
  if (baseClass !== seam.SessionPersistence) {
    log.error(
      'the live persistence provider is not the JSONL backend this plugin knows how to extend '
      + `(base class identity mismatch, resolved from ${urls.anchoredAt}); leaving storage untouched`,
    )
    return
  }

  const original = {
    create: service.create.bind(service),
    open: service.open.bind(service),
    stat: service.stat.bind(service),
    list: service.list.bind(service),
    flush: service.flush.bind(service),
  }
  const state = {
    mounted: new Map(), // project cwd (pathKey) -> { project, root, backend }
    byId: new Map(), // session id -> backend | CENTRAL
    projects: new Set(core.readRegistry(settings).projects),
    counts: { created: 0, central: 0, mounted: 0, fallbacks: 0, errors: 0 },
    registryTimer: undefined,
  }

  const ready = mountRegisteredProjects()

  service.create = async (header, options) => {
    await ready
    const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    let backend
    if (cwd !== undefined) backend = await backendFor(cwd)
    if (backend === undefined) {
      const handle = await original.create(header, options)
      state.byId.set(header.id, CENTRAL)
      state.counts.central += 1
      return handle
    }
    try {
      const handle = await backend.create(header, options)
      state.byId.set(header.id, backend)
      state.counts.created += 1
      return handle
    } catch (error) {
      state.counts.fallbacks += 1
      log.warn(`cannot create "${String(header.id)}" in its project directory (${describe(error)}); using the central root`)
      const handle = await original.create(header, options)
      state.byId.set(header.id, CENTRAL)
      return handle
    }
  }

  service.open = async (id, access, options) => {
    const found = await locate(id)
    if (found === undefined) throw new seam.SessionPersistenceNotFoundError(id)
    return found === CENTRAL ? original.open(id, access, options) : found.open(id, access, options)
  }

  service.stat = async (id, options) => {
    const found = await locate(id)
    if (found === undefined) return undefined
    return found === CENTRAL ? original.stat(id, options) : found.stat(id, options)
  }

  service.list = async (options) => {
    await ready
    const snapshots = []
    for (const snapshot of await original.list(options)) {
      snapshots.push(snapshot)
      state.byId.set(snapshot.header.id, CENTRAL)
    }
    for (const project of state.mounted.values()) {
      let local
      try {
        local = await project.backend.list(options)
      } catch (error) {
        state.counts.errors += 1
        log.warn(`cannot list ${project.root}: ${describe(error)}`)
        continue
      }
      for (const snapshot of local) {
        snapshots.push(snapshot)
        state.byId.set(snapshot.header.id, project.backend)
      }
    }
    return snapshots
  }

  service.flush = async () => {
    await ready
    await original.flush()
    const failures = []
    for (const project of state.mounted.values()) {
      try {
        await project.backend.flush()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'project-local session flush failed')
  }

  ctx.effect(() => () => {
    // Leave the provider exactly as it was found: drop the own properties, so the
    // prototype methods take over again even while the host keeps running.
    for (const method of ['create', 'open', 'stat', 'list', 'flush']) delete service[method]
    if (state.registryTimer !== undefined) clearTimeout(state.registryTimer)
    // Withdraw the compatibility views: nothing lists the project roots any more,
    // so leaving links behind would hide those sessions from every listing.
    for (const project of state.mounted.values()) {
      try {
        if (core.removeCentralView(settings, project.project)) {
          log.debug(`compatibility view withdrawn: ${project.project}`)
        }
      } catch {
        // Best effort: a leftover link is harmless while the plugin is active.
      }
    }
    writeRegistry()
    writeReport()
    log.info('provider restored; new sessions go back to the central root')
  }, 'session-project-logs routing')

  writeReport()
  log.info(`routing new sessions into project directories under <project>/${settings.dirName}`)

  /** Mount every project recorded by the previous run so its sessions stay visible. */
  async function mountRegisteredProjects() {
    for (const project of [...state.projects]) {
      if (core.skipReason(settings, project) !== undefined) continue
      try {
        await backendFor(project)
      } catch (error) {
        log.warn(`cannot mount the session backend of ${project}: ${describe(error)}`)
      }
    }
  }

  async function backendFor(cwd) {
    if (core.skipReason(settings, cwd) !== undefined) return undefined
    const key = core.pathKey(cwd)
    const existing = state.mounted.get(key)
    if (existing !== undefined) return existing.backend
    const root = core.ensureProjectRoot(settings, cwd)
    let mounted
    try {
      mounted = await mountBackend(ctx, jsonl, root)
    } catch (error) {
      state.counts.errors += 1
      log.warn(`cannot mount a session backend for ${cwd}: ${describe(error)}`)
      return undefined
    }
    if (!(mounted.backend instanceof seam.SessionPersistence)) {
      state.counts.errors += 1
      log.error(`the backend mounted for ${cwd} is not the harness persistence class; keeping that project central`)
      try {
        await mounted.fiber.dispose?.()
      } catch {
        // Ignore: a broken mount is already reported.
      }
      return undefined
    }
    state.mounted.set(key, { project: path.resolve(cwd), root, backend: mounted.backend })
    state.counts.mounted += 1
    state.projects.add(path.resolve(cwd))
    scheduleRegistryWrite()
    // Publish the path-based view so tools that compute
    // `<root>/<projectKey>/<sessionId>` by hand keep resolving to the real files.
    const view = core.ensureCentralView(settings, cwd)
    if (view !== undefined) log.debug(`compatibility view published: ${view}`)
    writeReport()
    log.debug(`project backend mounted for ${cwd} (root ${root})`)
    return mounted.backend
  }

  /** Resolve the backend that owns a session id, filling the index as it goes. */
  async function locate(id) {
    await ready
    const cached = state.byId.get(id)
    if (cached !== undefined) return cached
    for (const project of state.mounted.values()) {
      try {
        if (await project.backend.stat(id) !== undefined) {
          state.byId.set(id, project.backend)
          return project.backend
        }
      } catch (error) {
        log.warn(`cannot stat "${String(id)}" in ${project.root}: ${describe(error)}`)
      }
    }
    if (await original.stat(id) !== undefined) {
      state.byId.set(id, CENTRAL)
      return CENTRAL
    }
    return undefined
  }

  function scheduleRegistryWrite() {
    // Write at once so offline tooling sees a new project immediately, then rate
    // limit follow-up writes during a burst of mounts.
    writeRegistry()
    if (state.registryTimer !== undefined) return
    state.registryTimer = setTimeout(() => {
      state.registryTimer = undefined
      writeRegistry()
    }, 1000)
    if (typeof state.registryTimer.unref === 'function') state.registryTimer.unref()
  }

  function writeRegistry() {
    core.writeRegistry(settings, [...state.projects])
  }

  function writeReport() {
    if (settings.reportPath === '') return
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        root: settings.root,
        dirName: settings.dirName,
        centralRoot: settings.root,
        centralView: settings.centralView,
        platform: process.platform,
        anchoredAt: urls.anchoredAt,
        routedProjects: [...state.mounted.values()].map((project) => ({
          project: project.project,
          root: project.root,
        })),
        registry: [...state.projects].sort(),
        totals: state.counts,
      }
      fs.mkdirSync(path.dirname(settings.reportPath), { recursive: true })
      fs.writeFileSync(settings.reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      // Reporting must never disturb storage.
    }
  }
}

/** Build a logger that never throws, even if the logger service is unavailable. */
function createLogger(ctx) {
  const write = (type) => (message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('session-project-logs') : undefined
      if (logger !== undefined && typeof logger[type] === 'function') {
        logger[type](message)
        return
      }
    } catch {
      // fall through to the console bridge
    }
    try {
      const sink = type === 'error' ? console.error : type === 'warn' ? console.warn : console.log
      sink(`[session-project-logs] ${message}`)
    } catch {
      // logging must never break the host
    }
  }
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
