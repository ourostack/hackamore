// Notarization: which credentials it uses, that it only accepts an "Accepted" verdict, and that secrets stay out of errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { notaryAuth, notarize } = await import(path.join(ROOT, 'src/agent.mjs'));

test('notaryAuth: an API key wins over an Apple ID, and nothing is a null', () => {
  const key = { APPLE_API_KEY_PATH: '/k.p8', APPLE_API_KEY_ID: 'KID', APPLE_API_ISSUER: 'ISS' };
  const id = { APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' };
  assert.deepEqual(notaryAuth({ ...key, ...id }), ['--key', '/k.p8', '--key-id', 'KID', '--issuer', 'ISS']);
  assert.deepEqual(notaryAuth(id), ['--apple-id', 'a@example.com', '--team-id', 'TEAM', '--password', 'pw']);
  assert.equal(notaryAuth({ APPLE_ID: 'a@example.com' }), null);
});

test('notarize: zips, submits with the credentials, staples only an Accepted verdict', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'notarytool') return { status: 0, stdout: JSON.stringify({ id: 'sub-1', status: 'Accepted' }) };
    return { status: 0, stdout: '', stderr: '' };
  };
  const env = { APPLE_API_KEY_PATH: '/k.p8', APPLE_API_KEY_ID: 'KID', APPLE_API_ISSUER: 'ISS' };
  assert.deepEqual(notarize('/x/App.app', { run, env }), { ok: true, id: 'sub-1' });
  assert.equal(calls[0][0], '/usr/bin/ditto');
  assert.ok(calls[1].includes('--key-id') && calls[1].includes('--wait'));
  assert.deepEqual(calls[2], ['/usr/bin/xcrun', 'stapler', 'staple', '/x/App.app']);
  const rejected = (cmd, args) => (args[0] === 'notarytool' ? { status: 0, stdout: JSON.stringify({ status: 'Invalid' }) } : { status: 0 });
  assert.throws(() => notarize('/x/App.app', { run: rejected, env }), /notarization Invalid/);
  assert.throws(() => notarize('/x/App.app', { run, env: {} }), /APPLE_API_KEY_PATH/);
});

const env = { APPLE_API_KEY_PATH: '/k.p8', APPLE_API_KEY_ID: 'KID', APPLE_API_ISSUER: 'ISS' };
const fake = (submit) => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'notarytool' && args[1] === 'submit') return submit(calls.filter((c) => c === 'notarytool submit').length);
    if (args[0] === 'notarytool' && args[1] === 'log') return { status: 0, stdout: '{\n"issues": [{"message": "The binary is not signed with a valid Developer ID certificate."}]\n}' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
};

test('notarize: no verdict retries with backoff, then fails saying what happened and what to do', () => {
  const { run, calls } = fake(() => ({ status: 1, stdout: '', stderr: 'Error: network connection was lost' }));
  const waits = [];
  assert.throws(() => notarize('/x/App.app', { run, env, sleep: (ms) => waits.push(ms) }), (e) => /no verdict from Apple/.test(e.message) && /exit 1/.test(e.message) && /network connection was lost/.test(e.message) && /tried 4 times/.test(e.message) && /Fix:/.test(e.message));
  assert.equal(calls.filter((c) => c === 'notarytool submit').length, 4);
  assert.deepEqual(waits, [5000, 15000, 45000]);
});

test('notarize: a transient failure that recovers is accepted', () => {
  const { run } = fake((n) => (n < 3 ? { status: 1, stdout: '', stderr: 'HTTP 503' } : { status: 0, stdout: JSON.stringify({ id: 's2', status: 'Accepted' }) }));
  assert.deepEqual(notarize('/x/App.app', { run, env, sleep: () => {} }), { ok: true, id: 's2' });
});

test('notarize: Invalid includes Apple\'s log and is never retried', () => {
  const { run, calls } = fake(() => ({ status: 0, stdout: JSON.stringify({ id: 'bad-1', status: 'Invalid' }) }));
  assert.throws(() => notarize('/x/App.app', { run, env, sleep: () => assert.fail('slept') }), (e) => /Invalid/.test(e.message) && /bad-1/.test(e.message) && /not signed with a valid Developer ID/.test(e.message) && /notarytool log bad-1/.test(e.message));
  assert.equal(calls.filter((c) => c === 'notarytool submit').length, 1);
});

test('notarize: refused credentials are not retried', () => {
  const { run, calls } = fake(() => ({ status: 1, stdout: '', stderr: 'Error: HTTP status code: 401. Invalid credentials' }));
  assert.throws(() => notarize('/x/App.app', { run, env, sleep: () => {} }), /refused the credentials/);
  assert.equal(calls.filter((c) => c === 'notarytool submit').length, 1);
});
