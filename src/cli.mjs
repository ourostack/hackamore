// The hackamore command line: ls, do, batch and journey drive an app; wire carries them for another Mac; gate, agent and
// doctor look after the Mac that holds the grant. Replies are JSON (Reins' shape); help is text, and `help --json` is
// the same table for a machine. Exit codes: 0 ok, 1 failed, 2 refused or a bad request (the reply says which).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as A from './ax.mjs';
import * as G from './gate.mjs';

export const EXIT_CODES = [
  { code: 0, name: 'ok', meaning: 'it ran, or the screen was read' },
  { code: 1, name: 'failed', meaning: 'it was allowed but did not work (action-failed, until-not-met), or something here is broken' },
  { code: 2, name: 'refused', meaning: 'nothing ran: action-unavailable, input-invalid, person-active, app-protected, screen-locked, permission-missing, or a malformed command line' },
];

export const COMMANDS = [
  { name: 'ls', args: '[app] [--layer auto|ax|pixels] [--no-menus] [--diff]', summary: "read the screen: the front app (or [app]) as elements, plus the actions that make sense on it right now, each with a schema narrowed to what is there", example: 'hackamore ls Finder', effect: 'none' },
  { name: 'do', args: "<action> ['<json input>'] [--app A] [--idle 90] [--record <file>] [--diff]", summary: 'run one action (click, set_value, type_text, press_key, menu, scroll, perform, open_app, activate, type_secret) and get the screen after it', example: `hackamore do click '{"element":"button[Back]"}'`, effect: 'changes the app on the Mac, when nobody is using it' },
  { name: 'batch', args: "'<json array of {action,input,until?,app?}>' [--app A] [--record <file>]", summary: 'many steps in one call; a step\'s until ({"@field.value":"42"}) is checked on the Mac, and the run stops at the first refusal or unmet until', example: `hackamore batch '[{"action":"click","input":{"element":"button[7]"}}]'`, effect: 'as do, for each step' },
  { name: 'journey', args: '<file>', summary: 'replay a journey recorded with --record as one batch', example: 'hackamore journey form.json', effect: 'as batch' },
  { name: 'wire', args: '', summary: 'serve one request: read a JSON line from stdin, print the reply line. This is what --via runs on the other Mac', example: `echo '{"cmd":"ls"}' | hackamore wire`, effect: 'as the request asks' },
  { name: 'gate', args: '[check|wait] [--idle 90] [--max-min 30] [--json]', summary: 'may an agent touch this screen now: unlocked, and nobody has used it for the idle time', example: 'hackamore gate check', effect: 'none' },
  { name: 'agent', args: 'status|install|build|grant [--person-here]', summary: 'the resident Ouro Reins Agent that holds the Accessibility grant: is it running, install it, grant it (only with a person at the Mac)', example: 'hackamore agent status', effect: 'install and grant change this Mac' },
  { name: 'doctor', args: '', summary: 'what this Mac has: the agent, the grant, the gate, the config, the protected apps, and the next step if something is missing', example: 'hackamore doctor', effect: 'none' },
  { name: 'help', args: '[--json]', summary: 'this list', example: 'hackamore help --json', effect: 'none' },
];

export const GLOBAL_FLAGS = [
  { flag: '--via <command>', meaning: "drive another Mac: the command runs `hackamore wire` there, e.g. 'ssh mini hackamore wire'" },
  { flag: '--as <label>', meaning: 'name the Mac in replies and the screen cache (default: local, or a short hash of --via)' },
  { flag: '--kvm <name>', meaning: "use the pixels of a housesitter KVM for that Mac (needs @ouro.bot/housesitter)" },
];

