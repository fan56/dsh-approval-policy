# dsh-approval-policy — unattended approval gate

> dsh plugin: unattended approval requests (subagent / scheduled / cron) get a **bounded answer
> window** — the request is handed to the downstream interactive chain first, **a human answer
> inside the window wins**, and when the window expires the request settles with a fail-closed
> default so **the turn lands immediately instead of hanging forever**. Interactive sessions are
> unchanged by default.

**Requires dsh >= 0.1.7-rc.1** (declared in `package.json` as a `peerDependencies` floor — from dsh 0.1.7 the official install precheck reads plugin peerDependencies for compatibility).

> [简体中文](README.md) · **English**

## Why

Since rc.3, dsh has a gap where **an approval may never land**. When nobody is watching (no
browser, or an idle one), the interactive answerer is registered but never answers; under the
cordis waterfall's veto semantics not even a chain-head answerer can save a wait that has no
timeout — while `next()` is never called and no outcome is returned, the approval hangs and the
turn never moves.

dsh 0.1.7 already made the "**no answerer at all**" case fail-closed (returns `'unavailable'`).
What this plugin fills in is the remaining case: **an answerer is registered but doesn't answer**.

Genuinely unattended sources are like that by nature: when a subagent session, a scheduled task
or a cron task fires, the human is simply not at the machine. Waiting for an answer that will
never come is pointless. But blanket auto-reject is wrong too: in a shared session a human may
happen to be there (or may have just interjected), and **a human answer inside the window still
counts**.

Where the ask comes from: Nemuritor01 in deepseek-ai/deepseek-harness discussion #2544 —
**unattended policy, per session or per origin, interactive default unchanged**. This plugin is
that sentence, made executable.

## How it works

The plugin registers on the host's `'approval/request'` cordis waterfall with
`ctx.on('approval/request', …, { prepend: true })`, so the gate sits **ahead of the interactive
answerers** (web remote answerer, dsh-feishu cards, …) regardless of plugin load order. An
unattended request is windowed before any human surface can claim it — and gated requests still
reach those surfaces **through `next()`** inside the window.

```
approval/request (host waterfall)
  │
  └─ dsh-approval-policy (prepend, chain head)
       │
       ├─ shouldGate(request)?
       │    ├─ no (interactive session) → next() immediately ──► interactive default unchanged
       │    │
       │    └─ yes (unattended)
       │         │
       │         └─ raceGate: Promise.race( next(), window timer )
       │              ├─ downstream answers inside the window ──► that answer wins
       │              │     (an instant fail-closed 'unavailable' from an empty
       │              │      chain passes through untouched — nothing to wait for)
       │              ├─ window expires ─────────► defaultOutcome settles
       │              │     (the turn lands immediately: denied or unavailable, never hanging)
       │              │
       │              └─ turn aborted ──────────► the host's signal race yields 'cancelled'
       │                    (a late window expiry is simply ignored)
       │
       └─ interactive answerers (web remote answerer / dsh-feishu card / …) are still on the
          chain, just behind the gate: next() is what gets them their turn
```

### Detection granularity (v1)

| Source | Granularity | Test |
|---|---|---|
| `sessions` list hit | session-level | agent id matches a glob → **every** turn of that session is gated (unioned with `origins`) |
| `all` | global | every approval request is gated (the opt-in gate-everything escape hatch) |
| `subagent` | session-level | `session.header.origin === 'subagent'` (a subagent session is dedicated to delegation) |
| `scheduled` | turn-level | the **last** user message's `source.kind === 'schedule'` (the host's dsh-schedule) |
| `cron` | turn-level | the last user message's `source.kind === 'cron'` (dsh-cron ≥ the patched release) |

