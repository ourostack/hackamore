# AGENTS.md

## Pull requests merge fast

Follow ourostack's shared rule, [every PR merges fast](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md). Finish, review and validate on your branch first, then publish with `gh ouro-pr`, which turns auto-merge on so green means merged. 30 minutes is the outer alarm, not the goal: merge and run CI as fast as possible.

## What this repo is

hackamore: the engine that drives any Mac app from outside through its accessibility tree (and, where there is no tree, through pixels), speaking the [Reins](https://github.com/ourostack/ouro-ui-apple/blob/main/PROTOCOL.md) protocol. A Swift engine (`swift/ax-engine.swift`), a small app that holds the Accessibility grant (`src/agent.mjs`), and a Node CLI and library (`bin/`, `src/`).

- **Generic only.** Nothing here may name a person's machines, accounts, tenants or a company's internal tools. What an owner adds (extra protected apps, Keychain item names, prompt decisions, their own tools) goes in the owner's `config.json` (`src/config.mjs`), never in a default.
- **Transports belong to the caller.** hackamore carries a request as one JSON line (`hackamore wire`); `--via` runs any command that does. Don't add a transport for one team's network or bus; point `--via` at it.
- **Secrets by reference only.** `type_secret` takes a Keychain item name; a secret never goes on a command line, in a log or over a transport. Tests assert it.
- **Never drive a screen a person is using.** The gate (`src/gate.mjs`) and the protected-app list are the product; weakening either needs a recorded decision from the owner.
- **Ouro AX.** The CLI follows [Ouro AX](https://github.com/ourostack/ouro-ui#ouro-ax): `help` and `help --json`, one-line errors that name the fix, exit codes 0, 1 and 2, no booklet. Teach the surface, not a doc. Give general lessons back to ouro-ui.
- **Honest status.** The README's "What's verified" table says what ran on a real Mac and what ran on fakes. Move a row only with evidence.
- **Tests:** `npm test` (about 15 s; the engine tests compile Swift, so they run on macOS and skip elsewhere). CI runs macOS with Node 20 and 22, and the pure logic on Linux.
- **Brand:** the README header and social preview come from ourostack/.github `brand/`; see its AGENTS.md before changing either.

## Git

- Commit email: `16390116+arimendelow@users.noreply.github.com`.
- No AI attribution in commits, pull requests or files.
