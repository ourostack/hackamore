// The hackamore command line: ls, do, batch and journey drive an app; wire carries them for another Mac; gate, agent and
// doctor look after the Mac that holds the grant. The commands, flags and help are the kit's (src/kit.mjs); replies are
// JSON (Reins' shape). Exit codes: 0 ok, 1 failed, 2 refused or a bad request (the reply says which).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as A from './ax.mjs';
import * as G from './gate.mjs';
import { cli, COMMAND_NAMES, planOutcome } from './kit.mjs';
import { parse } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { runCli } from '../lib/ouro-ui/registry/ouro/ax/cli.ts';
import { isAxError } from '../lib/ouro-ui/registry/ouro/ax/problem.ts';
import { outcome, outcomeText } from '../lib/ouro-ui/registry/ouro/ax/outcome.ts';

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
    config: { protected_extra: cfg.protected.length, secrets: cfg.secrets.length, secret_rules: cfg.secret_rules.length, prompt_decisions: cfg.prompt_decisions.length, clients_extra: cfg.clients.length },
    protected: A.PROTECTED.map((p) => p.name),
    next,
  };
}

export async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

const kitIo = () => ({ stdout: process.stdout, stderr: process.stderr });

export async function main(argv, { print: out = (o) => console.log(JSON.stringify(o, null, process.stdout.isTTY ? 2 : undefined)), stdin = readStdin } = {}) {
  // A refused or failed reply also names its problem and fix on stderr, where a caller that watches the error stream looks.
  const print = (o) => { out(o); if (o && o.ok === false) { const e = o.error; const m = e?.message || (e?.problem && `${e.problem}. Fix: ${e.fix}`) || o.message; if (m) console.error(`hackamore: ${m}`); } };
  if (argv[0] === '--version' || argv[0] === 'version') { console.log(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version); return 0; }
  const args = argv.length ? argv : ['help'];
  let parsed;
  try {
    parsed = parse(cli, args);
  } catch (e) {
    if (!isAxError(e)) throw e;
    // A --dry-run answers with a plan even when the target is not named yet.
    if (args.includes('--dry-run') && e.shape.code === 'missing-arg' && COMMAND_NAMES.includes(args[0])) return plan(args[0], args, print);
    return runCli(cli, args, kitIo());
  }
  if (parsed.kind === 'help') return runCli(cli, args, kitIo());
  const { input } = parsed;
  const name = parsed.command.name;
  if (input['dry-run'] === true) return plan(name, args, print);
  try {
    if (name === 'ls' || name === 'do' || name === 'batch') return await A.cmdUiReins(name, input, { print });
    if (name === 'journey') {
      let steps;
      try { steps = JSON.parse(fs.readFileSync(input.file, 'utf8')); } catch (e) { print({ ok: false, error: { code: 'input-invalid', exit: 2, thing: 'journey', problem: `${input.file} isn't a journey file (a JSON array of steps): ${e.message}`, fix: 'record one with: hackamore do <action> \'<json>\' --record <file>' } }); return 2; }
      return await A.cmdUiReins('batch', { ...input, steps: JSON.stringify(steps) }, { print });
    }
    if (name === 'wire') {
      const line = (await stdin()).split('\n').find((l) => l.trim());
      let a;
      try { a = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ code: 2, reply: { ok: false, refused: 'input-invalid', path: '$', message: 'wire reads one JSON request line on stdin' } }) + '\n'); console.error('hackamore: wire: the request on stdin isn\'t JSON. Fix: send one JSON line, such as {"cmd":"ls"}'); return 2; }
      const r = await A.busHandler(a);
      process.stdout.write(r.stdout);
      if (r.exit !== 0) console.error(`hackamore: wire: ${a.cmd || 'the request'} did not run. Fix: send a request that hackamore help --json lists`);
      return r.exit;
    }
    if (name === 'gate' && parsed.json && (input.action === undefined || input.action === 'check')) {
      const v = G.verdict(G.readMachine());
      const o = outcome({ action: 'gate check', state: 'done', summary: v.open ? 'The screen is open to an agent now: it is unlocked and nobody has used it for the idle time.' : `The screen is shut to an agent now: ${v.why}.` });
      print({ ...o, open: v.open, why: v.why });
      return 0;
    }
    if (name === 'agent' && parsed.json && (input.action === undefined || input.action === 'status')) {
      const AG = await import('./agent.mjs');
      const st = await AG.status();
      print({ ...outcome({ action: 'agent status', state: 'done', summary: st.running ? 'The resident Ouro Reins Agent is running.' : 'The resident Ouro Reins Agent is not running. Fix: hackamore agent install' }), running: st.running, installed: st.installed, source: st.source });
      return 0;
    }
    if (name === 'gate') return await G.main({ ...input, json: parsed.json });
    if (name === 'agent') return await (await import('./agent.mjs')).main(input);
    if (name === 'doctor') { const d = await doctor(); print(d); return d.ok ? 0 : 1; }
    throw new Error(`usage: unknown command "${name}". Fix: hackamore help`);
  } catch (e) {
    const usage = /^usage:/.test(e.message);
    console.error(usage ? `hackamore: ${e.message.replace(/^usage:\s*/, '')}` : `hackamore: ${e.message}`);
    return usage ? 2 : 1;
  }
}

function plan(name, args, print) {
  const o = planOutcome(name);
  if (args.includes('--json')) print(o); else console.log(outcomeText(o, 'hackamore'));
  return 0;
}
