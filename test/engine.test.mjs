// The Swift engine, compiled and run for real: it must build and answer `trust` and `apps` without any permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform !== 'darwin' ? 'macOS only' : false;

test('the engine compiles and answers trust and apps', { skip, timeout: 300000 }, async () => {
  const { engineBin, Engine } = await import(path.join(ROOT, 'src/ax.mjs'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-engine-'));
  const bin = await engineBin({ cache });
  const e = new Engine(bin);
  try {
    const t = await e.req('trust', {}, 10000);
    assert.equal(t.ok, true);
    assert.equal(typeof t.ax, 'boolean', 'it reports the grant without ever asking for it');
    const a = await e.req('apps', {}, 10000);
    assert.equal(a.ok, true);
    assert.ok(Array.isArray(a.apps));
  } finally { e.stop(); }
});

test('the agent builds ad-hoc into a bundle whose manifest matches its archive', { skip, timeout: 300000 }, async () => {
  const { build, TGZ_NAME, MANIFEST_NAME, LABEL } = await import(path.join(ROOT, 'src/agent.mjs'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-agent-'));
  const r = build({ out, developerId: false });
  assert.equal(r.signed, 'ad-hoc');
  const m = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_NAME), 'utf8'));
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(out, TGZ_NAME))).digest('hex'), m.sha256);
  const x = fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-unpack-'));
  assert.equal(spawnSync('/usr/bin/tar', ['-xzf', path.join(out, TGZ_NAME), '-C', x]).status, 0);
  const v = spawnSync('/usr/bin/codesign', ['-dv', path.join(x, 'Ouro Reins Agent.app')], { encoding: 'utf8' });
  assert.match(v.stderr, new RegExp(`Identifier=${LABEL.replace(/\./g, '\\.')}`));
});
