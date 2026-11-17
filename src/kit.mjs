// hackamore's command table, declared once in actions/hackamore.actions.mts and generated into
// actions/generated/commands.json. The generator cannot declare an optional word, so the four the CLI takes (ls's app,
// do's input, the word gate and agent take) are added here; the kit's parse does the rest: the words and flags a
// command takes, the --why an action other people see needs, and the one-line refusals.
import { readFileSync } from 'node:fs';
import { defineCli, defineCommand } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { outcome } from '../lib/ouro-ui/registry/ouro/ax/outcome.ts';

const declared = JSON.parse(readFileSync(new URL('../actions/generated/commands.json', import.meta.url), 'utf8')).commands;

// A declared flag the CLI also takes as an optional word instead.
const FLAG_AS_WORD = { ls: { app: 'app' }, do: { 'input-json': 'input' } };
const MORE_WORDS = {
  gate: [{ name: 'action', description: 'check (the default), wait, init, pre, post or show.' }],
  agent: [{ name: 'action', description: 'status (the default), install, build or grant.' }],
};

// Another program reads these replies: they are one JSON line on stdout when piped, and refusals also say why on stderr.
const PROTOCOL = ['wire', 'do', 'batch', 'journey'];

const GLOBAL_FLAGS = {
  via: { type: 'string', description: "Drive another Mac: the command runs `hackamore wire` there, e.g. 'ssh mini hackamore wire'." },
  as: { type: 'string', description: 'Name the Mac in replies and the screen cache.' },
  kvm: { type: 'string', description: 'Use the pixels of a housesitter KVM for that Mac.' },
};

const doOrRead = [
  { means: 'act on an app', use: "do <action> '<json>'" },
  { means: 'read an app first', use: 'ls [app]' },
];

const commands = declared.map((d) => {
  const flags = { ...(d.flags ?? {}) };
  const args = [...(d.args ?? [])];
  for (const [flag, word] of Object.entries(FLAG_AS_WORD[d.name] ?? {})) {
    args.push({ name: word, description: flags[flag].description });
    delete flags[flag];
  }
  args.push(...(MORE_WORDS[d.name] ?? []));
  return defineCommand({ name: d.name, summary: d.summary, effect: d.effect, readOnly: d.readOnly, args, flags, output: d.output, ...(PROTOCOL.includes(d.name) ? { protocol: true } : {}) });
});

export const cli = defineCli({
  name: 'hackamore',
  about: ['hackamore: drive any Mac app like an API through its accessibility tree.'],
  globalFlags: GLOBAL_FLAGS,
  ambiguous: { edit: doOrRead, delete: doOrRead, remove: doOrRead },
  commands,
});

// A --dry-run answer: what would run, on which target, and who would see it. Nothing is sent or run.
export function planOutcome(name) {
  const c = commands.find((x) => x.name === name);
  const others = c.effect === 'others';
  const summary = `Would run ${name} on the front app, resolved at run time: ${c.summary} Nothing was sent.`
    + (others ? ' Other people will see it if it runs.' : '');
  return outcome({ action: name, state: 'planned', effect: others ? 'others' : 'private', audience: others ? { only: false, who: 'the people in the front app, resolved at run time' } : undefined, summary });
}

export const COMMAND_NAMES = commands.map((c) => c.name);
