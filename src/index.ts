/**
 * dsh-approval-policy — the unattended approval gate.
 *
 * On the host's 'approval/request' cordis waterfall this plugin is a racing
 * gate answerer. For sessions/turns declared unattended (config: origins /
 * sessions) it does not simply claim the request — it delegates with next()
 * FIRST and races the downstream chain against a bounded window. Whoever
 * settles first wins:
 *
 *   - a downstream answerer answers inside the window → its answer wins
 *     (an instant fail-closed 'unavailable' from an empty chain passes
 *     through untouched — nothing to wait for);
 *   - the window expires → the configured fail-closed default settles the
 *     approval ('rejected'; 'unavailable' also allowed — 'allowed-once' is
 *     schema-forbidden). The turn proceeds denied instead of hanging;
 *   - the request's abort signal resolves 'cancelled' upstream — the host
 *     races the signal itself; a late window expiry is simply ignored.
 *
 * Unattended detection (config `origins`), in evaluation order:
 *
 *   - sessions: glob-matched against the requesting agent id — an explicit
 *     name wins and gates EVERY turn of that session (session-level);
 *   - all: gate everything (opt-in escape hatch);
 *   - subagent: session.header.origin === 'subagent' (session-level — a
 *     subagent session is dedicated to delegation);
 *   - scheduled / cron: turn-level — the LAST user message's source.kind is
 *     'schedule' (host dsh-schedule) or 'cron' (dsh-cron). Turn-level
 *     because those sessions are shared with humans: only machine-driven
 *     turns gate, and a human steering afterwards (last user message =
 *     human) keeps the interactive default.
 *
 * The listener registers with prepend: true — the gate sits ahead of the
 * interactive answerers (web remote answerer, dsh-feishu card) regardless of
 * plugin load order, so an unattended request is windowed before a human
 * surface claims it. Gated requests still reach those surfaces through
 * next() inside the window. Interactive turns delegate immediately — the
 * interactive default is unchanged.
 *
 * Audit: the host owns approval/asked + approval/decided — every decision,
 * whichever answerer made it, lands in the session transcript. The gate
 * never writes to the session log itself.
 *
 * Config: `export const Config` is the settings-page schema (all keys
 * volatile, all defaults fail-closed-friendly); `apply` reads them through
 * live references like dsh-cron does.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

export const name = 'dsh-approval-policy'

/** Origins a deployment may declare unattended (config vocabulary). */
export type UnattendedOrigin = 'subagent' | 'scheduled' | 'cron' | 'all'

/**
 * The only outcomes a gate may settle with. 'allowed-once' is deliberately
 * absent from this union AND from the config enum: an unattended default
 * must never grant — fail closed is the whole point.
 */
export type GatedOutcome = 'rejected' | 'unavailable'

/** Settings-page schema; each key arrives as a volatile live reference. */
export const Config = z.object({
  /** Session/turn origins treated as unattended. Default: subagent + scheduled. */
  origins: z.array(z.union(['subagent', 'scheduled', 'cron', 'all'])).default(['subagent', 'scheduled']).volatile(),
  /** Glob patterns matched against the requesting agent id; a hit gates every turn of that session. */
  sessions: z.array(z.string()).default([]).volatile(),
  /** Answer window in seconds (whole seconds; no .int() chain exists — min/max bound it); 0 denies without delegating. Default 60. */
  windowSeconds: z.number().min(0).max(86400).default(60).volatile(),
  /** Settled when the window expires; 'allowed-once' is not in the union. */
  defaultOutcome: z.union(['rejected', 'unavailable']).default('rejected').volatile(),
})

/** Volatile Config fields arrive as live references; `.get()` snapshots. */
interface VolatileRef<T> {
  get(): T
}

/** The runtime shape `apply` receives (every field volatile). */
export interface GateRuntimeConfig {
  origins: VolatileRef<UnattendedOrigin[]>
  sessions: VolatileRef<string[]>
  windowSeconds: VolatileRef<number>
  defaultOutcome: VolatileRef<GatedOutcome>
}

