// The vendored ouro-actions generator is the core release it names, and the generated projections are current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sha = (path) => crypto.createHash('sha256').update(fs.readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex');
const manifest = JSON.parse(fs.readFileSync(new URL('../tools/ouro-actions/dist-manifest.json', import.meta.url), 'utf8'));
// Node runs the generator's .mts as it is from 22.18 on; older Node skips these, and the Linux job runs them.
const typeStripping = Boolean(process.features.typescript);

test('the vendored generator and claim set match the core release in dist-manifest.json', { skip: !typeStripping }, () => {
  assert.match(manifest.coreTag, /^v\d+\.\d+\.\d+$/);
  assert.equal(sha('tools/ouro-actions/ouro-actions.mts'), manifest.files['dist/actions/ouro-actions.mts']);
  assert.equal(sha('tools/ouro-actions/actions.claims.json'), manifest.files['dist/ax/actions.claims.json']);
});

test('the generated projections are what the declarations generate', { skip: !typeStripping }, () => {
  execFileSync(process.execPath, ['tools/ouro-actions/ouro-actions.mts', 'check', 'actions/hackamore.actions.mts', 'actions/generated'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
