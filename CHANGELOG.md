# Changelog

## Unreleased

- Breaking: needs Node 22.18 or later, because the vendored Ouro AX kit runs its TypeScript as it is. Node 20 is no longer tested.
- Breaking: `do`, `batch`, `journey` and `wire` need `--why` (who asked you, and what they said). `--dry-run` previews any of them without acting. `--via` forwards the `--why` to the other Mac's `wire`.
- `help --json` names each command's effect (`private` or `others`) and the exit codes (`exitCodes`); `exit_codes` is kept.
- `<command> --help` prints that command's usage, who sees it, and an example.
- `edit`, `delete` and `remove` answer with the commands to use instead; they do not act.
- Unknown flags on declared commands are refused, naming the flag.
