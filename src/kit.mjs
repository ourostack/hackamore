// The Ouro AX kit in front of the CLI: the agent-facing commands are declared in actions/hackamore.actions.mts and
// generated into actions/generated/commands.json. The generator can't express positional arguments or the legacy
// flags, so they are added here; the kit's parse refuses an unknown flag and a missing --why, and answers --dry-run
// with a plan. Commands the declarations don't cover yet pass through the legacy dispatcher unchanged.
import { readFileSync } from 'node:fs';
import { defineCli, defineCommand, parse } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { errorLine, isAxError } from '../lib/ouro-ui/registry/ouro/ax/problem.ts';
import { outcome, outcomeText } from '../lib/ouro-ui/registry/ouro/ax/outcome.ts';

const declared = JSON.parse(readFileSync(new URL('../actions/generated/commands.json', import.meta.url), 'utf8')).commands;

const LEGACY = {
  ls: {
    args: [{ name: 'app', description: 'The app to read. Defaults to the front app.' }],
    flags: {
      layer: { type: 'enum', description: 'Which layer reads the screen: auto, the accessibility tree (ax) or pixels.', values: ['auto', 'ax', 'pixels'] },
      'no-menus': { type: 'boolean', description: 'Leave out the menu bar.' },
      diff: { type: 'boolean', description: 'Show only what changed since the last read.' },
    },
    drop: ['app'],
  },
  do: {
    args: [
      { name: 'action', description: 'The action to run, as ls lists it.', required: true },
      { name: 'input', description: "The action's input as a JSON object, in single quotes." },
    ],
    flags: {
      app: { type: 'string', description: 'The app to act on. Defaults to the front app.' },
      idle: { type: 'number', description: 'Refuse unless nobody has used the Mac for this many seconds.', min: 0 },
      record: { type: 'string', description: 'Write the step to this file, for a journey.' },
      diff: { type: 'boolean', description: 'Show only what changed after the action.' },
    },
    drop: ['input-json'],
  },
  batch: {
    args: [{ name: 'steps', description: 'A JSON array of {action, input, until?, app?} steps.', required: true }],
    flags: {
      app: { type: 'string', description: 'The app to act on by default.' },
      record: { type: 'string', description: 'Write the steps to this file, for a journey.' },
    },
  },
  journey: {
    args: [{ name: 'file', description: 'A JSON file of recorded steps.', required: true }],
    flags: {},
  },
};

const GATE_ARGS = [{ name: 'action', description: 'check (the default), wait, init, pre, post or show.' }];
const GATE_FLAGS = {
  idle: { type: 'number', description: 'How long nobody must have used the Mac, in seconds.', min: 0 },
  'max-min': { type: 'number', description: 'With wait: how many minutes to wait at most.', min: 0 },
};

const AGENT_FLAGS = {
  from: { type: 'string', description: 'With install: the folder to install from.' },
  force: { type: 'boolean', description: 'With install: replace what is installed.' },
  'developer-id': { type: 'boolean', description: 'With build: sign with a Developer ID certificate.' },
  'ad-hoc': { type: 'boolean', description: 'With build: sign ad hoc.' },
  notarize: { type: 'boolean', description: 'With build: notarize the app.' },
  'person-here': { type: 'boolean', description: 'With grant: only with a person at the Mac.' },
};

const GLOBAL_FLAGS = {
  via: { type: 'string', description: "Drive another Mac: the command runs `hackamore wire` there, e.g. 'ssh mini hackamore wire'." },
  as: { type: 'string', description: 'Name the Mac in replies and the screen cache.' },
  kvm: { type: 'string', description: 'Use the pixels of a housesitter KVM for that Mac.' },
};

const commands = declared.map((d) => {
  const extra = LEGACY[d.name === 'gate check' ? 'gate' : d.name] ?? {};
  if (d.name === 'gate check') return defineCommand({ name: 'gate', summary: d.summary, effect: 'private', readOnly: true, args: GATE_ARGS, flags: GATE_FLAGS, output: '{ open, why }' });
  const flags = { ...(d.flags ?? {}), ...(extra.flags ?? {}) };
  for (const f of extra.drop ?? []) delete flags[f];
  return defineCommand({
    name: d.name === 'gate check' ? 'gate' : d.name,
    summary: d.summary,
    effect: d.effect,
    readOnly: d.readOnly,
    args: extra.args ?? d.args,
    flags,
    output: d.output,
  });
});


