# Racing gate answerer on `approval/request`

Approval requests raised by unattended sources (subagent sessions, scheduled turns, cron turns) can hang forever: an interactive answerer is registered but never answers, and the cordis waterfall's veto semantics give a chain-head answerer no way out of a wait with no timeout. We decided dsh-approval-policy v1 is a **racing gate answerer prepended to the host's `approval/request` waterfall**: it delegates with `next()` first, then races the downstream chain against a bounded window — a human answer inside the window wins, an expired window settles the configured fail-closed default — and interactive turns delegate immediately. Only the race gives both halves of the requirement at once: a human can still answer during the window, and the turn always lands when the window runs out, with the interactive default untouched.

## Considered Options

- **Just configure the host's session `approval/policy: never`**: rejected — it has no time window at all. It denies the moment the request is asked, so a human who is actually watching can never answer, and a shared session gets no per-turn judgement. That is a different, coarser shape from "try for N seconds, then deny".
- **A surface-registry router shape (the dsh-ask-router pattern)**: rejected — approval is already natively a multi-answerer waterfall with no single-slot problem. The web and feishu answerers coexist by registering natively, so a registry would solve a gap that does not exist here; there is no slot to arbitrate and therefore nothing a router could add.
- **Wait for the upstream host to add a timeout**: rejected for v1 — the upstream cycle is long, and a plugin closes the loop today. Racing `next()` against a timer is small enough to remove later if the host grows an equivalent mechanism.

## Consequences

- The gate must be `prepend`ed so unattended requests are windowed before a human surface claims them; gated requests still reach those surfaces through `next()` inside the window, so load order does not matter.
- The default outcome is fail-closed by construction — `rejected` or `unavailable` only. A "allow once on timeout" tier is deliberately absent from the config schema, so the unattended default can never grant.
- Audit needs no work here: the host writes `approval/asked` and `approval/decided` to the session transcript for whichever answerer decided, so a timeout rejection is traceable and the plugin keeps zero on-disk state.
- Detection is per session for `sessions`/`subagent`/`all` and per turn for `scheduled`/`cron`, the latter read off the session's last provenance-bearing user message (synthetic `role='user'` context injections like `runtime-context` land after the trigger and are skipped — found only by the live-host test) — "is anyone watching", not "was this ever machine-driven".
