import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globToRegExp, readFacts, shouldGate, raceGate, apply } from '../lib/index.js'

// ---------------------------------------------------------------- helpers --

const DEFAULT = { origins: ['subagent', 'scheduled'], sessions: [] }

function refs(overrides = {}) {
  const values = {
    origins: ['subagent', 'scheduled'],
    sessions: [],
    windowSeconds: 60,
    defaultOutcome: 'rejected',
    ...overrides,
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }]))
}

function fakeSession({ origin, messages = [] } = {}) {
  return {
    ...(origin !== undefined ? { header: { origin } } : {}),
    deriveMessages: () => messages,
  }
}

const userMsg = (kind) => ({ role: 'user', source: { kind } })
const assistantMsg = () => ({ role: 'assistant', source: { kind: 'model' } })

function fakeCtx() {
  const listeners = []
  const disposers = []
  return {
    listeners,
    disposers,
    on(name, listener, options) {
      listeners.push({ name, listener, options })
      return () => true
    },
    effect(disposer) {
      disposers.push(disposer)
    },
  }
}

// -------------------------------------------------------------------- glob --

test('globToRegExp: * matches across the id, everything else is literal', () => {
  assert.equal(globToRegExp('sess-123').test('sess-123'), true)
  assert.equal(globToRegExp('sess-123').test('sess-124'), false)
  assert.equal(globToRegExp('sess-*').test('sess-abc-def'), true)
  assert.equal(globToRegExp('*-def').test('sess-abc-def'), true)
  assert.equal(globToRegExp('*').test('anything at all'), true)
  // regex specials must not leak into the pattern (dots, plus, brackets)
  assert.equal(globToRegExp('a.b').test('a.b'), true)
  assert.equal(globToRegExp('a.b').test('axb'), false)
  assert.equal(globToRegExp('a+b').test('a+b'), true)
  assert.equal(globToRegExp('a+b').test('aab'), false)
})

// ---------------------------------------------------------------- readFacts --

test('readFacts: header origin + LAST user message kind (backward scan)', () => {
  const session = fakeSession({
    origin: 'subagent',
    messages: [userMsg('cron'), assistantMsg(), userMsg('user')],
  })
  const facts = readFacts({ id: 's1', session })
  assert.equal(facts.headerOrigin, 'subagent')
  assert.equal(facts.lastUserMessageKind, 'user') // human steer after cron fire wins
})

test('readFacts: machine-kind last message, no session, partial session', () => {
  assert.equal(
    readFacts({ id: 's1', session: fakeSession({ messages: [assistantMsg(), userMsg('schedule')] }) }).lastUserMessageKind,
    'schedule',
  )
  assert.deepEqual(readFacts({ id: 's1' }), {})
  assert.deepEqual(readFacts(undefined), {})
  const facts = readFacts({ id: 's1', session: { header: { origin: 'subagent' } } })
  assert.equal(facts.headerOrigin, 'subagent')
  assert.equal(facts.lastUserMessageKind, undefined)
})

// --------------------------------------------------------------- shouldGate --

test('default origins gate subagent sessions and scheduled turns, nothing else', () => {
  assert.equal(shouldGate(DEFAULT, 's1', { headerOrigin: 'subagent' }), true)
  assert.equal(shouldGate(DEFAULT, 's1', { lastUserMessageKind: 'schedule' }), true)
  assert.equal(shouldGate(DEFAULT, 's1', { lastUserMessageKind: 'cron' }), false) // cron not in default
  assert.equal(shouldGate(DEFAULT, 's1', { lastUserMessageKind: 'user' }), false)
  assert.equal(shouldGate(DEFAULT, 's1', {}), false)
})

test('origins opt-ins: cron and all', () => {
  assert.equal(shouldGate({ ...DEFAULT, origins: ['cron'] }, 's1', { lastUserMessageKind: 'cron' }), true)
  assert.equal(shouldGate({ ...DEFAULT, origins: ['all'] }, 's1', {}), true)
  assert.equal(shouldGate({ ...DEFAULT, origins: ['all'] }, 's1', { lastUserMessageKind: 'user' }), true)
})

