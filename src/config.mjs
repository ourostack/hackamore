// What a Mac's owner adds to hackamore's defaults, from ~/.config/hackamore/config.json (or the file HACKAMORE_CONFIG
// names, or the JSON in HACKAMORE_CONFIG_JSON, which wins). Every field is optional:
//   protected        [{ match: "<bundle id regex>", name, read: false|true, why }]  more apps agents must not drive
//                    (read: true still lets `ls` read them); the defaults are in src/ax.mjs
//   secrets          ["<Keychain item name>"]  what type_secret may read, on the Mac that types
//   prompt_decisions [{ prompt: "<exact words>", button: "<the one button>", by }]  prompts an agent may answer
//   clients          ["<process name>"]  tools whose own permission prompts an agent may Allow
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE = path.join(os.homedir(), '.config/hackamore/config.json');

const list = (v) => (Array.isArray(v) ? v : []);

export function normalize(raw = {}) {
  return {
    protected: list(raw.protected).filter((p) => p && typeof p.match === 'string' && p.name).map((p) => ({ match: p.match, name: String(p.name), read: p.read === true, why: String(p.why || 'its owner asked agents to leave it alone') })),
    secrets: list(raw.secrets).map(String),
    prompt_decisions: list(raw.prompt_decisions).filter((d) => d && d.prompt && d.button),
    clients: list(raw.clients).map(String),
  };
}

export function loadConfig({ env = process.env, file = env.HACKAMORE_CONFIG || CONFIG_FILE } = {}) {
  let raw = {};
  if (env.HACKAMORE_CONFIG_JSON) {
    try { raw = JSON.parse(env.HACKAMORE_CONFIG_JSON); } catch { raw = {}; }
  } else {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = {}; }
  }
  return normalize(raw);
}
