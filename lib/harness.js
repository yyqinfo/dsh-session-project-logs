/**
 * Loading the harness's own persistence packages from inside a profile-installed
 * bundle.
 *
 * A bundle linked into the profile cannot resolve `@deepseek-ai/*` from its own
 * directory, so the modules are resolved against the running CLI (`process.argv[1]`
 * lives inside the installed `@deepseek-ai/dsh` package) and imported by absolute
 * URL. Importing the same URL the Loader used returns the *same* module instance,
 * which matters twice over: the error classes must stay `instanceof`-compatible
 * for consumers, and a mounted backend must extend the very `SessionPersistence`
 * the host already published.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const JSONL_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
const SEAM_PACKAGE = '@deepseek-ai/dsh-session-persistence'

/**
 * Resolve the two persistence packages as file URLs.
 * @returns `{ jsonlUrl, seamUrl, anchoredAt }`, or `undefined` when the running
 *   harness layout cannot be located.
 */
export function resolveHarnessModuleUrls() {
  const configured = (process.env.DSH_HARNESS_ANCHOR ?? '').trim()
  const gnuGlobal = process.env.APPDATA === undefined
    ? undefined
    : `${process.env.APPDATA}/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`
  const posixGlobal = `${path.dirname(process.execPath)}/../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`
  const anchors = [
    configured.length > 0 ? configured : undefined,
    process.argv[1],
    process.argv[0],
    gnuGlobal,
    posixGlobal,
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      return {
        jsonlUrl: pathToFileURL(require.resolve(JSONL_PACKAGE)).href,
        seamUrl: pathToFileURL(require.resolve(SEAM_PACKAGE)).href,
        anchoredAt: anchor,
      }
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}

/** Import the harness persistence modules by absolute URL. */
export async function loadHarnessModules(urls) {
  const jsonl = await import(urls.jsonlUrl)
  const seam = await import(urls.seamUrl)
  return { jsonl, seam }
}

/**
 * The base class behind a live persistence provider.
 * @param service - the mounted `sessionPersistence` instance.
 * @returns its `SessionPersistence` superclass constructor, or `undefined`.
 */
export function providerBaseClass(service) {
  try {
    return Object.getPrototypeOf(Object.getPrototypeOf(service)).constructor
  } catch {
    return undefined
  }
}

/**
 * Mount one more JSONL backend on its own isolated `sessionPersistence` scope.
 *
 * The shipped backend owns exactly one root, so each project gets its own
 * instance; the plugin routes sessions between them. The backend's live-event
 * router ignores ids it does not own, so several instances coexist safely.
 *
 * @param ctx - the plugin's context; the mounted fiber is disposed with it.
 * @param jsonl - the imported JSONL backend package.
 * @param root - that backend's session root (one per project).
 * @returns the mounted backend service and its fiber.
 */
export async function mountBackend(ctx, jsonl, root) {
  const scoped = ctx.isolate('sessionPersistence')
  const fiber = scoped.plugin({
    name: `session-project-logs:${root}`,
    apply: (inner) => jsonl.apply(inner, { root }),
  })
  await fiber.await()
  const backend = scoped.get('sessionPersistence')
  if (backend === undefined) throw new Error(`no sessionPersistence service after mounting ${root}`)
  return { backend, fiber, scoped }
}
