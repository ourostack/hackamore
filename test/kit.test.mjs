// The kit answers in front of the CLI: an unknown flag and a missing --why are refused before anything runs, a
// dry run plans without sending, and a --via Mac gets the person's --why with its request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArgv } from '../src/kit.mjs';
import { main } from '../src/cli.mjs';
import { commandTransport, parseUiArgs } from '../src/ax.mjs';

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

test('an unknown flag on a declared command is refused before anything runs', () => {
  const r = checkArgv(['ls', '--no-such-flag']);
  assert.equal(r.handled, true);
  assert.equal(r.exit, 2);
});

test('a command other people see keeps --why for the legacy parser, and a read passes through', () => {
  assert.equal(checkArgv(['do', 'click', '--why', 'Jo asked']).handled, false);
  assert.deepEqual(checkArgv(['do', 'click', '--why', 'Jo asked']).argv, ['do', 'click', '--why', 'Jo asked']);
  assert.deepEqual(parseUiArgs(['click', '--why', 'Jo asked']).pos, ['click']);
  assert.equal(parseUiArgs(['click', '--why', 'Jo asked']).why, 'Jo asked');
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