export function helpText() {
  const w = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'hackamore: drive any Mac app like an API through its accessibility tree. Replies are JSON; nothing is typed or clicked on a screen a person is using.',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  hackamore ${c.name.padEnd(w)}  ${c.summary}`),
    '',
    'Start with `hackamore ls` (read) then `hackamore do <action> \'<json>\'`; every ls reply lists the actions and the exact values each accepts. `hackamore doctor` says what is missing.',
    '',
    'Flags for ls, do, batch and journey:',
    ...GLOBAL_FLAGS.map((f) => `  ${f.flag}  ${f.meaning}`),
    '',
    'Exit codes:',
    ...EXIT_CODES.map((e) => `  ${e.code}  ${e.name}: ${e.meaning}`),
    '',
    'Examples:',
    ...COMMANDS.filter((c) => c.example).map((c) => `  ${c.example}`),
  ].join('\n');
}

export const helpJson = () => ({ tool: 'hackamore', commands: COMMANDS, flags: GLOBAL_FLAGS, exit_codes: EXIT_CODES });

async function doctor() {
  const AG = await import('./agent.mjs');
  const st = await AG.status();
  const cfg = (await import('./config.mjs')).loadConfig();
  const gm = G.readMachine();
  const gate = G.verdict(gm);
  const E = await A.engine();
  const trust = await E.req('trust', {}, 3000);
  E.stop?.();
  const next = [];
  if (!trust.ax) next.push(st.running ? 'a person turns on "Ouro Reins Agent" in System Settings > Privacy & Security > Accessibility: hackamore agent grant --person-here' : 'hackamore agent install, then grant it with a person at the Mac');
  else if (!st.running) next.push('the engine works from this shell; hackamore agent install makes it resident and gives it its own grant');
  return {
    ok: Boolean(trust.ax),
    engine: E.kind || 'child',
    accessibility: Boolean(trust.ax),
    screen_capture: Boolean(trust.screen_capture),
    agent: { running: st.running, installed: st.installed, source: st.source },
    gate: { open: gate.open, why: gate.why },
    config: { protected_extra: cfg.protected.length, secrets: cfg.secrets.length, prompt_decisions: cfg.prompt_decisions.length, clients_extra: cfg.clients.length },
    protected: A.PROTECTED.map((p) => p.name),
    next,
  };
}

export async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

export async function main(argv, { print = (o) => console.log(JSON.stringify(o, null, 2)), stdin = readStdin } = {}) {
  const [cmd = 'help', ...rest] = argv;
  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') { if (rest.includes('--json')) print(helpJson()); else console.log(helpText()); return 0; }
    if (cmd === '--version' || cmd === 'version') { console.log(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version); return 0; }
    if (cmd === 'ls' || cmd === 'do' || cmd === 'batch') return await A.cmdUiReins(cmd, rest, { print });
    if (cmd === 'journey') {
      const f = rest.find((a) => !a.startsWith('--'));
      if (!f) throw new Error('usage: hackamore journey <file> [--via <command>] [--as <label>]');
      let steps;
      try { steps = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { print({ ok: false, error: { code: 'input-invalid', exit: 2, thing: 'journey', problem: `${f} isn't a journey file (a JSON array of steps): ${e.message}`, fix: 'record one with: hackamore do <action> \'<json>\' --record <file>' } }); return 2; }
      return await A.cmdUiReins('batch', [JSON.stringify(steps), ...rest.filter((a) => a !== f)], { print });
    }
    if (cmd === 'wire') {
      const line = (await stdin()).split('\n').find((l) => l.trim());
      let a;
      try { a = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ code: 2, reply: { ok: false, refused: 'input-invalid', path: '$', message: 'wire reads one JSON request line on stdin' } }) + '\n'); return 2; }
      const r = await A.busHandler(a);
      process.stdout.write(r.stdout);
      return r.exit;
    }
    if (cmd === 'gate') return await G.main(rest.length ? rest : ['check']);
    if (cmd === 'agent') return await (await import('./agent.mjs')).main(rest);
    if (cmd === 'doctor') { const d = await doctor(); print(d); return d.ok ? 0 : 1; }
    throw new Error(`usage: unknown command "${cmd}". Fix: hackamore help`);
  } catch (e) {
    const usage = /^usage:/.test(e.message);
    console.error(usage ? `hackamore: ${e.message.replace(/^usage:\s*/, '')}` : `hackamore: ${e.message}`);
    return usage ? 2 : 1;
  }
}