`scheduled` / `cron` look at the **last** user message, not "any" or "the first": those sessions
are shared with humans, so **once a human has spoken the turn is not gated** — "is anyone
watching" is exactly the semantics of unattended detection. A human steering a clarification
after a cron fire makes that last message a human one, and the interactive default is kept. A
malformed glob in the `sessions` list is treated as a miss (compile failures don't throw), so a
typo in the list can never break approvals.

### Relationship to the host's own mechanisms

- **Audit comes for free**: the host itself writes `approval/asked` + `approval/decided` into the
  session log, and **this plugin writes no log of its own**. Whichever answerer made the decision
  it is traceable in the transcript, **including a timeout rejection**.
- **The session-level `approval/policy` (ask | never) short-circuits before the waterfall**: the
  host's own policy applies first and `never` auto-rejects outright, with **zero conflict** with
  this plugin — that is the host's existing mechanism, while this plugin is the
  "**try for N seconds, then deny**" time-window shape of the same idea.
- **Interactive sessions (matching no source at all) call `next()` immediately**: the interactive
  default is not touched.
- **Zero on-disk state**: no data files and nothing outside the config itself (the entry id doubles as the settings namespace).

## Configuration

Mounted in the `config:` section of the dsh-approval-policy mount block in `cordis.patch.yml`
(id = `dsh-approval-policy`; the entry id doubles as the settings namespace). All four keys are
**volatile and hot-changeable from the settings page**.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `origins` | `(subagent\|scheduled\|cron\|all)[]` | `[subagent, scheduled]` | which sources count as unattended; `all` is opt-in gate-everything |
| `sessions` | `string[]` (glob) | `[]` | name sessions by agent id glob; a hit gates **every** turn of that session (unioned with `origins`) |
| `windowSeconds` | `number` 0..86400 | `60` | the answer window in seconds; `0` = deny immediately and **not** ask downstream |
| `defaultOutcome` | `rejected \| unavailable` | `rejected` | what settles when the window expires; **there is no allow-once value at the config layer** (fail-closed red line — the schema enum doesn't contain one) |

```yaml
# ~/.dsh/cordis.patch.yml (or a profile's cordis.patch.yml)
- insert:
    - id: dsh-approval-policy
      name: '@aiwayds/dsh-approval-policy'
      config:
        origins: [subagent, scheduled, cron]   # cron needs the dsh-cron source-kind patch release
        windowSeconds: 60
        defaultOutcome: rejected
```

- `defaultOutcome` has exactly two values, `rejected` and `unavailable` — **there is no
  `allowed-once` ("allow this one") tier**, because an unattended default must fail closed: a
  timeout is a denial. To "allow once" inside the window, let a human actually answer during it.
- Edits to `cordis.patch.yml` take effect after a dsh restart; the four keys in the mount block
  can also be hot-changed from the settings page.
- A full setup wizard ships with the plugin as the `dsh-approval-policy-config` skill
  (`skills/dsh-approval-policy-config/SKILL.md`).

## Install

```bash
dsh plugin add @aiwayds/dsh-approval-policy   # activate the gate; the bundle mounts itself
```

For profile-scoped work use `dsh plugin --profile <name> add @aiwayds/dsh-approval-policy`.
Once installed it is live with the defaults above (`origins: [subagent, scheduled]`, 60-second
window, `rejected` on timeout) — no patch file needed. To gate `cron` as well, add the `config:`
section shown above.

For local development with a link, the bundle may sit before or after the interactive UIs
(`prepend` keeps the gate at the chain head regardless of load order):

```jsonc
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@aiwayds/dsh-approval-policy",
    "@aiwayds/dsh-tui-pi"
  ]}}
}
```

## Uninstall

```bash
dsh plugin remove @aiwayds/dsh-approval-policy
```

The host drops the matching profile `bundles` entry and the plugin's patch layer. This plugin
keeps **zero on-disk state** — no data files, nothing beyond its config (the entry id doubles as
the settings namespace) — so nothing is left behind.

After removal, approval behavior **returns to the host's native shape (no window)**: the
session-level `approval/policy` `ask` / `never` still applies, interactive answerers still
answer, and the "unattended with nobody answering" case becomes **possibly-never-landing** again.
If you want the denial guarantee without this plugin, set those sessions to
`approval/policy: never` (immediate deny, no window).

## Tests

```bash
npm test    # 16 pure-logic unit tests (node --test):
            #   glob compilation / fact reading (last user message) / detection granularity
            #   (subagent, scheduled, cron, all, sessions list and its union)
            #   + race semantics (window 0 denies without delegating, an instant unavailable
            #   passes through, an in-window answer wins, a stuck answerer loses to the window)
            #   + apply() registers ONE prepend listener on approval/request and disposes it

npm run smoke   # scripts/smoke-boot.mjs: real-host dump-config + boot + uninstall leg
```

License: MIT. Author fan56.
