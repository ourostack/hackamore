# AGENTS.md

- **Pull requests:** follow ourostack's [every PR merges fast](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md) and publish with `gh ouro-pr`.
- **What it is, and the rules it won't break:** the [README](README.md). The gate (`src/gate.mjs`) and the protected-app list are the product; weakening either needs a recorded decision from the owner.
- **Generic only.** Nothing here may name a person's machines, accounts, tenants or a company's internal tools. What an owner adds goes in the owner's `config.json` (`src/config.mjs`), never in a default.
- **Transports belong to the caller.** Don't add a transport for one team's network or bus; point `--via` at it.
- **The CLI follows [Ouro AX](https://github.com/ourostack/ouro-ui#ouro-ax).** Teach the surface, not a doc, and give general lessons back to ouro-ui.
- **Honest status.** Move a row of the README's "What's verified" table only with evidence.
- **Brand:** the README header and social preview come from ourostack/.github `brand/`; see its AGENTS.md before changing either.
- **Commit email:** `16390116+arimendelow@users.noreply.github.com`.
