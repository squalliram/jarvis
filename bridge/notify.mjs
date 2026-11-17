/**
 * Reporting JARVIS's actions to the owner's Command Centre Inbox.
 *
 * One notification per turn, and only for the turns worth hearing about
 * afterwards: ones that ran a tool the policy counts as a write, and ones that
 * failed. A turn that only looked at things says nothing; a turn the user
 * cancelled says nothing either.
 *
 * The request is fire-and-forget. It has a short timeout, no retries, and
 * nothing waits on it, so a slow or broken Command Centre can never delay a
 * spoken answer. The title is built from tool *names* and the final reply
 * only — never a tool's input or output — and anything shaped like a
 * credential is cut out of it before it leaves.
 */

import { decideTool } from './policy.mjs'

export const DEFAULT_NOTIFY_URL = 'https://iramkhan.com/command-centre/api/v1/notifications'
export const NOTIFY_TIMEOUT_MS = 5_000
const TITLE_MAX = 200
const LINK_MAX = 500
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Where to send, or null when notifications are off.
 *
 * Off unless JARVIS_NOTIFY_TOKEN is set. JARVIS_NOTIFY_URL must be https, so
 * the bearer token never crosses the network in the clear; plain http is
 * accepted only for a loopback address, for testing a local server.
 */
export function notifyConfig(env = process.env, log = console) {
  const token = env.JARVIS_NOTIFY_TOKEN?.trim()
  if (!token) return null
  const raw = env.JARVIS_NOTIFY_URL?.trim() || DEFAULT_NOTIFY_URL
  let url
  try {
    url = new URL(raw)
  } catch {
    log.error('[jarvis] notifications off: JARVIS_NOTIFY_URL is not a URL')
    return null
  }
  const ok =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  if (!ok || url.username || url.password) {
    log.error('[jarvis] notifications off: JARVIS_NOTIFY_URL must be https (or http on localhost)')
    return null
  }
  return { url: url.href, token }
}

/**
 * A sender bound to one config. Returns a function that posts a payload and
 * resolves once the attempt is over, successful or not — it never rejects.
 * Errors are logged by status or error name alone: no token, no body.
 */
export function createNotifier(config, { fetch: doFetch = globalThis.fetch, log = console, timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  if (!config) return null
  return async (payload) => {
    try {
      const res = await doFetch(config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
      if (res.status !== 201) log.error(`[jarvis] notification refused: HTTP ${res.status}`)
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.name || 'error'
      log.error(`[jarvis] notification not sent: ${reason}`)
    }
  }
}

/** A tool is a write when the policy withholds it from read-only mode. */
export const isWriteTool = (name) => typeof name === 'string' && !decideTool(name, false)

/** `mcp__github__create_pull_request` reads as `github create_pull_request`. */
export function toolLabel(name) {
  if (!name.startsWith('mcp__')) return name
  const [, server, ...tool] = name.split('__')
  return `${server} ${tool.join('__')}`
}

/**
 * Strings that look like credentials: well-known key prefixes, bearer
 * headers, and any long unbroken run of key-like characters.
 */
const SECRETISH = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+\S+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
  /[A-Za-z0-9_\-+=]{32,}/g,
]

export function redact(text, extra = []) {
  let out = String(text ?? '')
  for (const secret of extra) if (secret) out = out.split(secret).join('[redacted]')
  for (const re of SECRETISH) out = out.replace(re, '[redacted]')
  return out
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

function clip(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

const URL_RE = /https:\/\/[^\s<>"'`)\]}]+/g

/**
 * An https URL fit to be the notification's link: short enough, no
 * credentials and no query string (which is where tokens tend to ride).
 */
function linkable(candidate) {
  const trimmed = candidate.replace(/[.,;:!?]+$/, '')
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search) return null
  if (LOOPBACK.has(url.hostname)) return null
  url.hash = ''
  return url.href.length <= LINK_MAX ? url.href : null
}

/** The text of a tool_result block, which arrives as a string or as parts. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

/**
 * What one turn did, gathered from the stream as it goes by.
 *
 * `seen` records each tool_use the turn asked for, `denied` the ones the
 * policy hook or canUseTool refused, and `settled` the tool_result that came
 * back. A write counts only when the policy allowed it and it was not refused,
 * so it actually ran — a Bash that exits non-zero still ran. The only thing
 * kept from a write's output is the https URLs in it, as link candidates.
 */
export function turnRecorder({ allowWrites = false } = {}) {
  let pending = new Map()
  let denied = new Set()
  let writes = []
  let links = []

  return {
    seen(id, name) {
      if (!id || pending.has(id)) return
      if (isWriteTool(name) && decideTool(name, allowWrites)) pending.set(id, name)
    },
    denied(id) {
      if (id) denied.add(id)
    },
    settled(id, content) {
      const name = pending.get(id)
      if (name === undefined) return
      pending.delete(id)
      if (denied.has(id)) return
      if (!writes.includes(name)) writes.push(name)
      for (const match of resultText(content).match(URL_RE) ?? []) {
        const link = linkable(match)
        if (link && !links.includes(link)) links.push(link)
      }
    },
    /** The turn's summary, and a clean slate for the next one. */
    finish() {
      const summary = { writes, links }
      pending = new Map()
      denied = new Set()
      writes = []
      links = []
      return summary
    },
  }
}

/**
 * The notification body for a finished turn, or null when it has nothing to
 * report.
 *
 * `outcome` is 'ok', 'failed' or 'cancelled', as the bridge already decides
 * it. `reply` is JARVIS's final answer on success, or the bridge's plain
 * description of the failure otherwise.
 */
export function turnNotification({ outcome, writes = [], links = [], reply = '', secrets = [] }) {
  if (outcome === 'cancelled') return null
  if (outcome !== 'ok' && outcome !== 'failed') return null
  if (outcome === 'ok' && writes.length === 0) return null

  const names = writes.map(toolLabel)
  const ran =
    names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
  const head =
    outcome === 'ok'
      ? `JARVIS ran ${ran}`
      : ran
        ? `JARVIS turn failed after running ${ran}`
        : 'JARVIS turn failed'
  const excerpt = squash(redact(reply, secrets))
  const title = clip(squash(excerpt ? `${head}: ${excerpt}` : head), TITLE_MAX)

  const body = { source: 'jarvis', outcome, title }
  // A link only when it plainly belongs to the action: the one URL a write
  // produced, or the one of several that the final reply points at.
  let link = links.length === 1 ? links[0] : null
  if (!link && links.length > 1) {
    const mentioned = links.filter((l) => reply.includes(l))
    if (mentioned.length === 1) link = mentioned[0]
  }
  // A path can carry a credential too (a signed or share URL); such a link is
  // dropped rather than trimmed, since a trimmed one would not work anyway.
  if (link && redact(link, secrets) === link) body.link = link
  return body
}
