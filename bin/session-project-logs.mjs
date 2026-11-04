#!/usr/bin/env node
/**
 * Command-line companion for the session-project-logs plugin.
 *
 * The plugin routes *new* sessions into their project while it runs. Moving the
 * sessions that were stored before it was installed is an offline operation,
 * because a live write handle keeps writing to the root it was opened on —
 * `migrate` therefore expects the harness to be stopped.
 *
 *   session-project-logs status  [--json]
 *   session-project-logs migrate [<projectDir> ...] [--dry-run] [--json]
 *   session-project-logs restore [<projectDir> ...] [--dry-run] [--json]
 *   session-project-logs doctor  [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  discoverCentralProjects,
  dshHome,
  inspectProject,
  migrateProject,
  normalizeConfig,
  readRegistry,
  resolveSessionsRoot,
  restoreProject,
  writeRegistry,
} from '../lib/core.js'
import { resolveHarnessModuleUrls } from '../lib/harness.js'

const argv = process.argv.slice(2)
const help = `session-project-logs — keep each project's DSH session logs inside the project

Usage:
  session-project-logs status  [--root <dir>] [--json]
  session-project-logs migrate (--all | <projectDir> ...) [--root <dir>] [--dry-run] [--force] [--json]
  session-project-logs restore (--all | <projectDir> ...) [--root <dir>] [--dry-run] [--json]
  session-project-logs doctor  [--json]
  session-project-logs help

Options:
  --root <dir>   Central session root (default: $DSH_HOME/sessions)
  --dir <name>   Project-relative log directory (default: .dsh/sessions)
  --state <file> Registry file written by the plugin
  --all          Act on every project recovered from the central root's headers
                 (default for migrate/restore is the plugin's project registry)
  --dry-run      Report what would move without touching anything
  --force        Move sessions even if their log changed in the last minutes
  --quiet <min>  Activity window for the "looks live" guard (default 10)
  --json         Machine-readable output

migrate and restore move session directories: stop DSH first.
`

function takeOption(name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  argv.splice(index, 2)
  return value
}

function takeFlag(name) {
  const index = argv.indexOf(name)
  if (index === -1) return false
  argv.splice(index, 1)
  return true
}

const root = takeOption('--root')
const dirName = takeOption('--dir')
const statePath = takeOption('--state')
const quietOption = takeOption('--quiet')
const all = takeFlag('--all')
const dryRun = takeFlag('--dry-run')
const force = takeFlag('--force')
const json = takeFlag('--json')
if (takeFlag('--help') || takeFlag('-h')) {
  console.log(help)
  process.exit(0)
}

const quietMinutes = Number(quietOption)
const command = argv.shift() ?? 'help'
const settings = normalizeConfig({ root, dirName, statePath, dryRun })
const registry = readRegistry(settings)
const targeted = argv.filter((value) => !value.startsWith('--'))

function usage(message) {
  console.error(message)
  console.error(help)
  process.exit(2)
}

function projectsToAct() {
  if (targeted.length > 0) return targeted.map((value) => path.resolve(value))
  if (all) return discoverCentralProjects(settings).map((entry) => path.resolve(entry.project))
  return registry.projects.map((value) => path.resolve(value))
}

if (command === 'help') {
  console.log(help)
  process.exit(0)
}

if (command === 'status') {
  const rows = registry.projects.map((project) => inspectProject(settings, project))
  const centralUnknown = countCentralEntries(settings.root, rows)
  if (json) {
    console.log(JSON.stringify({ root: settings.root, dirName: settings.dirName, registry: settings.statePath, projects: rows, centralUnknown }, null, 2))
    process.exit(0)
  }
  console.log(`central root      : ${settings.root}`)
  console.log(`project directory : <project>/${settings.dirName}`)
  console.log(`registry          : ${settings.statePath || '(disabled)'} (${registry.projects.length} project(s))`)
  console.log('')
  let centralTotal = 0
  let localTotal = 0
  for (const row of rows) {
    centralTotal += row.central.sessions
    localTotal += row.local.sessions
    const parts = [`central ${String(row.central.sessions).padStart(3)}`, `project ${String(row.local.sessions).padStart(3)}`]
    console.log(`  ${row.project}  ${parts.join('  ')}${row.skipped ? `  (not routed: ${row.skipped})` : ''}`)
  }
  console.log('')
  console.log(`sessions centrally stored for known projects: ${centralTotal}`)
  console.log(`sessions stored inside projects             : ${localTotal}`)
  console.log(`unmatched project directories in the root    : ${centralUnknown.length}`)
  if (centralTotal > 0) console.log('\nrun "session-project-logs migrate --dry-run" to preview moving them (stop DSH first)')
  process.exit(0)
}

if (command === 'migrate' || command === 'restore') {
  const projects = projectsToAct()
  if (projects.length === 0) usage('nothing to do: pass --all, name project directories, or register them by running the plugin once')
  const results = []
  for (const project of projects) {
    const result = command === 'migrate'
      ? migrateProject(settings, project, { dryRun, force, quietMinutes })
      : restoreProject(settings, project, { dryRun })
    results.push({ project, ...result })
  }
  if (json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const result of results) {
      const counts = `moved ${result.moved}${result.failed ? `, failed ${result.failed}` : ''}`
      console.log(`${String(result.status).padEnd(20)} ${result.project}  ${result.moved || result.failed ? counts : ''}${result.reason ? ` — ${result.reason}` : ''}`)
      for (const failure of result.failures ?? []) console.log(`    ! ${failure.name}: ${failure.reason}`)
      for (const skipped of result.skipped ?? []) {
        console.log(`    ~ ${skipped.name}: written ${skipped.minutesAgo} min ago, looks live — left in place`)
      }
    }
    const moved = results.reduce((sum, result) => sum + (result.moved ?? 0), 0)
    const failed = results.reduce((sum, result) => sum + (result.failed ?? 0), 0)
    const skipped = results.reduce((sum, result) => sum + (result.skipped?.length ?? 0), 0)
    console.log(`\n${dryRun ? 'would move' : 'moved'} ${moved} session director${moved === 1 ? 'y' : 'ies'}${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped as active` : ''}`)
    if (skipped > 0) console.log('stop DSH and run again (or pass --force; a live session cannot write after its directory moves)')
  }
  // The registry is what makes a project's local sessions visible after a
  // restart: record every project that now keeps sessions inside itself, and drop
  // the ones that no longer do. A failure here must not hide the move results.
  if (!dryRun) {
    try {
      syncRegistry(projects)
    } catch (error) {
      console.error(`warning: could not update the project registry: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  process.exit(results.some((result) => result.status === 'error' || (result.failed ?? 0) > 0) ? 1 : 0)
}

/** Keep the plugin's project registry in step with what lives inside projects. */
function syncRegistry(candidates) {
  const all = new Set([...registry.projects.map((value) => path.resolve(value)), ...candidates.map((value) => path.resolve(value))])
  const keep = []
  for (const project of all) {
    if (inspectProject(settings, project).local.sessions > 0) keep.push(project)
  }
  writeRegistry(settings, keep)
  console.log(`registry: ${keep.length} project(s) keep their sessions locally (${settings.statePath})`)
}

if (command === 'doctor') {
  const urls = resolveHarnessModuleUrls()
  const report = {
    dshHome: dshHome(),
    centralRoot: settings.root,
    resolvedRootFromEnv: resolveSessionsRoot(''),
    dirName: settings.dirName,
    statePath: settings.statePath,
    registryProjects: registry.projects.length,
    persistencePackages: urls === undefined
      ? { resolved: false, hint: 'run this from inside the DSH installation, or set DSH_HARNESS_ANCHOR to .../@deepseek-ai/dsh/lib/bin.js' }
      : { resolved: true, anchoredAt: urls.anchoredAt, jsonl: urls.jsonlUrl, seam: urls.seamUrl },
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(urls === undefined ? 1 : 0)
}

usage(`unknown command: ${command}`)

/** Project directories under the root that the registry does not know about. */
function countCentralEntries(centralRoot, rows) {
  const known = new Set(rows.map((row) => path.basename(row.central.dir)))
  let names = []
  try {
    names = fs.readdirSync(centralRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  return names.filter((name) => !known.has(name))
}
