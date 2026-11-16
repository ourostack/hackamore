#!/usr/bin/env node
// The X-ray's fixture engine: a made-up app that answers each request line and records what it received in
// $HOME/engine-stub-received.jsonl, so a test can prove the CLI sent exactly the declared input. Never shipped (test/ is not in "files").
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const log = path.join(process.env.HOME, 'engine-stub-received.jsonl');
const APP = { name: 'Fixture', bundle: 'com.example.fixture', pid: 1 };

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  fs.appendFileSync(log, line + '\n');
  const req = JSON.parse(line);
  const reply = req.op === 'trust' ? { ok: true, ax: true, screen_capture: false }
    : req.op === 'apps' ? { ok: true, apps: [APP] }
    : { ok: true, app: APP, elements: [] };
  process.stdout.write(JSON.stringify({ id: req.id, ...reply }) + '\n');
});
