import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NOTIFY_URL,
  createNotifier,
  notifyConfig,
  turnNotification,
  turnRecorder,
} from '../bridge/notify.mjs'

const TOKEN = 'a'.repeat(64)

/** A fetch that records each call and answers with `respond`. */
function fakeFetch(respond = async () => ({ status: 201 })) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return respond(url, init)
  }
  fn.calls = calls
  return fn
}

function quietLog() {
  const lines = []
  return { lines, error: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')) }
}

/**
 * The bridge's end-of-turn path, as server.mjs runs it: record the stream,
 * build the notification, send it without waiting.
 */
function runTurn({ allowWrites = true, tools = [], outcome, reply = '', fetch, env, log = quietLog() }) {
  const config = notifyConfig(env ?? { JARVIS_NOTIFY_TOKEN: TOKEN }, log)
  const notify = createNotifier(config, { fetch, log, timeoutMs: 50 })
  const rec = turnRecorder({ allowWrites })
  for (const [i, t] of tools.entries()) {
    const id = `toolu_${i}`
    rec.seen(id, t.name)
    if (t.denied) rec.denied(id)
    rec.settled(id, t.output ?? 'ok')
  }
  const note = notify && turnNotification({ outcome, ...rec.finish(), reply, secrets: [TOKEN] })
  const pending = note ? notify(note) : Promise.resolve()
  return { note, pending, log }
}

test('a write turn that succeeded sends one ok notification', async () => {
  const fetch = fakeFetch()
  const { pending } = runTurn({
    fetch,
    outcome: 'ok',
    tools: [
      { name: 'Read', output: 'secret file contents' },
      { name: 'Bash', output: 'https://github.com/squalliram/jarvis/pull/7\n' },
      { name: 'Write' },
      { name: 'Bash' },
    ],
    reply: 'Done, sir. The pull request is open.',
  })
  await pending
  assert.equal(fetch.calls.length, 1)
  const { url, init, body } = fetch.calls[0]
  assert.equal(url, DEFAULT_NOTIFY_URL)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`)
  assert.deepEqual(Object.keys(body).sort(), ['link', 'outcome', 'source', 'title'])
  assert.equal(body.source, 'jarvis')
  assert.equal(body.outcome, 'ok')
  assert.equal(body.title, 'JARVIS ran Bash, Write: Done, sir. The pull request is open.')
  assert.equal(body.link, 'https://github.com/squalliram/jarvis/pull/7')
  assert.doesNotMatch(body.title, /secret file contents/)
})

test('a write turn that failed sends a failed notification naming the writes', async () => {
  const fetch = fakeFetch()
  const { pending } = runTurn({
    fetch,
    outcome: 'failed',
    tools: [{ name: 'mcp__github__create_pull_request', output: 'no link here' }],
    reply: 'The turn failed part way through.',
  })
  await pending
  assert.equal(fetch.calls.length, 1)
  const { body } = fetch.calls[0]
  assert.equal(body.outcome, 'failed')
  assert.equal(
    body.title,
    'JARVIS turn failed after running github create_pull_request: The turn failed part way through.',
  )
  assert.equal('link' in body, false)
})

test('a read-only turn that failed still sends a failed notification', async () => {
  const fetch = fakeFetch()
  const { pending } = runTurn({
    fetch,
    allowWrites: false,
    outcome: 'failed',
    tools: [{ name: 'Read' }, { name: 'Bash', denied: true }],
    reply: 'The turn ran too long and was stopped.',
  })
  await pending
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].body.outcome, 'failed')
  assert.equal(fetch.calls[0].body.title, 'JARVIS turn failed: The turn ran too long and was stopped.')
})

test('a cancelled turn sends nothing, even after a write', async () => {
  const fetch = fakeFetch()
  const { note, pending } = runTurn({ fetch, outcome: 'cancelled', tools: [{ name: 'Write' }] })
  await pending
  assert.equal(note, null)
  assert.equal(fetch.calls.length, 0)
})

test('a read-only turn that succeeded sends nothing', async () => {
  const fetch = fakeFetch()
  const { pending } = runTurn({
    fetch,
    outcome: 'ok',
    tools: [{ name: 'Read' }, { name: 'WebSearch' }, { name: 'mcp__jarvis__display' }],
    reply: 'It is sunny.',
  })
  await pending
  assert.equal(fetch.calls.length, 0)
})

test('a write the policy refused does not count as a write', async () => {
  const fetch = fakeFetch()
  const { pending } = runTurn({
    fetch,
    allowWrites: true,
    outcome: 'ok',
    tools: [{ name: 'Write', denied: true }],
    reply: 'I could not write that file.',
  })
  await pending
  assert.equal(fetch.calls.length, 0)
  // And in read-only mode a write is never allowed to begin with.
  const fetch2 = fakeFetch()
  await runTurn({ fetch: fetch2, allowWrites: false, outcome: 'ok', tools: [{ name: 'Bash' }] }).pending
  assert.equal(fetch2.calls.length, 0)
})

test('disabled without a token, and on a non-https URL', async () => {
  assert.equal(notifyConfig({}, quietLog()), null)
  assert.equal(notifyConfig({ JARVIS_NOTIFY_TOKEN: '  ' }, quietLog()), null)
  assert.equal(createNotifier(null), null)
  const fetch = fakeFetch()
  const { note } = runTurn({ fetch, env: {}, outcome: 'failed', tools: [{ name: 'Write' }] })
  assert.equal(note, null)
  assert.equal(fetch.calls.length, 0)

  const log = quietLog()
  assert.equal(notifyConfig({ JARVIS_NOTIFY_TOKEN: TOKEN, JARVIS_NOTIFY_URL: 'http://example.com/n' }, log), null)
  assert.equal(notifyConfig({ JARVIS_NOTIFY_TOKEN: TOKEN, JARVIS_NOTIFY_URL: 'not a url' }, log), null)
  assert.equal(log.lines.join('\n').includes(TOKEN), false)
  assert.equal(
    notifyConfig({ JARVIS_NOTIFY_TOKEN: TOKEN, JARVIS_NOTIFY_URL: 'http://localhost:5000/n' }).url,
    'http://localhost:5000/n',
  )
  assert.equal(
    notifyConfig({ JARVIS_NOTIFY_TOKEN: TOKEN, JARVIS_NOTIFY_URL: 'https://cc.example/n' }).url,
    'https://cc.example/n',
  )
})

test('a timeout is swallowed, logged without the token or body, and does not block', async () => {
  const fetch = fakeFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      }),
  )
  const started = Date.now()
  const { pending, log } = runTurn({
    fetch,
    outcome: 'ok',
    tools: [{ name: 'Write' }],
    reply: 'Saved the note about the launch.',
  })
  // The caller gets control back straight away; the request runs behind it.
  assert.ok(Date.now() - started < 40)
  await assert.doesNotReject(pending)
  assert.equal(fetch.calls.length, 1)
  const logged = log.lines.join('\n')
  assert.match(logged, /timed out/)
  assert.equal(logged.includes(TOKEN), false)
  assert.equal(logged.includes('launch'), false)
})

test('network errors and refusals are swallowed and never retried', async () => {
  const fetch = fakeFetch(async () => {
    throw new TypeError(`fetch failed for Bearer ${TOKEN}`)
  })
  const { pending, log } = runTurn({ fetch, outcome: 'failed', reply: 'The turn ended without an answer.' })
  await assert.doesNotReject(pending)
  assert.equal(fetch.calls.length, 1)
  assert.match(log.lines.join('\n'), /not sent: TypeError/)
  assert.equal(log.lines.join('\n').includes(TOKEN), false)

  const refused = fakeFetch(async () => ({ status: 429 }))
  const r = runTurn({ fetch: refused, outcome: 'failed' })
  await r.pending
  assert.equal(refused.calls.length, 1)
  assert.match(r.log.lines.join('\n'), /HTTP 429/)
})

test('the title is plain, short, and carries no credentials', () => {
  const note = turnNotification({
    outcome: 'ok',
    writes: ['Bash'],
    reply: `Done.  Your key is sk-abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQRST and ${TOKEN}. ` + 'x '.repeat(200),
    secrets: [TOKEN],
  })
  assert.ok(note.title.length <= 200)
  assert.doesNotMatch(note.title, /sk-abc|ghp_|aaaaaaaa|\s{2}/)
  assert.match(note.title, /^JARVIS ran Bash: Done\. Your key is \[redacted\]/)
})

test('a link is added only when it clearly belongs to the action', () => {
  const base = { outcome: 'ok', writes: ['Bash'] }
  assert.equal(turnNotification({ ...base, links: [] }).link, undefined)
  assert.equal(
    turnNotification({ ...base, links: ['https://a.example/1', 'https://b.example/2'], reply: 'Opened.' }).link,
    undefined,
  )
  assert.equal(
    turnNotification({
      ...base,
      links: ['https://a.example/1', 'https://b.example/2'],
      reply: 'Opened https://b.example/2 for you.',
    }).link,
    'https://b.example/2',
  )
  // URLs with a query string, credentials or plain http are never used.
  const rec = turnRecorder({ allowWrites: true })
  rec.seen('t1', 'Bash')
  rec.settled('t1', [
    { type: 'text', text: 'see https://x.example/a?token=abc and http://y.example/b and https://u:p@z.example/c' },
  ])
  assert.deepEqual(rec.finish().links, [])
})
