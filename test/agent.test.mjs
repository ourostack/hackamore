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