commands.push(defineCommand({
  name: 'agent',
  summary: 'the resident Ouro Reins Agent that holds the Accessibility grant: is it running, install it, grant it (only with a person at the Mac)',
  effect: 'private',
  args: [{ name: 'action', description: 'status (the default), install, build or grant.' }],
  flags: AGENT_FLAGS,
  output: '{ running, installed, source }',
}));
commands.push(defineCommand({
  name: 'wire',
  protocol: true,
  summary: 'serve one request: read a JSON line from stdin, print the reply line. This is what --via runs on the other Mac',
  effect: 'others',
  flags: {},
  output: '{ code, reply, screen }',
}));

export const cli = defineCli({
  name: 'hackamore',
  about: ['hackamore: drive any Mac app like an API through its accessibility tree.'],
  globalFlags: GLOBAL_FLAGS,
  commands,
});

const KNOWN = new Set(commands.map((c) => c.name));

// Removes --dry-run, which the kit answers itself; --why stays, since the legacy parser passes it to a --via Mac.
function legacyArgv(argv) {
  return argv.filter((t) => t !== '--dry-run');
}

// Returns { handled: false, argv } for commands the kit does not cover or that it runs; { handled: true, exit, plan? }
// once it has answered. `plan` is set for --dry-run: what would run, and who would see it, with nothing sent.
// The flags the commands outside the kit take; a flag not on the list is refused by name.
const LEGACY_FLAGS = {
  help: ['--json'],
};

function refuseUnknownFlag(cmd, argv) {
  const allowed = LEGACY_FLAGS[cmd];
  const bad = argv.slice(1).find((t) => t.startsWith('--') && t !== '--help' && !allowed.includes(t.split('=')[0]));
  if (!bad) return null;
  console.error(`hackamore: ${cmd}: there is no ${bad.split('=')[0]}; its flags are ${allowed.join(', ')}. Fix: hackamore ${cmd} --help`);
  return { handled: true, exit: 2 };
}

// A command other people see needs --why before anything else is checked, so an agent that forgot it is told first.
function refuseMissingWhy(cmd, argv) {
  if (argv.includes('--why') || argv.some((t) => t.startsWith('--why=')) || argv.includes('--dry-run') || argv.includes('--help')) return null;
  console.error(`hackamore: ${cmd}: other people will see this as the person's, so it needs --why: who asked you, and what they said. Fix: hackamore ${cmd} --why "<who asked you, and what they said>" ${PLACE[cmd] ?? ''}`.trimEnd());
  return { handled: true, exit: 2 };
}

const PLACE = { do: '<action>', batch: '<steps>', journey: '<file>', wire: '' };

// A --dry-run answer: what would run, on which target, and who would see it. Nothing is sent or run.
export function planOutcome(name, others) {
  const c = commands.find((x) => x.name === name);
  const summary = `Would run ${name} on the front app, resolved at run time: ${c.summary} Nothing was sent.`
    + (others ? ' Other people will see it if it runs.' : '');
  return outcome({ action: name, state: 'planned', effect: others ? 'others' : 'private', audience: others ? { only: false, who: 'the people in the front app, resolved at run time' } : undefined, summary });
}

const answer = (o, argv) => ({ handled: true, exit: 0, outcome: o, json: argv.includes('--json') });

// Returns { handled: false, argv } for commands the kit does not cover or runs; { handled: true, exit, outcome?, json? }
// once it has answered. A --dry-run answers with a planned outcome, even when no target was named yet.
export function checkArgv(argv) {
  const [cmd] = argv;
  if (cmd && LEGACY_FLAGS[cmd]) { const r = refuseUnknownFlag(cmd, argv); if (r) return r; }
  if (!cmd || !KNOWN.has(cmd)) return { handled: false, argv };
  const others = commands.find((c) => c.name === cmd)?.effect === 'others';
  if (others) { const r = refuseMissingWhy(cmd, argv); if (r) return r; }
  const dry = argv.includes('--dry-run');
  try {
    const parsed = parse(cli, argv);
    if (parsed.kind !== 'run') return { handled: false, argv };
    if (dry) return answer(planOutcome(cmd, others), argv);
    return { handled: false, argv: legacyArgv(argv) };
  } catch (e) {
    if (!isAxError(e)) throw e;
    if (dry && /needs <[^>]+>/.test(e.message)) return answer(planOutcome(cmd, others), argv);
    console.error(errorLine('hackamore', e.shape));
    return { handled: true, exit: e.exit };
  }
}
