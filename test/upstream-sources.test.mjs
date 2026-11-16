// Every file the lock names is the file it pins: a hand edit to the vendored Ouro AX kit fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const lock = JSON.parse(fs.readFileSync(new URL('../upstream-sources.lock.json', import.meta.url), 'utf8'));

test('the lock pins the Ouro AX kit to a commit of ourostack/ouro-ui', () => {
  const [source] = lock.sources;
  assert.equal(source.repository, 'ourostack/ouro-ui');
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.ok(source.files.length > 0);
});

for (const file of lock.sources.flatMap((s) => s.files)) {
  test(`${file.generatedPath} matches its pinned sha256`, () => {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(new URL(`../${file.generatedPath}`, import.meta.url))).digest('hex');
    assert.equal(actual, file.sha256, `${file.generatedPath} changed; copy the next Ouro UI tag instead of editing it`);
  });
}
