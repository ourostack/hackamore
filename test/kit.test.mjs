// The kit answers in front of the CLI: an unknown flag and a missing --why are refused before anything runs, a
// dry run plans without sending, and a --via Mac gets the person's --why with its request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { cli } from '../src/kit.mjs';
import { main } from '../src/cli.mjs';
import { commandTransport } from '../src/ax.mjs';

const noStdin = async () => { throw new Error('stdin must not be read'); };

test('wire without --why refuses with the fix, and never reads its request', async () => {
  const lines = [];
  const exit = await main(['wire'], { print: (o) => lines.push(o), stdin: noStdin });
  assert.equal(exit, 2);
  assert.deepEqual(lines, []);
});

test('wire --dry-run plans without reading its request or acting', async () => {
  const printed = [];
  const exit = await main(['wire', '--why', 'asked', '--dry-run', '--json'], { print: (o) => printed.push(o), stdin: noStdin });
  assert.equal(exit, 0);
  assert.equal(printed[0].ax, 'outcome/1');
  assert.equal(printed[0].state, 'planned');
  assert.equal(printed[0].action, 'wire');
  assert.match(printed[0].summary, /Other people will see it/);
});

test('an unknown flag on a declared command is refused before anything runs', async () => {
  assert.equal(await main(['ls', '--no-such-flag']), 2);
});

const input = (...argv) => parse(cli, argv).input;

test('optional words are positional: ls takes an app, do an input, gate and agent an action', () => {
  assert.deepEqual(input('ls', 'Notes'), { app: 'Notes' });
  assert.deepEqual(input('do', 'click', '{"a":1}', '--why', 'Jo asked'), { action: 'click', inputJson: '{"a":1}', why: 'Jo asked' });
  assert.deepEqual(input('do', 'click', '--why', 'Jo asked'), { action: 'click', why: 'Jo asked' });
  assert.deepEqual(input('gate', 'wait'), { action: 'wait' });
  assert.deepEqual(input('agent', 'grant'), { action: 'grant' });
  // The word is no longer a flag: --app and --input-json are refused, and a word spelt as a flag gets the word as its fix.
  assert.throws(() => input('ls', '--app', 'Notes'), /there is no --app/);
  assert.throws(() => input('do', 'click', '--why', 'Jo asked', '--input-json', '{}'), /there is no --input-json/);
  assert.throws(() => input('agent', '--install'), /"install" is a word for <action>/);
});

test('every command parses its words and flags into the input the dispatcher reads', () => {
  assert.deepEqual(input('ls'), {});
  assert.deepEqual(input('ls', 'Finder', '--layer', 'pixels', '--no-menus', '--diff', '--as', 'far'), { app: 'Finder', layer: 'pixels', 'no-menus': true, diff: true, as: 'far' });
  assert.deepEqual(input('do', 'click', '{"a":1}', '--why', 'Jo asked', '--app', 'Finder', '--idle', '5', '--record', 'j.json', '--diff', '--via', 'ssh mini hackamore wire', '--kvm', 'mini'),
    { action: 'click', inputJson: '{"a":1}', why: 'Jo asked', app: 'Finder', idle: 5, record: 'j.json', diff: true, via: 'ssh mini hackamore wire', kvm: 'mini' });
  assert.deepEqual(input('batch', '[]', '--why', 'a', '--app', 'Mail', '--idle', '0', '--record', 'b.json', '--diff'), { steps: '[]', why: 'a', app: 'Mail', idle: 0, record: 'b.json', diff: true });
  assert.deepEqual(input('journey', 'j.json', '--why', 'a', '--as', 'far'), { file: 'j.json', why: 'a', as: 'far' });
  assert.deepEqual(input('wire', '--why', 'a'), { why: 'a' });
  assert.deepEqual(input('gate'), {});
  assert.deepEqual(input('gate', 'wait', '--idle', '60', '--max-min', '5'), { action: 'wait', idle: 60, 'max-min': 5 });
  assert.deepEqual(input('agent', 'install', '--from', '/x', '--force'), { action: 'install', from: '/x', force: true });
  assert.deepEqual(input('agent', 'build', '--developer-id', '--notarize'), { action: 'build', 'developer-id': true, notarize: true });
  assert.deepEqual(input('agent', 'grant', '--person-here'), { action: 'grant', 'person-here': true });
  assert.deepEqual(input('doctor'), {});
});

test('a command other people see needs --why, and a read does not', async () => {
  assert.equal(await main(['do', 'click']), 2);
  assert.equal(await main(['wire']), 2);
  assert.equal(parse(cli, ['do', 'click', '--why', 'Jo asked']).input.why, 'Jo asked');
});

test('edit, delete and remove answer with the commands to run instead', async () => {
  for (const verb of ['edit', 'delete', 'remove']) assert.equal(await main([verb]), 2);
});

test('--via forwards the person\'s --why to the other Mac\'s wire, quoted for the shell', async () => {
  const commands = [];
  const spawnFn = (_sh, args) => {
    commands.push(args[1]);
    const handlers = {};
    const proc = { stdout: { on() {} }, stderr: { on() {} }, stdin: { on() {}, end() {} }, kill() {}, on(ev, f) { handlers[ev] = f; if (ev === 'close') setImmediate(() => f(0)); } };
    return proc;
  };
  await commandTransport('ssh mini hackamore wire', { spawnFn, why: "Jo's ask" })({ cmd: 'do' });
  assert.deepEqual(commands, ["ssh mini hackamore wire --why 'Jo'\\''s ask'"]);
});
