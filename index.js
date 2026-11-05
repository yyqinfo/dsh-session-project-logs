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
  forgetMountedBackend,
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
    byId: new Map(), // session id -> backend | CENTRAL (resolved cache)
    index: core.readIndex(settings).sessions, // session id -> root path | 'central'
    locating: new Map(), // session id -> in-flight locate promise
    misses: new Map(), // session id -> timestamp of the last failed lookup
    backendLists: new Map(), // backend | CENTRAL -> { at, snapshots }
    idSets: new Map(), // root -> { at, promise<Set<encoded id>> }
    statCache: new Map(), // session id -> { at, snapshot }
    projects: new Set(core.readRegistry(settings).projects),
    counts: { created: 0, central: 0, mounted: 0, fallbacks: 0, errors: 0, listScans: 0, listCached: 0, listValidated: 0, validateDropped: 0, statCached: 0, missScans: 0, idSetBuilds: 0 },
    registryTimer: undefined,
    indexTimer: undefined,
    indexDirty: false,
  }

  const ready = mountRegisteredProjects()

  /**
   * Per-method timings exposed in the report file: they make "it feels slower"
   * measurable (how many list/stat calls a page load actually issues).
   *
   * `recent` keeps the last minute only, so a report read right after a slow page load
   * answers "how slow was it *just now*" instead of averaging over hours.
   */
  const timings = new Map()
  const recent = new Map()
  const RECENT_WINDOW_MS = 60_000
  const recordTiming = (name, started) => {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    const entry = timings.get(name) ?? { calls: 0, ms: 0 }
    entry.calls += 1
    entry.ms += elapsed
    timings.set(name, entry)
    const window = recent.get(name) ?? []
    const now = Date.now()
    window.push({ at: now, ms: elapsed })
    while (window.length > 0 && now - window[0].at > RECENT_WINDOW_MS) window.shift()
    recent.set(name, window)
  }
  const recentSummary = () => Object.fromEntries([...recent].map(([name, window]) => {
    const now = Date.now()
    const live = window.filter((sample) => now - sample.at <= RECENT_WINDOW_MS)
    if (live.length === 0) return [name, { calls: 0 }]
    const total = live.reduce((sum, sample) => sum + sample.ms, 0)
    return [name, {
      calls: live.length,
      avgMs: Math.round((total / live.length) * 10) / 10,
      maxMs: Math.round(Math.max(...live.map((sample) => sample.ms))),
    }]
  }))

  /**
   * Event-loop lag: if a call looks slow while this stays near zero, the time was
   * spent waiting (I/O, another service's queue), not computing.
   */
  const LAG_TICK_MS = 200
  let lagTimer
  {
    let last = Date.now()
    lagTimer = setInterval(() => {
      const now = Date.now()
      const lag = now - last - LAG_TICK_MS
      last = now
      if (lag > (state.counts.lagMaxMs ?? 0)) state.counts.lagMaxMs = lag
      state.counts.lagTicks = (state.counts.lagTicks ?? 0) + 1
    }, LAG_TICK_MS)
    if (typeof lagTimer.unref === 'function') lagTimer.unref()
  }

  /**
   * How long a merged listing is served without any check.
   *
   * A merge reads 823 session headers across 36 backends (~1.5-1.8 s in-host), which a
   * page load must not pay. Past this window the listing is validated instead: one
   * existence check per session directory (~20 ms) drops what another tool deleted,
   * and the scan that refreshes sizes and titles runs behind the caller.
   */
  const LIST_FRESH_MS = 30000
  /**
   * Past this age the cached listing is dropped and the next call scans up front.
   *
   * Generous on purpose: refreshes arrive minutes apart, and an unvalidated cache is
   * harmless because changes made here invalidate at once and deletions are caught by
   * the validation above. This only bounds how long a *renamed* session can keep a
   * stale title when the rename came from another process.
   */
  const LIST_STALE_MS = 1800000
  /** A single backend's snapshot list is trusted as long as the merged one. */
  const BACKEND_LIST_CACHE_MS = 1800000
  /** `stat()` answers a change token; 1.5 s of staleness is far cheaper than a rescan. */
  const STAT_CACHE_MS = 1500
  /** How long a failed lookup is remembered, so repeated misses stop re-scanning. */
  const MISS_TTL_MS = 5000
  /** How long a root's cheap directory-name index is trusted. */
  const ID_SET_TTL_MS = 30000
  let listCache
  let listPromise
  const dropMerged = () => {
    listCache = undefined
  }
  /**
   * Forget only one backend's listing.
   *
   * A session created or renamed touches exactly one root, and re-scanning that root
   * costs milliseconds; re-scanning all 36 costs 1.3 s. The merged cache is dropped so
   * the next call merges again — from 35 cached backend listings plus one fresh scan.
   * An unknown backend only drops the merged result: every creation in this process
   * goes through `create()`, which already invalidated the right one.
   */
  const invalidateBackend = (backend) => {
    dropMerged()
    if (backend !== undefined) state.backendLists.delete(backend)
    state.idSets.clear()
  }
  const invalidateStat = (id) => {
    if (id === undefined) state.statCache.clear()
    else state.statCache.delete(id)
  }

  service.create = async (header, options) => {
    await ready
    const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
    let backend
    if (cwd !== undefined) backend = await backendFor(cwd)
    invalidateStat(header.id)
    if (backend === undefined) {
      const handle = await original.create(header, options)
      remember(header.id, CENTRAL)
      invalidateBackend(CENTRAL)
      state.counts.central += 1
      return handle
    }
    try {
      const handle = await backend.create(header, options)
      remember(header.id, backend, core.projectSessionRoot(settings, cwd))
      invalidateBackend(backend)
      state.counts.created += 1
      return handle
    } catch (error) {
      state.counts.fallbacks += 1
      log.warn(`cannot create "${String(header.id)}" in its project directory (${describe(error)}); using the central root`)
      const handle = await original.create(header, options)
      remember(header.id, CENTRAL)
      invalidateBackend(CENTRAL)
      return handle
    }
  }

  service.open = async (id, access, options) => {
    const started = process.hrtime.bigint()
    try {
      const found = await locate(id)
      if (found === undefined) throw new seam.SessionPersistenceNotFoundError(id)
      try {
        return found === CENTRAL ? await original.open(id, access, options) : await found.open(id, access, options)
      } catch (error) {
        if (!(error instanceof seam.SessionPersistenceNotFoundError)) throw error
        // The cached/indexed location can be stale (a session migrated between
        // roots, or a hint written before a move): drop it and look again once.
        const retried = await relocate(id)
        if (retried === undefined) throw error
        return retried === CENTRAL ? original.open(id, access, options) : retried.open(id, access, options)
      }
    } finally {
      recordTiming('open', started)
    }
  }

  service.stat = async (id, options) => {
    const started = process.hrtime.bigint()
    try {
      const cached = state.statCache.get(id)
      if (cached !== undefined && Date.now() - cached.at < STAT_CACHE_MS) {
        state.counts.statCached += 1
        return cached.snapshot
      }
      const found = await locate(id)
      if (found === undefined) return undefined
      const snapshot = found === CENTRAL ? await original.stat(id, options) : await found.stat(id, options)
      if (snapshot !== undefined) {
        state.statCache.set(id, { at: Date.now(), snapshot })
        return snapshot
      }
      invalidateStat(id)
      const retried = await relocate(id)
      if (retried === undefined) return undefined
      return retried === CENTRAL ? original.stat(id, options) : retried.stat(id, options)
    } finally {
      recordTiming('stat', started)
    }
  }

  /**
   * Merge every backend's listing.
   *
   * The merge is the expensive operation (one scan of every backend), so a page load
   * must never wait for one it does not need:
   *
   * - within {@link LIST_FRESH_MS} the cached listing is returned as is;
   * - past that, the cached listing is still returned immediately and a refresh
   *   runs in the background, so the next request (usually milliseconds later) sees
   *   the update;
   * - an invalidation (created / disposed / renamed here) drops the cache, and only
   *   then does the next call scan up front — that is when the answer must be current.
   */
  service.list = async (options) => {
    await ready
    if (options?.signal?.aborted === true) throw new DOMException('This operation was aborted', 'AbortError')
    if (listCache !== undefined) {
      const age = Date.now() - listCache.at
      if (age < LIST_FRESH_MS) {
        state.counts.listCached += 1
        return listCache.value
      }
      if (age < LIST_STALE_MS) {
        // The listing is old enough to distrust, but a full scan is not needed to know
        // whether it is still *valid*: one existence check per session directory
        // (~20 ms for 823) drops whatever another tool deleted, and the scan that
        // refreshes sizes and titles runs behind the caller.
        state.counts.listValidated += 1
        const value = pruneVanished()
        if (listPromise === undefined) void refreshList().catch(() => {})
        return value
      }
    }
    return refreshList()
  }

  /** Drop cached snapshots whose session directory no longer exists. */
  function pruneVanished() {
    if (listCache === undefined) return []
    let dropped = 0
    const kept = []
    for (const snapshot of listCache.value) {
      const dir = listCache.dirs.get(snapshot.header.id)
      if (dir !== undefined && !fs.existsSync(dir)) {
        listCache.dirs.delete(snapshot.header.id)
        dropped += 1
        continue
      }
      kept.push(snapshot)
    }
    if (dropped > 0) {
      state.counts.validateDropped += dropped
      listCache = { ...listCache, value: kept }
      log.debug(`listing validation dropped ${dropped} session(s) removed outside this process`)
    }
    return kept
  }

  /** Scan every backend and store the merged result (single flight). */
  function refreshList() {
    if (listPromise !== undefined) return listPromise
    state.counts.listScans += 1
    const started = process.hrtime.bigint()
    listPromise = computeList()
      .then(({ snapshots, dirs }) => {
        listCache = { at: Date.now(), value: snapshots, dirs }
        return snapshots
      })
      .finally(() => {
        listPromise = undefined
        recordTiming('list', started)
      })
    return listPromise
  }

  /** One backend's listing, reused for {@link BACKEND_LIST_CACHE_MS}. */
  async function backendList(key, backend, label) {
    const cached = state.backendLists.get(key)
    if (cached !== undefined && Date.now() - cached.at < BACKEND_LIST_CACHE_MS) return cached.snapshots
    let snapshots
    try {
      snapshots = await backend.list()
    } catch (error) {
      state.counts.errors += 1
      log.warn(`cannot list ${label}: ${describe(error)}`)
      return []
    }
    state.backendLists.set(key, { at: Date.now(), snapshots })
    return snapshots
  }

  async function computeList() {
    const projects = [...state.mounted.values()]
    const [centralSnapshots, projectLists] = await Promise.all([
      backendList(CENTRAL, original, `the central root ${settings.root}`),
      Promise.all(projects.map((project) => backendList(project.backend, project.backend, project.root))),
    ])
    const snapshots = []
    const dirs = new Map()
    for (const snapshot of centralSnapshots) {
      snapshots.push(snapshot)
      remember(snapshot.header.id, CENTRAL)
      dirs.set(snapshot.header.id, core.sessionDirectory(settings.root, snapshot.header.cwd, snapshot.header.id))
    }
    projectLists.forEach((local, index) => {
      const project = projects[index]
      for (const snapshot of local) {
        snapshots.push(snapshot)
        remember(snapshot.header.id, project.backend, project.root)
        dirs.set(snapshot.header.id, core.sessionDirectory(project.root, snapshot.header.cwd, snapshot.header.id))
      }
    })
    return { snapshots, dirs }
  }

  service.flush = async () => {
    await ready
    const started = process.hrtime.bigint()
    try {
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
      // A flush only adds bytes to an existing session; the short `stat` cache
      // bounds that staleness, and clearing it here would defeat the cache — the
      // host flushes after every batch of appends.
    } finally {
      recordTiming('flush', started)
    }
  }

  /**
   * The backend an event payload refers to, when the payload carries the session id.
   * `undefined` means "unknown, invalidate broadly".
   */
  function backendOfPayload(payload) {
    const id = payload?.header?.id ?? payload?.id ?? payload?.sessionId
    return typeof id === 'string' ? state.byId.get(id) : undefined
  }

  // A created, disposed or renamed session changes the merged list right away; the
  // caches must not hide it. Only the owning backend is rescanned: 35 cached listings
  // stay usable, so the next merge costs one small scan instead of all 36.
  ctx.on('session/created', (payload) => {
    invalidateBackend(backendOfPayload(payload))
    invalidateStat()
  })
  ctx.on('session/disposed', (payload) => {
    invalidateBackend(backendOfPayload(payload))
    invalidateStat()
  })
  ctx.on('session/title', (payload) => {
    invalidateBackend(backendOfPayload(payload))
  })

  const reportTimer = setInterval(() => {
    if (timings.size > 0) writeReport()
  }, 10_000)
  if (typeof reportTimer.unref === 'function') reportTimer.unref()

  // Drop index entries whose session directory is gone once startup has settled;
  // a stale hint would make every lookup fall through to the slow scan.
  const pruneTimer = setTimeout(() => {
    try {
      const removed = core.pruneIndex(settings, state.index)
      if (removed.length > 0) {
        state.indexDirty = true
        flushIndex()
        log.debug(`index pruned: ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} dropped`)
      }
    } catch (error) {
      log.warn(`cannot prune the session index: ${describe(error)}`)
    }
  }, 5000)
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref()

  ctx.effect(() => () => {
    clearInterval(reportTimer)
    clearInterval(lagTimer)
    clearTimeout(pruneTimer)
    if (state.indexTimer !== undefined) {
      clearTimeout(state.indexTimer)
      state.indexTimer = undefined
    }
    flushIndex()
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

  // Warm the lookup index in the background: the first page load asks `stat` for
  // many sessions before it lists, and a warm index turns each of those into a
  // map hit instead of a scan across every project backend.
  void ready
    .then(() => service.list())
    .then((snapshots) => {
      flushIndex()
      log.debug(`session index ready: ${snapshots.length} sessions`)
    })
    .catch((error) => log.warn(`cannot warm the session index: ${describe(error)}`))

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
      forgetMountedBackend(root)
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

  /**
   * Resolve the backend that owns a session id.
   *
   * The persisted index answers the common case with a map hit. Only a genuinely
   * unknown id scans, and then only once per burst: concurrent lookups of the same
   * id share one scan, and a failed lookup is remembered briefly so a client that
   * keeps asking for a gone session does not re-scan every backend each time.
   */
  async function locate(id) {
    await ready
    const cached = state.byId.get(id)
    if (cached !== undefined) return cached
    const hinted = state.index.get(id)
    if (hinted !== undefined) {
      const backend = hinted === core.CENTRAL_MARKER ? CENTRAL : mountedForRoot(hinted)
      if (backend !== undefined) {
        state.byId.set(id, backend)
        return backend
      }
    }
    const missedAt = state.misses.get(id)
    if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return undefined
    const inFlight = state.locating.get(id)
    if (inFlight !== undefined) return inFlight
    const work = scanFor(id)
    state.locating.set(id, work)
    try {
      const found = await work
      if (found === undefined) state.misses.set(id, Date.now())
      return found
    } finally {
      state.locating.delete(id)
    }
  }

  /**
   * The lookup of last resort, kept cheap on purpose.
   *
   * Asking every backend (`backend.stat`) makes each backend read its directories
   * *and* every session header — 823 header decodes for one unknown id, which is how
   * a handful of ghost ids used to stall a whole page load. Directory names answer
   * "does this root own that id?" on their own, so only the owning backend is asked
   * for a real snapshot.
   */
  async function scanFor(id) {
    state.counts.missScans += 1
    const encoded = core.encodeSegment(id)
    const projects = [...state.mounted.values()]
    const owners = await Promise.all(projects.map(async (project) => {
      const ids = await idSetFor(project.root)
      return ids.has(encoded) ? project : undefined
    }))
    for (const project of owners) {
      if (project === undefined) continue
      try {
        if (await project.backend.stat(id) !== undefined) {
          remember(id, project.backend, project.root)
          return project.backend
        }
      } catch (error) {
        log.warn(`cannot stat "${String(id)}" in ${project.root}: ${describe(error)}`)
      }
    }
    if ((await idSetFor(settings.root)).has(encoded) && await original.stat(id) !== undefined) {
      remember(id, CENTRAL)
      return CENTRAL
    }
    return undefined
  }

  /** Session directory names of one root, cached for {@link ID_SET_TTL_MS}. */
  function idSetFor(root) {
    const cached = state.idSets.get(root)
    if (cached !== undefined && Date.now() - cached.at < ID_SET_TTL_MS) return cached.promise
    state.counts.idSetBuilds += 1
    const promise = core.sessionIdSet(root).catch((error) => {
      log.warn(`cannot read the session directory names of ${root}: ${describe(error)}`)
      return new Set()
    })
    state.idSets.set(root, { at: Date.now(), promise })
    return promise
  }

  function mountedForRoot(root) {
    for (const project of state.mounted.values()) {
      if (core.samePath(project.root, root)) return project.backend
    }
    return undefined
  }

  /** Cache a lookup result and record it in the persisted index. */
  function remember(id, backend, root) {
    state.byId.set(id, backend)
    state.misses.delete(id)
    const marker = backend === CENTRAL ? core.CENTRAL_MARKER : root
    if (marker === undefined) return
    if (state.index.get(id) === marker) return
    state.index.set(id, marker)
    state.indexDirty = true
    scheduleIndexWrite()
  }

  /** Drop a cached location and look the session up from scratch, once. */
  async function relocate(id) {
    state.byId.delete(id)
    state.misses.delete(id)
    if (state.index.delete(id)) {
      state.indexDirty = true
      scheduleIndexWrite()
    }
    return scanFor(id)
  }

  function scheduleIndexWrite() {
    if (settings.indexPath === '' || state.indexTimer !== undefined) return
    state.indexTimer = setTimeout(() => {
      state.indexTimer = undefined
      flushIndex()
    }, 2000)
    if (typeof state.indexTimer.unref === 'function') state.indexTimer.unref()
  }

  function flushIndex() {
    if (!state.indexDirty) return
    core.writeIndex(settings, state.index)
    state.indexDirty = false
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
        timings: Object.fromEntries([...timings].map(([name, entry]) => [name, {
          calls: entry.calls,
          totalMs: Math.round(entry.ms),
          avgMs: Math.round((entry.ms / entry.calls) * 10) / 10,
        }])),
        recentTimings: recentSummary(),
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
