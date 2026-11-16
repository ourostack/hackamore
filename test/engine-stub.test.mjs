// The engine stub is honored only with the X-ray guard's marker in an isolated home, and only as an absolute, executable,
// regular file; with it, the CLI sends the stub exactly the request it declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubEngineBin, XRAY_MARKER, Engine } from '../src/ax.mjs';

const STUB = fileURLToPath(new URL('./fixtures/engine-stub.mjs', import.meta.url));
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-stub-home-'));
const guarded = () => { const h = home(); fs.writeFileSync(path.join(h, XRAY_MARKER), 'ok'); return h; };
const withStub = (value) => ({ HACKAMORE_ENGINE_STUB: value });

test('the stub is unset by default, so a normal run never consults it', () => {
  assert.equal(stubEngineBin({ env: {}, home: home() }), null);
});

test('the stub is refused in a home the X-ray guard has not marked', () => {
  assert.throws(() => stubEngineBin({ env: withStub(STUB), home: home() }), /no X-ray guard marker/);
});

test('the stub is refused unless it is an absolute path', () => {
  assert.throws(() => stubEngineBin({ env: withStub('engine-stub.mjs'), home: guarded() }), /not an absolute path/);
});

test('the stub is refused when it is not executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-stub-file-'));
  const file = path.join(dir, 'engine');
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o644);
  assert.throws(() => stubEngineBin({ env: withStub(file), home: guarded() }), /is not executable/);
});

test('the stub is refused when it is a symlink, even to an executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-stub-link-'));
  const link = path.join(dir, 'engine');
  fs.symlinkSync(STUB, link);
  assert.throws(() => stubEngineBin({ env: withStub(link), home: guarded() }), /is a symlink/);
});

test('the stub is refused when it is missing or a folder', () => {
  assert.throws(() => stubEngineBin({ env: withStub('/nonexistent/engine'), home: guarded() }), /does not exist/);
  assert.throws(() => stubEngineBin({ env: withStub(os.tmpdir()), home: guarded() }), /is not a regular file/);
});

test('with the marker and an executable file, the stub is the engine and receives exactly the declared request', async () => {
  const h = guarded();
  const bin = stubEngineBin({ env: withStub(STUB), home: h });
  assert.equal(bin, STUB);
  const prevHome = process.env.HOME;
  process.env.HOME = h;
  const engine = new Engine(bin);
  try {
    const reply = await engine.req('ls', { app: 'Fixture' }, 5000);
    assert.equal(reply.ok, true);
    const received = fs.readFileSync(path.join(h, 'engine-stub-received.jsonl'), 'utf8').trim().split('\n');
    assert.deepEqual(received, [JSON.stringify({ id: 1, op: 'ls', app: 'Fixture' })]);
  } finally {
    engine.stop();
    process.env.HOME = prevHome;
  }
});
