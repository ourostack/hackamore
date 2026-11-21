// hackamore's command table, declared once in actions/hackamore.actions.mts and generated into
// actions/generated/commands.json, which carries the words a command takes (optional ones too). The kit's parse does the
// rest: the words and flags a command takes, the --why an action other people see needs, and the one-line refusals.
import { readFileSync } from 'node:fs';
import { defineCli, defineCommand } from '../lib/ouro-ui/registry/ouro/ax/ax-command.ts';
import { outcome } from '../lib/ouro-ui/registry/ouro/ax/outcome.ts';

const declared = JSON.parse(readFileSync(new URL('../actions/generated/commands.json', import.meta.url), 'utf8')).commands;

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

const commands = declared.map((d) => defineCommand({ name: d.name, summary: d.summary, effect: d.effect, readOnly: d.readOnly, args: d.args ?? [], flags: d.flags ?? {}, output: d.output, ...(PROTOCOL.includes(d.name) ? { protocol: true } : {}) }));

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
