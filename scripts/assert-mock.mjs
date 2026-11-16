#!/usr/bin/env node
// The X-ray's guard: exits 0 only when the home is a temporary one and the engine is this repository's fixture, and
// then marks the home so the CLI honors HACKAMORE_ENGINE_STUB. Anything else exits 2 before the X-ray calls the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'engine-stub.mjs');
const { HOME, HACKAMORE_ENGINE_STUB: stub = '', RUNNER_TEMP = '' } = process.env;
const refuse = (why) => { console.error(`assert-mock: refused: ${why}`); process.exit(2); };

const tmpRoots = [os.tmpdir(), RUNNER_TEMP].filter(Boolean).map((p) => path.resolve(p));
if (!HOME || !tmpRoots.some((root) => path.resolve(HOME).startsWith(root + path.sep))) refuse(`HOME (${HOME}) is not under a temporary folder`);
if (!stub || path.resolve(stub) !== FIXTURE) refuse(`HACKAMORE_ENGINE_STUB must be ${FIXTURE}`);
try { fs.accessSync(FIXTURE, fs.constants.X_OK); } catch { refuse(`${FIXTURE} is not executable`); }
fs.writeFileSync(path.join(HOME, '.hackamore-xray-guard'), 'proved by scripts/assert-mock.mjs\n');
console.log('assert-mock: the home is temporary and the engine is the fixture');
