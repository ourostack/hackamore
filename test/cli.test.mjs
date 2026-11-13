// What hackamore adds around the engine: the owner's config, the shared schema check, transports, the CLI's help and exit codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { normalize, loadConfig } = await import(path.join(ROOT, 'src/config.mjs'));
const { validate, holds } = await import(path.join(ROOT, 'src/validate.mjs'));
const A = await import(path.join(ROOT, 'src/ax.mjs'));
const CLI = await import(path.join(ROOT, 'src/cli.mjs'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-cli-'));

test('config: only well-formed entries count, and inline JSON wins over the file', () => {
  const c = normalize({ protected: [{ match: '^com\\.x', name: 'X' }, { name: 'no match' }, null], secrets: ['a', 7], prompt_decisions: [{ prompt: 'p', button: 'Allow' }, { prompt: 'q' }], clients: ['t'] });
  assert.deepEqual(c.protected, [{ match: '^com\\.x', name: 'X', read: false, why: 'its owner asked agents to leave it alone' }]);
  assert.deepEqual(c.secrets, ['a', '7']);
  assert.equal(c.prompt_decisions.length, 1);
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ secrets: ['from-file'] }));
  assert.deepEqual(loadConfig({ env: {}, file }).secrets, ['from-file']);
  assert.deepEqual(loadConfig({ env: { HACKAMORE_CONFIG_JSON: '{"secrets":["inline"]}' }, file }).secrets, ['inline']);
  assert.deepEqual(loadConfig({ env: {}, file: path.join(tmp(), 'missing.json') }).protected, [], 'no file is no config');
});

test('protected apps: the defaults hold with no config, and a config adds to them', () => {
  const names = A.protectedApps(normalize({})).map((p) => p.name);
  assert.deepEqual(names, ['SecurityAgent', 'Keychain Access', 'Passwords', 'Okta Verify']);
  const more = A.protectedApps(normalize({ protected: [{ match: '^com\\.acme\\.vault$', name: 'Acme Vault', read: true, why: 'its policy' }] }));
  assert.equal(more.at(-1).match.test('com.acme.vault'), true);
  assert.equal(more.find((p) => p.name === 'Keychain Access').read, false);
});

test('schema: arrays and bounds are checked with the path of the bad value', () => {
  const s = { type: 'object', required: ['coordinate'], additionalProperties: false, properties: { coordinate: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0 } } } };
  assert.equal(validate(s, { coordinate: [1, 2] }), null);
  assert.equal(validate(s, { coordinate: [1] }).path, '$.coordinate');
  assert.equal(validate(s, { coordinate: [1, -2] }).path, '$.coordinate[1]');
  assert.equal(validate(s, {}).path, '$.coordinate');
  assert.match(validate(s, { coordinate: [1, 2], x: 1 }).message, /not an input of this action/);
  assert.equal(holds({ 'state.n': 2 }, { state: { n: 2 } }), true);
});

test('transport: a command carries one request line in and one reply line out, and says why when it cannot', async () => {
  const reply = JSON.stringify({ code: 0, reply: { ok: true }, screen: null, ms: 1 });
  const ok = await A.commandTransport(`cat >/dev/null; echo '${reply}'`)({ cmd: 'ls' });
  assert.equal(ok.ok, true);
  assert.equal(A.lastJsonLine(ok.stdout).code, 0);
  const echoed = await A.commandTransport('cat')({ cmd: 'ls', app: 'Finder' });
  assert.deepEqual(A.lastJsonLine(echoed.stdout), { cmd: 'ls', app: 'Finder' }, 'the request is JSON on stdin');
  const bad = await A.commandTransport('echo nope >&2; exit 3')({ cmd: 'ls' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /nope/);
  const slow = await A.commandTransport('sleep 5')({ cmd: 'ls' }, { timeoutMs: 100 });
  assert.match(slow.message, /no reply within 100 ms/);
});

test('callUi: a transport that gives no reply is an action-failed reply, not an exception', async () => {
  const r = await A.callUi('far', { cmd: 'ls' }, { transport: async () => ({ ok: false, exit: 255, stdout: '', message: 'ssh: no route' }), dir: tmp() });
  assert.equal(r.exit, 255);
  assert.equal(r.reply.failed, 'action-failed');
  assert.match(r.reply.message, /no route/);
});

test('journeys: --record appends steps to a JSON file that `journey` replays', () => {
  const f = path.join(tmp(), 'j.json');
  A.recordStep(f, { action: 'click', input: { element: 'button[7]' } });
  const r = A.recordStep(f, { action: 'press_key', input: { key: 'return' }, until: { focus: 'Calculator' } });
  assert.equal(r.steps, 2);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8'))[1].until.focus, 'Calculator');
});

test('cli: help lists every command and the exit codes, and help --json is the same table', async () => {
  const text = CLI.helpText();
  for (const c of CLI.COMMANDS) assert.match(text, new RegExp(`hackamore ${c.name}\\b`));
  assert.match(text, /2 {2}refused/);
  let printed;
  assert.equal(await CLI.main(['help', '--json'], { print: (o) => { printed = o; } }), 0);
  assert.deepEqual(printed.commands.map((c) => c.name), CLI.COMMANDS.map((c) => c.name));
  assert.deepEqual(printed.exit_codes.map((e) => e.code), [0, 1, 2]);
});

test('cli: an unknown command is exit 2 with the fix, and bad JSON input is refused before anything runs', () => {
  const run = (args, input) => spawnSync(process.execPath, [path.join(ROOT, 'bin/hackamore.mjs'), ...args], { encoding: 'utf8', input });
  const u = run(['frobnicate']);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /unknown command "frobnicate"\. Fix: hackamore help/);
  const j = run(['do', 'click', '{nope']);
  assert.equal(j.status, 2);
  assert.equal(JSON.parse(j.stdout).refused, 'input-invalid');
  const w = run(['wire'], 'not json\n');
  assert.equal(w.status, 2);
  assert.equal(JSON.parse(w.stdout).reply.refused, 'input-invalid');
});
