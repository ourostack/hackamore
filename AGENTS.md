# AGENTS.md

- **Pull requests:** follow ourostack's [every PR merges fast](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md) and publish with `gh ouro-pr`.
- **What it is, and the rules it won't break:** the [README](README.md). The gate (`src/gate.mjs`) and the protected-app list are the product; weakening either needs a recorded decision from the owner.
- **Generic only.** Nothing here may name a person's machines, accounts, tenants or a company's internal tools. What an owner adds goes in the owner's `config.json` (`src/config.mjs`), never in a default.
- **Transports belong to the caller.** Don't add a transport for one team's network or bus; point `--via` at it.
- **The CLI follows [Ouro AX](https://github.com/ourostack/ouro-ui#ouro-ax).** Teach the surface, not a doc, and give general lessons back to ouro-ui.
- **Honest status.** Move a row of the README's "What's verified" table only with evidence.
- **Brand:** the README header and social preview come from ourostack/.github `brand/`; see its AGENTS.md before changing either.
- **Commit email:** `16390116+arimendelow@users.noreply.github.com`.

<!-- ouro-ui:bar -->
**The bar, for people and agents alike** ([design craft](https://ui.ouroboros.bot/docs/design-craft/#the-bar)): would the people who made the Mac and the iPhone ship it? Whenever you scope or design something a person or an agent meets (a screen, a menu, a setting, a command, an action, a tool, a line of output):

1. Start from the jobs people do, in their words. Read a reference product's items, a service's functions or an API's fields as evidence of jobs, never as the list to build.
2. Make the first cut restraint: for each thing, name the job it serves and ask what breaks if it goes; if nothing does, leave it out and say why. Give each job one way in, not one per item or function, and extend the one that exists before adding another.
3. Build what is left well, the basics people use daily among it, for the person and for agents, with a result that says what it did.
4. Write how fresh people or fresh agents doing a real job will prove it, and rerun them after each small change.
5. Before you show a scope or design, follow the [`the-bar` skill](.agents/skills/the-bar/SKILL.md): a fresh agent that didn't write it checks every item against these steps, and you fix what it finds.
<!-- /ouro-ui:bar -->