test('sessions list: glob hit gates every turn even for humans; miss does not', () => {
  const cfg = { origins: ['subagent'], sessions: ['sched-*'] }
  assert.equal(shouldGate(cfg, 'sched-tasks-9', { lastUserMessageKind: 'user' }), true)
  assert.equal(shouldGate(cfg, 'interactive-3', { lastUserMessageKind: 'user' }), false)
  // a malformed pattern never breaks the approval chain
  const bad = { origins: [], sessions: ['[unclosed'] }
  assert.equal(shouldGate(bad, 's1', {}), false)
})

// ---------------------------------------------------------------- raceGate --

test('window 0 denies immediately and never asks downstream', async () => {
  let called = 0
  const outcome = await raceGate(async () => { called += 1; return 'allowed-once' }, 0, 'rejected')
  assert.equal(outcome, 'rejected')
  assert.equal(called, 0)
})

test('an instant fail-closed unavailable passes through the window untouched', async () => {
  const outcome = await raceGate(async () => 'unavailable', 60_000, 'rejected')
  assert.equal(outcome, 'unavailable')
})

test('a real answer inside the window wins over the default', async () => {
  const outcome = await raceGate(
    () => new Promise((resolve) => setTimeout(() => resolve('allowed-once'), 10)),
    60_000,
    'rejected',
  )
  assert.equal(outcome, 'allowed-once')
})

test('a pending answerer loses to the window: default settles it', async () => {
  const started = Date.now()
  const outcome = await raceGate(() => new Promise(() => {}), 40, 'rejected')
  assert.equal(outcome, 'rejected')
  assert.ok(Date.now() - started >= 30, 'the window actually bounded the wait')
})

test('unavailable is a legal default; a rejecting downstream rejects the race', async () => {
  assert.equal(await raceGate(() => new Promise(() => {}), 0, 'unavailable'), 'unavailable')
  await assert.rejects(raceGate(async () => { throw new Error('answerer blew up') }, 60_000, 'rejected'))
})

// ------------------------------------------------------------------- apply --

test('apply registers ONE approval/request listener with prepend, and disposes', () => {
  const ctx = fakeCtx()
  apply(ctx, refs())
  assert.equal(ctx.listeners.length, 1)
  assert.equal(ctx.listeners[0].name, 'approval/request')
  assert.equal(ctx.listeners[0].options?.prepend, true)
  assert.equal(ctx.disposers.length, 1)
})

test('listener: an interactive turn delegates to next() untouched', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs())
  const { listener } = ctx.listeners[0]
  let delegated = 0
  const request = { agent: { id: 'interactive-1', session: fakeSession({ messages: [userMsg('user')] }) } }
  const outcome = await listener(request, async () => { delegated += 1; return 'allowed-once' })
  assert.equal(outcome, 'allowed-once')
  assert.equal(delegated, 1)
})

test('listener: a subagent turn with window 0 denies without delegating', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ windowSeconds: 0 }))
  const { listener } = ctx.listeners[0]
  let delegated = 0
  const request = { agent: { id: 'child-1', session: fakeSession({ origin: 'subagent' }) } }
  const outcome = await listener(request, async () => { delegated += 1; return 'allowed-once' })
  assert.equal(outcome, 'rejected')
  assert.equal(delegated, 0)
})

test('listener: a cron turn is windowed (default origins without cron do NOT gate it)', async () => {
  const defaultCtx = fakeCtx()
  apply(defaultCtx, refs())
  const cronRequest = { agent: { id: 'root-1', session: fakeSession({ messages: [userMsg('cron')] }) } }
  let delegated = 0
  const defaultOutcome = await defaultCtx.listeners[0].listener(cronRequest, async () => {
    delegated += 1
    return 'allowed-once'
  })
  assert.equal(defaultOutcome, 'allowed-once') // not gated → next() straight through
  assert.equal(delegated, 1)

  const cronCtx = fakeCtx()
  apply(cronCtx, refs({ origins: ['cron'], windowSeconds: 0 }))
  const gated = await cronCtx.listeners[0].listener(cronRequest, async () => 'allowed-once')
  assert.equal(gated, 'rejected') // origins: [cron] → windowed → default
})

test('listener: a sessions-list hit gates even a human-driven turn', async () => {
  const ctx = fakeCtx()
  apply(ctx, refs({ sessions: ['night-*'], windowSeconds: 0 }))
  const { listener } = ctx.listeners[0]
  const request = { agent: { id: 'night-runner', session: fakeSession({ messages: [userMsg('user')] }) } }
  assert.equal(await listener(request, async () => 'allowed-once'), 'rejected')
})
