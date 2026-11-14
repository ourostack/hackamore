<!-- ourostack:brand:start -->
<p align="center">
  <a href="https://github.com/ourostack"><img src="https://raw.githubusercontent.com/ourostack/.github/main/brand/headers/ourostack.webp" alt="Ouro, the green snake curled into an O, at dawn in a meadow with its friends: the Factory, the Desk under a blossom tree, a reading lectern, the green Ouro HX card, two people and two robots on a picnic blanket, and a flock of robot sheep by a shepherd's crook" width="100%"></a>
</p>
<!-- ourostack:brand:end -->

# hackamore

**Drive any Mac app like an API: its screen as state, its controls as actions, refusals before anything moves. For agents, with no model in the loop.**

**Status:** experimental. The engine ran live on our Mac mini and laptop (Finder, System Settings, Calculator through the accessibility tree; dialogs and the lock screen through a KVM's pixels). The tests here use fakes and compile the real Swift engine; [What's verified](#whats-verified) says which is which. Releases may be unsigned: see [Signing](#signing).

[Try it](#try-it) · [Why I built it](#why-i-built-it) · [The contract](#the-contract) · [Two ways in](#two-ways-in-the-tree-and-the-pixels) · [Another Mac](#another-mac) · [The rules it won't break](#the-rules-it-wont-break) · [Where it sits](#where-it-sits) · [What's verified](#whats-verified) · [More from Ouro](https://github.com/ourostack)

```sh
git clone https://github.com/ourostack/hackamore && cd hackamore
node bin/hackamore.mjs doctor      # what this Mac has, and the one next step if it's missing the grant
node bin/hackamore.mjs ls Finder   # the screen as data, plus the actions that fit it right now
```

Needs macOS 14 or later, Node 20 or later and Xcode's command-line tools (`swiftc` builds the engine on first use). The first run needs Accessibility for the process that runs it; `hackamore agent install` gives that grant to a small app of its own instead, so a person grants it once.

## Why I built it

Our agents live on a Mac mini. Every few days one of them needed something done in a window: click Allow on a permission prompt, close System Settings, clear a pile of notifications. Each time it went the slow way: screenshot, ask a model where the button is, click, screenshot again. Ten seconds and a few cents a click, and sometimes the wrong button.

That's work that shouldn't need a model. A window already knows what's in it: macOS's accessibility tree has every button, field and label, with its name and where it is. hackamore reads it and hands an agent the screen as data, with the actions that make sense on that screen right now, each with a schema narrowed to what is actually there. The agent says `click "Allow"`. hackamore checks that "Allow" is on the screen, that nobody is using the Mac and that the app isn't one it must leave alone, then presses it and answers with the screen after.

It speaks [Reins](https://github.com/ourostack/ouro-ui-apple/blob/main/docs/ouro-reins/PROTOCOL.md), the protocol our own apps use to let agents drive them. An app built with [Ouro UI](https://github.com/ourostack/ouro-ui) hands its reins to the agent. A hackamore is a bridle with no bit: you steer without putting anything in the horse's mouth. hackamore steers apps that were never built for it.

## The contract

```sh
hackamore ls Calculator
hackamore do click '{"element":"button[7]"}'
hackamore batch '[{"action":"click","input":{"element":"button[7]"}},
                  {"action":"click","input":{"element":"button[Multiply]"}},
                  {"action":"click","input":{"element":"button[6]"}},
                  {"action":"click","input":{"element":"button[Equals]"},"until":{"@Edit field.value":"42"}}]'
```

- **The screen is state.** The front app and window, any alert on top, and a pruned tree: roles, labels, values, enabled, focused, frames. Addresses are role and label paths (`toolbar > button[Back]`), so a recorded journey replays after the window moves.
- **Actions are narrowed to this screen.** `click`'s `element` is an enum of what's there. Asking for something that isn't there is refused before anything moves, with the fix.
- **Three ways to say no:** `action-unavailable`, `input-invalid` and `action-failed`, plus `person-active`, `app-protected`, `screen-locked` and `permission-missing`. Each refusal names the thing, the problem and the fix. Exit codes: 0 ok, 1 failed, 2 refused or a bad command line.
- **`batch` runs many steps in one call.** Each step may carry an `until` that is checked next to the screen, so a form fill is one round trip. `--diff` returns only what changed against the screen you last read.
- **`--record <file>` and `journey`.** Record steps while you work, replay them as one batch.

`hackamore help` lists every command with an example, and `hackamore help --json` is the same table for a program.

## Two ways in: the tree and the pixels

- **The tree** (macOS accessibility): exact and fast, nothing to guess. The engine is `swift/ax-engine.swift`. The Ouro Reins Agent, a small app with its own LaunchAgent, holds the Accessibility grant and stays warm.
- **The pixels**, for where there's no tree: the FileVault and lock screens, canvas and some Electron apps, a Mac whose window server is wedged. A screenshot, Apple Vision's text boxes as elements in the same shape (`"layer": "pixels"`), and clicks and keys through this Mac's own screen (`--layer pixels`) or through an IP-KVM with [housesitter](https://github.com/ourostack/housesitter) (`--kvm <name>`, which needs `@ouro.bot/housesitter` installed). Text is typed key by key, and `type_text` reads the screen afterwards and says whether the text is there.

## Another Mac

The engine runs on the Mac it drives. To drive another one, give `--via` any command that runs `hackamore wire` there:

```sh
hackamore ls Finder --via 'ssh mini hackamore wire' --as mini
```

One request is a JSON line on stdin and one reply is a JSON line out, so `ssh`, a message bus or a job runner all fit. A call pays the transport's round trip once, however many steps a batch has.

## The rules it won't break

- **Never a screen a person is using.** Every action passes a gate: the Mac unlocked, and nobody's input for 90 seconds (`--idle` changes that), our own marked input excepted. A call in progress counts as use. A person's touch stops it with `person-active`. An AX press or value set in an app that isn't in front makes no input event, so it runs anyway; the pointer never moves for an app that isn't in front.
- **Apps that refuse automation stay refused** (`app-protected`): password prompts, Keychain Access, Passwords, and security panes of System Settings. An owner adds more in `~/.config/hackamore/config.json` (`protected`).
- **No password on the command line, ever.** `type_secret` takes a Keychain item name the owner's config lists (`secrets`); the value is read on the Mac that types it and only typed into a field that is asking for a password.
- **A permission prompt is answered only when the owner said so**: never a password, administrator or security prompt, and only the one button in a recorded `prompt_decisions` entry or an `Allow` for a tool listed in `clients`.

The config file is optional JSON: `protected`, `secrets`, `prompt_decisions`, `clients`. `HACKAMORE_CONFIG` names another file and `HACKAMORE_CONFIG_JSON` carries it inline.

## Where it sits

- **Reins** ([ouro-ui-apple](https://github.com/ourostack/ouro-ui-apple/blob/main/docs/ouro-reins/PROTOCOL.md)) is the protocol: the screen as state, actions with schemas, refusals before anything runs. Apps built with Ouro UI implement it from the inside; hackamore implements it from the outside for any app.
- **[housesitter](https://github.com/ourostack/housesitter)** keeps an always-on Mac alive and gives agents a KVM's eyes and hands before login. hackamore uses it as the pixel layer's hands, and housesitter uses hackamore's schema check.
- **Prior art we looked at:** [Peekaboo](https://peekaboo.sh/) (a tool belt for a model; its capture and permission handling are mature), [mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) (closest in shape; no narrowed schemas, refusals, gate, batch or diffs), [MacOS-MCP](https://github.com/CursorTouch/MacOS-MCP) (Python, a process per call) and Apple's XCUITest (needs an Xcode test runner, about 900 times slower than OuroReins' own measure for one journey).

## Signing

The agent app is built by this repository's release workflow, which publishes the next patch release on every merge to main. With the ourostack Developer ID secrets it is signed and notarized, and macOS keeps the Accessibility grant when the app updates. Without them the release is **ad-hoc signed**, and its notes say `UNSIGNED`: macOS drops the grant each time the engine changes, so grant it again after every update. `hackamore agent install` installs the latest release (or a local build) and only accepts our team's signature or the manifest's exact hash.

## What's verified

| Claim | State |
| --- | --- |
| Pruning, addresses, narrowed schemas, refusals, gate, settle, batch, diffs, the pixel layer | **Fakes**, in CI on every pull request (a fake engine, gate and pixel driver) |
| The Swift engine builds and answers `trust` and `apps`; the agent app builds and bundles | **Real**, in CI on macOS |
| `ls`, `do` and `batch` against Finder, System Settings and Calculator | **Live on our Mac mini**, before the engine moved here |
| This repository's own `hackamore ls` on a real Mac | **Live on our Mac mini** with the resident agent; the laptop run is noted in the issue about signing |
| Pixels through a KVM (notification banners, System Settings' password sheet, dialogs) | **Live on our Mac mini**, through housesitter's KVM |
| Developer ID signing and notarization of releases | **Not yet proven**: see [Signing](#signing) |
| A recorded demo and a `hackamore demo` command | **Not built yet** |

MIT licensed. Made by [Ari Mendelow](https://mendelow.me/).
