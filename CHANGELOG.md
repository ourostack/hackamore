# Changelog

## Unreleased

- Optional words are declared in `actions/hackamore.actions.mts` and generated (ouro-actions v0.17.7): `ls [<app>]`, `gate [<action>]` (check, wait, init, pre, post, show) and `agent [<action>]` (status, install, build, grant). The kit no longer patches words in.
- Breaking for library users: `do`'s JSON input is the word `inputJson` (it was the word `input`, shown as `[<input>]`), so `cmdUiReins('do', …)` reads `inputJson`. The generator reserves `input` as an App Intent member name, so the field can't keep that name. An unknown flag spelt as a word (`agent --install`) names the word as its fix.
- Every command is declared in `actions/hackamore.actions.mts` (now including `agent` and `wire`), and the kit parses every command line. The legacy dispatch table, the pass-through dispatcher and `parseUiArgs` are gone. Flags and exit codes are unchanged.
- Breaking for library users: `cmdUiReins(sub, input, deps)` takes the parsed input object, not an argv array. `help --json` has the kit's shape and no longer carries `exit_codes` (use `exitCodes`).
- A failed `ls`, `do` or `batch` reply also writes its problem and fix on stderr.
- Breaking: needs Node 22.18 or later, because the vendored Ouro AX kit runs its TypeScript as it is. Node 20 is no longer tested.
- Breaking: `do`, `batch`, `journey` and `wire` need `--why` (who asked you, and what they said). `--dry-run` previews any of them without acting. `--via` forwards the `--why` to the other Mac's `wire`.
- `help --json` names each command's effect (`private` or `others`) and the exit codes (`exitCodes`); `exit_codes` is kept.
- `<command> --help` prints that command's usage, who sees it, and an example.
- `edit`, `delete` and `remove` answer with the commands to use instead; they do not act.
- Unknown flags on declared commands are refused, naming the flag.
- The Ouro AX X-ray runs in CI against the fixture engine, and fails unless every must claim holds. `wire` is marked `protocol`, so its one JSON reply line on stdout is the reply.