/** Compiled glob: `*` matches anything, everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^(?:${escaped})$`)
}

/** What the gate reads off the requesting agent to classify the turn. */
export interface OriginFacts {
  /** session.header.origin when the live session is readable ('subagent' …). */
  headerOrigin?: string
  /** source.kind of the session's last user message ('schedule', 'cron', 'user', …). */
  lastUserMessageKind?: string
}

/** Structural slices of the runtime faces — no closure type imports needed. */
interface MsgLike {
  readonly role?: string
  readonly source?: { readonly kind?: string }
}
interface SessionLike {
  readonly header?: { readonly origin?: string }
  deriveMessages?(): MsgLike[]
}
interface AgentLike {
  readonly id?: unknown
  readonly session?: SessionLike
}

/**
 * Read the origin facts off the request's agent. Both reads are best-effort:
 * a projected agent without a live session yields `{}` (only `sessions`/`all`
 * can then gate), and each fact independently degrades to undefined.
 */
export function readFacts(agent: AgentLike | undefined): OriginFacts {
  const session = agent?.session
  if (!session) return {}
  const facts: OriginFacts = { headerOrigin: session.header?.origin }
  const messages = session.deriveMessages?.()
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message?.role === 'user') {
        facts.lastUserMessageKind = message.source?.kind
        break
      }
    }
  }
  return facts
}

/** Gate predicate: explicit session hit → 'all' → session/turn origins. */
export function shouldGate(
  config: { readonly origins: readonly UnattendedOrigin[]; readonly sessions: readonly string[] },
  sessionId: string,
  facts: OriginFacts,
): boolean {
  if (config.sessions.length > 0 && config.sessions.some((pattern) => {
    try {
      return globToRegExp(pattern).test(sessionId)
    } catch {
      return false // a malformed pattern must not break approvals
    }
  })) return true
  const origins = config.origins
  if (origins.includes('all')) return true
  if (origins.includes('subagent') && facts.headerOrigin === 'subagent') return true
  const kind = facts.lastUserMessageKind
  if (kind === 'schedule' && origins.includes('scheduled')) return true
  if (kind === 'cron' && origins.includes('cron')) return true
  return false
}

/**
 * The gate: delegate first, race the downstream chain against the window.
 *
 * windowMs <= 0 denies immediately WITHOUT calling `decision` (the 0 = instant
 * deny degenerate case — downstream never sees the request, mirroring the
 * host's approval/policy=never). A fast `decision` (including an instant
 * fail-closed 'unavailable' from an empty chain) passes through untouched;
 * only a pending decision races the timer.
 */
export async function raceGate(
  decision: () => Promise<ApprovalOutcome>,
  windowMs: number,
  defaultOutcome: GatedOutcome,
): Promise<ApprovalOutcome> {
  if (windowMs <= 0) return defaultOutcome
  // The window timer stays REF'd on purpose: an open window means the host
  // turn is still owed an outcome, so the process must not drain the event
  // loop before it settles. It is cleared as soon as the race settles
  // (answer, rejection, or expiry) so a fast answer never leaves a stray
  // timer holding the loop for the rest of the window.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      decision(),
      new Promise<ApprovalOutcome>((resolve) => {
        timer = setTimeout(() => resolve(defaultOutcome), windowMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function apply(ctx: Context, config: GateRuntimeConfig): void {
  const cfgNow = () => ({
    origins: config.origins.get(),
    sessions: config.sessions.get(),
    windowSeconds: config.windowSeconds.get(),
    defaultOutcome: config.defaultOutcome.get(),
  })

  const listener = (
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    const cfg = cfgNow()
    const sessionId = String(request.agent?.id ?? '')
    if (!shouldGate(cfg, sessionId, readFacts(request.agent))) return next()
    return raceGate(next, cfg.windowSeconds * 1000, cfg.defaultOutcome)
  }

  // prepend keeps the gate ahead of interactive answerers regardless of
  // plugin load order; gated requests still reach them via next().
  const dispose = ctx.on('approval/request', listener, { prepend: true })
  ctx.effect(() => dispose)
}
