import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A git dependency installs what `npm pack` ships, so install the tarball and run the CLI entry from it.
test('the packed tarball installs and its CLI entry imports', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hackamore-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir, '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
    const app = path.join(dir, 'app');
    mkdirSync(app);
    writeFileSync(path.join(app, 'package.json'), '{"name":"consumer","private":true,"type":"module"}');
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(dir, packed[0].filename)], { cwd: app, stdio: 'pipe' });
    const pkg = path.join(app, 'node_modules/@ouro.bot/hackamore');
    const out = execFileSync('node', [path.join(pkg, 'bin/hackamore.mjs'), '--help'], { cwd: app, encoding: 'utf8', stdio: 'pipe' });
    assert.ok(out.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
