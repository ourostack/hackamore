// The Ouro AX kit in front of the CLI: the agent-facing commands are declared in actions/hackamore.actions.mts and
// generated into actions/generated/commands.json. The generator can't express positional arguments or the legacy
// flags, so they are added here; the kit's parse refuses an unknown flag and a missing --why, and answers --dry-run
// with a plan. Commands the declarations don't cover yet pass through the legacy dispatcher unchanged.
import { readFileSync } from 'node:fs';
import { defineCli, defineCommand, parse } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { errorLine, isAxError } from '../lib/ouro-ui/registry/ouro/ax/problem.ts';

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

const GLOBAL_FLAGS = {
  via: { type: 'string', description: "Drive another Mac: the command runs `hackamore wire` there, e.g. 'ssh mini hackamore wire'." },
  as: { type: 'string', description: 'Name the Mac in replies and the screen cache.' },
  kvm: { type: 'string', description: 'Use the pixels of a housesitter KVM for that Mac.' },
};

const commands = declared.map((d) => {
  const extra = LEGACY[d.name === 'gate check' ? 'gate' : d.name] ?? {};
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
    loose: d.name === 'gate check' ? true : undefined,
  });
});


commands.push(defineCommand({
  name: 'wire',
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
  agent: ['--from', '--force', '--developer-id', '--ad-hoc', '--notarize', '--person-here', '--json'],
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

export function checkArgv(argv) {
  const [cmd] = argv;
  if (cmd && LEGACY_FLAGS[cmd]) { const r = refuseUnknownFlag(cmd, argv); if (r) return r; }
  if (!cmd || !KNOWN.has(cmd)) return { handled: false, argv };
  if (commands.find((c) => c.name === cmd)?.effect === 'others') { const r = refuseMissingWhy(cmd, argv); if (r) return r; }
  try {
    const parsed = parse(cli, argv);
    if (parsed.kind !== 'run') return { handled: false, argv };
    const dry = parsed.input['dry-run'] === true || argv.includes('--dry-run');
    if (dry) {
      const others = parsed.command.effect === 'others';
      return { handled: true, exit: 0, plan: { state: 'planned', command: parsed.command.name, summary: `Would run ${parsed.command.name}${others ? '; other people will see it, as the person' : ''}. Nothing was sent.` } };
    }
    return { handled: false, argv: legacyArgv(argv) };
  } catch (e) {
    if (!isAxError(e)) throw e;
    console.error(errorLine('hackamore', e.shape));
    return { handled: true, exit: e.exit };
  }
}
