# Changelog

## v0.1.3 — 2026-11-04

- Version aligned with the staged npm release; no runtime change from 0.1.2.

## v0.1.2 — 2026-11-03

- The tools service is requested through `ctx.inject(['tools'])`, which is the
  host contract, with a guarded direct read kept as fallback. Reading `ctx.tools`
  off the root context throws `cannot get property tools without inject` on
  profiles that resolve the service lazily — that aborted `apply()` and left the
  plugin mounted but tool-less. `registerAll` ignores the second attempt, so the
  five tools still register exactly once.
- Verified on a real `--profile acp` host: 5/5 tools register and
  `channel_workspace_info` answers.

## v0.1.1 — 2026-11-03

- `@deepseek-ai/dsh-tools` moved from a hard dependency to an optional peer. A hard
  dep gets hoisted into the profile's top-level `node_modules` and can shadow the
  host's own copy of the core package, which is exactly what broke boot on
  0.2.1-rc.5. The host provides it at runtime, so it must not be pinned here.
- Repository metadata (`repository` / `bugs` / `homepage`) and `LICENSE` added.
- Install docs rewritten: git/local install is the documented path, and the
  `0.0.0-stage` placeholder npm serves until the staged version is approved is
  called out so nobody installs it by accident.
- `test/contract_test.mjs` takes paths from `DSH_TOOLS_ENTRY` / `DSH_PLUGIN_ENTRY`
  instead of hardcoding one machine's install layout.

## v0.1.0 — 2026-11-03

Initial release: one dedicated workspace for phone-initiated sessions, plus a
single shared memory store every session can read.

- Workspace ownership uses the host's own invariant instead of guessing where a
  session's cwd lives: `Workspace.attachSession()` validates the session header cwd
  against the workspace path and throws otherwise, so a successful attach is the
  only evidence of channel ownership and foreign desktop sessions are never claimed.
- Shared memory persists to one checksummed JSON file, written by atomic rename. A
  truncated or externally corrupted file falls back to an empty store rather than
  serving dirty data as memory.
- The prompt index registers via `systemPrompt.section({ text })` with `text` as a
  function, so writes made after `apply()` surface on the next assembly without a
  manual refresh, and it appends its own section rather than replacing persona.
- Five tools: `memory_write` / `memory_search` / `memory_list` / `memory_forget` /
  `channel_workspace_info`.
- `test/contract_test.mjs` runs the host's real `defineTool`, not a stub, so any
  value-schema DSL violation throws at test time instead of at boot.
