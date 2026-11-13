// hackamore ls, do and batch: any Mac app's UI as Reins state and actions, with no model in the loop.
//   hackamore ls [app] [--layer auto|ax|pixels] [--no-menus]
//       the screen: frontmost app and window (or [app]), blocking alerts, an indexed and pruned accessibility tree
//       (role, label, value, enabled/focused, frame) and the actions available now, each with a JSON Schema narrowed
//       to exact values (click's `element` is an enum of the current refs and #indexes)
//   hackamore do <action> '<json>' [--record <file>] [--idle 90]
//       run one; the reply carries the new screen.
// Elements have two addresses: `#12`, this screen's index (volatile), and a ref such as `button[Back]` or
// `toolbar > button[Back]`, the shortest role[label] path that is unique on the screen. Refs survive replays: a ref
// that no longer matches exactly is matched by suffix against every element's full path, and used if that is unique.
// Layers: "ax" reads and drives the accessibility tree through swift/ax-engine.swift, kept warm in a resident agent
// (src/agent.mjs), so a call is milliseconds. "pixels" (src/pixels.mjs) is the fallback when there is no usable tree
// (before login, FileVault, canvas/Electron surfaces, a hung WindowServer): a screenshot, OCR text boxes as elements,
// and clicks/keys through a pixel driver (this Mac's own screen, or a KVM through housesitter).
// Refusals, in Reins' vocabulary plus three of ours: action-unavailable, input-invalid, action-failed,
// person-active (someone is using that Mac: the idle gate, src/gate.mjs), app-protected (an app agents never drive;
// the list is in PROTECTED and the owner's config) and permission-missing (this Mac's engine has no Accessibility
// permission; a person grants it once).
// Never: type a password given on the command line (type_secret takes a Keychain item name the owner's config allows,
// read on the Mac that types), click a consent the owner didn't allow, or change security settings.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { validate as validateSchema, holds } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = process.env.HACKAMORE_CACHE || path.join(os.homedir(), 'Library/Caches/hackamore');
// Where the agent listened before hackamore had its own repository; an agent installed then still holds its grant.
export const LEGACY_SOCK = path.join(os.homedir(), 'Library/Caches/mac-ui/reins-agent.sock');
export const MAX_ELEMENTS = 150;
export const SETTLE_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the engine (resident, one per process) ----------

export async function engineBin({ src = path.join(HERE, '..', 'swift', 'ax-engine.swift'), cache = CACHE, compile = compileSwift } = {}) {
  const h = createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const bin = path.join(cache, `ax-engine-${h}`);
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const tmp = `${bin}.new-${process.pid}`;
  const r = await compile(src, tmp);
  if (r.code !== 0) throw new Error(`ax-engine did not compile: ${String(r.stderr || '').slice(0, 400)}`);
  fs.renameSync(tmp, bin);
  return bin;
}

function compileSwift(src, out) {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/swiftc', ['-O', src, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let se = '';
    p.stderr.on('data', (b) => { se += b; });
    p.on('close', (code) => resolve({ code, stderr: se }));
    p.on('error', (e) => resolve({ code: 127, stderr: e.message }));
  });
}

export class Engine {
  constructor(bin, { spawnFn = spawn } = {}) { this.bin = bin; this.spawnFn = spawnFn; this.p = null; this.n = 0; this.wait = new Map(); }
  start() {
    const p = this.spawnFn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.p = p;
    readline.createInterface({ input: p.stdout }).on('line', (l) => {
      let j; try { j = JSON.parse(l); } catch { return; }
      const w = this.wait.get(j.id);
      if (w) { this.wait.delete(j.id); clearTimeout(w.t); w.resolve(j); }
    });
    p.on('exit', () => { if (this.p === p) this.p = null; for (const [id, w] of this.wait) { clearTimeout(w.t); w.resolve({ ok: false, error: 'engine-exited' }); this.wait.delete(id); } });
    p.on('error', () => { if (this.p === p) this.p = null; });
  }
  req(op, args = {}, timeoutMs = 5000) {
    if (!this.p) this.start();
    const id = ++this.n;
    return new Promise((resolve) => {
      // A hung app can stall an AX call past its own messaging timeout; the engine is restarted, not waited on.
      const t = setTimeout(() => { this.wait.delete(id); const p = this.p; this.p = null; try { p?.kill('SIGKILL'); } catch { /* gone */ } resolve({ ok: false, error: 'engine-timeout', message: `${op} took over ${timeoutMs} ms` }); }, timeoutMs);
      this.wait.set(id, { resolve, t });
      this.p.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }
  stop() { const p = this.p; this.p = null; try { p?.stdin.end(); } catch { /* gone */ } }
}

// The resident Ouro Reins Agent (src/agent.mjs): the same engine, run by its own LaunchAgent as a signed app so the
// Accessibility grant is its own; this process talks to it over a Unix socket.
export const AGENT_SOCK = path.join(CACHE, 'agent.sock');
export class SocketEngine {
  constructor(sock = AGENT_SOCK, { connect = net.createConnection } = {}) { this.sock = sock; this.connect = connect; this.c = null; this.n = 0; this.wait = new Map(); this.kind = 'agent'; }
  open() {
    return new Promise((resolve, reject) => {
      const c = this.connect(this.sock);
      c.once('connect', () => {
        this.c = c;
        // readline re-emits socket errors, so it is attached only once connected (and handles them itself)
        const rl = readline.createInterface({ input: c });
        rl.on('error', () => {});
        rl.on('line', (l) => {
          let j; try { j = JSON.parse(l); } catch { return; }
          const w = this.wait.get(j.id);
          if (w) { this.wait.delete(j.id); clearTimeout(w.t); w.resolve(j); }
        });
        resolve();
      });
      c.on('error', (e) => { if (this.c === c) this.c = null; reject(e); });
      c.on('close', () => { if (this.c === c) this.c = null; for (const [id, w] of this.wait) { clearTimeout(w.t); w.resolve({ ok: false, error: 'agent-closed' }); this.wait.delete(id); } });
    });
  }
  async req(op, args = {}, timeoutMs = 5000) {
    if (!this.c) { try { await this.open(); } catch (e) { return { ok: false, error: 'agent-down', message: e.message }; } }
    const id = ++this.n;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wait.delete(id); resolve({ ok: false, error: 'engine-timeout', message: `${op} took over ${timeoutMs} ms` }); }, timeoutMs);
      this.wait.set(id, { resolve, t });
      this.c.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }
  stop() { try { this.c?.end(); } catch { /* gone */ } this.c = null; }
}

// Prefer whichever engine holds Accessibility: the agent (production), else a child of this process (a shell that
// already has the grant, e.g. a developer's terminal). Re-chosen every 10 s while neither has it, so a grant made
// by a person takes effect without a restart.
let shared = null;
export async function engine({ socks = [AGENT_SOCK, LEGACY_SOCK] } = {}) {
  if (shared && (shared.trusted || Date.now() - shared.at < 10000)) return shared.e;
  const pick = async () => {
    const cands = [];
    for (const sock of socks) {
      if (!fs.existsSync(sock)) continue;
      const a = new SocketEngine(sock);
      const t = await a.req('trust', {}, 2000);
      if (t.ok) cands.push([a, t]); else a.stop();
      if (t.ok && t.ax) break;
    }
    if (!cands.some(([, t]) => t.ax)) { const c = new Engine(await engineBin()); c.kind = 'child'; const t = await c.req('trust', {}, 3000); cands.push([c, t]); }
    const best = cands.find(([, t]) => t.ax) || cands[0];
    for (const [e] of cands) if (e !== best[0]) e.stop();
    return { e: best[0], trusted: Boolean(best[1].ax), at: Date.now() };
  };
  const old = shared;
  shared = await pick();
  if (old && old.e !== shared.e) old.e.stop();
  return shared.e;
}

// ---------- protection ----------

// read: false means not even read (ls). The owner's config adds more (src/config.mjs).
export const DEFAULT_PROTECTED = [
  { match: '^com\\.apple\\.SecurityAgent$', name: 'SecurityAgent', read: false, why: 'a password or administrator prompt: agents never type passwords or approve administrator rights' },
  { match: '^com\\.apple\\.keychainaccess$', name: 'Keychain Access', read: false, why: 'passwords and keys' },
  { match: '^com\\.apple\\.Passwords', name: 'Passwords', read: false, why: 'passwords and keys' },
  { match: '^com\\.okta\\.mobile|^com\\.okta\\.OktaVerify', name: 'Okta Verify', read: true, why: 'sign-in approvals belong to a person' },
];
export function protectedApps(cfg = loadConfig()) {
  return [...DEFAULT_PROTECTED, ...cfg.protected].map((p) => ({ ...p, match: new RegExp(p.match, 'i') }));
}
export const PROTECTED = protectedApps();
// System Settings is drivable except where a change would touch security, MDM or accounts.
export const SENSITIVE_PANES = /privacy|security|device management|profile|password|users? & groups|lock screen|touch id|login items|firewall|filevault|sharing|general.*management|desktop & dock.*mission/i;

export function protection(app, windowTitle = '') {
  if (!app) return null;
  const p = PROTECTED.find((x) => x.match.test(app.bundle || '') || x.name === app.name);
  if (p) return { app: app.name, read: p.read, why: p.why };
  if (/^com\.apple\.(systempreferences|Settings)/i.test(app.bundle || '') && SENSITIVE_PANES.test(windowTitle || '')) {
    return { app: app.name, read: true, why: `the "${windowTitle}" pane changes security, MDM or account settings: no changes by agents` };
  }
  return null;
}

// Prompts raised by the tools that drive this Mac, which an agent may Allow; the owner's config adds more tools.
export const OUR_CLIENTS = ['node', 'osascript', 'hackamore', 'Ouro Reins Agent', 'Terminal', 'bash', ...loadConfig().clients];
export function alertClickAllowed({ alertText = '', button = '', hasSecureField = false, owner = '', decisions = [] }) {
  if (owner !== 'UserNotificationCenter') return { ok: false, why: `${owner || 'this'} prompt isn't one agents answer` };
  if (hasSecureField || /password|administrator|admin rights|unidentified developer|malware|damaged/i.test(alertText)) return { ok: false, why: 'the prompt asks for a password, administrator rights or a security override' };
  // A prompt for something other than our own tools is answered only as the owner's config recorded it
  // (prompt_decisions: the prompt's exact words, the one button decided, who decided and why).
  const norm = (t) => String(t).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const d = decisions.find((x) => x && x.prompt && x.button && norm(alertText).includes(norm(x.prompt)));
  if (d) return norm(button) === norm(d.button) ? { ok: true, who: `recorded decision (${d.by})` } : { ok: false, why: `for this prompt the recorded decision is "${d.button}" (${d.by}), not "${button}"` };
  if (!/^(allow|ok)$/i.test(String(button).trim())) return { ok: false, why: `only "Allow" or "OK" is answered for a prompt (not "${button}")` };
  const who = OUR_CLIENTS.find((c) => new RegExp(`(^|[^\\w])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`, 'i').test(alertText));
  if (!who) return { ok: false, why: 'the prompt doesn\'t name one of our own tools' };
  return { ok: true, who };
}

// ---------- pruning (pure) ----------

const CTRL_SUB = { AXCloseButton: 'close', AXMinimizeButton: 'minimize', AXZoomButton: 'zoom', AXFullScreenButton: 'full screen' };
export function roleOf(n) {
  const r = String(n.role || '').replace(/^AX/, '').toLowerCase();
  const sr = String(n.subrole || '');
  if (CTRL_SUB[sr]) return 'button';
  if (r === 'window' && /Dialog/.test(sr)) return 'dialog';
  if (sr === 'AXSearchField') return 'searchfield';
  if (n.secure || r === 'securetextfield') return 'securetextfield';
  return r || 'unknown';
}
const TEXTY = new Set(['statictext', 'heading', 'textfield', 'textarea', 'searchfield', 'combobox', 'cell']);
const KEEP = new Set(['button', 'checkbox', 'radiobutton', 'textfield', 'textarea', 'searchfield', 'securetextfield', 'combobox', 'popupbutton', 'menubutton', 'slider', 'link', 'row', 'menuitem', 'statictext', 'heading', 'incrementor', 'disclosuretriangle', 'colorwell', 'tab', 'dockitem', 'stepper', 'switch', 'segmentedcontrol']);
const SCROLLERS = new Set(['scrollarea', 'table', 'outline', 'list', 'webarea', 'browser', 'collection']);
const LANDMARK = new Set(['window', 'dialog', 'sheet', 'toolbar', 'tabgroup', 'table', 'outline', 'list', 'popover', 'webarea', 'group', 'scrollarea', 'splitgroup', 'browser']);
const NAMED_LANDMARK = new Set(['group', 'scrollarea', 'splitgroup', 'list', 'table', 'outline']);
const PRESSY = ['AXPress', 'AXConfirm', 'AXPick', 'AXOpen'];

const clean = (s, max = 60) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null; };
function textOf(n, depth = 0) {
  if (!n || depth > 3) return null;
  for (const k of n.children || []) {
    const r = roleOf(k);
    const t = clean(k.title || (TEXTY.has(r) ? k.value : null) || k.desc);
    if (t && (r === 'statictext' || r === 'textfield' || r === 'heading' || r === 'cell' || r === 'image')) return t;
    const d = textOf(k, depth + 1);
    if (d) return d;
  }
  return null;
}
// An editable field is never named by its own value: its ref would change as it is typed into. AppKit's generated
// identifiers ("_NS:122") say nothing and change between builds, so they never name anything.
const EDITABLE = new Set(['textfield', 'textarea', 'searchfield', 'combobox', 'securetextfield']);
// An identifier names a control only up to any state an app appends to it (Calculator: "StandardInputView;value:0.1").
const realIdent = (x) => (x && !/^_/.test(String(x)) ? String(x).split(';')[0].trim() || null : null);
export function labelOf(n) {
  if (CTRL_SUB[n.subrole]) return CTRL_SUB[n.subrole];
  const r = roleOf(n);
  return clean(n.title) || clean(n.desc) || (TEXTY.has(r) && !EDITABLE.has(r) ? clean(n.value) : null) || clean(n.placeholder) || ((r === 'row' || r === 'button' || r === 'cell' || r === 'link' || r === 'menubutton' || r === 'popupbutton') ? textOf(n) : null) || clean(n.help) || clean(realIdent(n.ident), 40);
}
export function textsOf(nodes, out = []) {
  for (const n of nodes || []) {
    for (const k of ['title', 'value', 'desc']) if (typeof n[k] === 'string' && n[k].length >= 3 && !out.includes(n[k])) out.push(n[k]);
    textsOf(n.children, out);
  }
  return out;
}
const seg = (role, label) => (label ? `${role}[${label.replace(/[[\]]/g, '')}]` : role);
const intersects = (a, b) => !a || !b || (a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]);
const center = (f) => [f[0] + f[2] / 2, f[1] + f[3] / 2];

// Raw engine windows (+ optional alert windows) → the screen's elements, each { i, ref, role, label, ... } plus a
// hidden `at` ({ pid, p }) that only the Mac running the engine uses. Pure, so tests drive it with fixtures.
export function prune(windows, { pid = 0, max = MAX_ELEMENTS, scope = '' } = {}) {
  const out = [];
  const walk = (n, trail, clip, parentLabel) => {
    const role = roleOf(n);
    const label = labelOf(n);
    const f = Array.isArray(n.frame) ? n.frame : null;
    const zero = f && (f[2] <= 0 || f[3] <= 0);
    const visible = !zero && intersects(f, clip);
    const acts = (n.actions || []).filter((a) => a !== 'AXShowMenu' || n.role !== 'AXGroup');
    const pressy = acts.some((a) => PRESSY.includes(a));
    const isWindow = trail.length === 0;
    let keep = false;
    if (visible && !isWindow) {
      if (KEEP.has(role)) keep = role === 'statictext' || role === 'heading' ? Boolean(label) && label !== parentLabel : true;
      else if (pressy || n.settable || n.focused) keep = true;
      else if (role === 'image' && label && acts.length) keep = true;
      else if (SCROLLERS.has(role) && f && f[2] > 40 && f[3] > 40) keep = true;
    }
    const mySeg = seg(role, label);
    const full = [...trail, mySeg];
    if (keep) {
      const can = [];
      if (f && role !== 'statictext' && role !== 'heading' || pressy) can.push('click');
      if (n.settable && !n.secure) can.push('set_value');
      if (SCROLLERS.has(role)) can.push('scroll');
      const other = acts.filter((a) => !['AXPress', 'AXRaise'].includes(a));
      if (other.length) can.push('perform');
      if (['textfield', 'textarea', 'searchfield', 'combobox'].includes(role)) can.push('type_text');
      if (role === 'securetextfield') can.push('type_secret');
      const e = { role, label: label || null, full: full.join(' > '), at: { pid, p: n.p } };
      // a text's value is its label, unless it's named apart from what it shows (Calculator's display: "Edit field")
      if (n.value != null && (!TEXTY.has(role) || (label && clean(n.value) !== label && !EDITABLE.has(role))) && role !== 'row') e.value = clean(n.value, 120);
      else if (n.value != null && (role === 'textfield' || role === 'textarea' || role === 'searchfield' || role === 'combobox')) e.value = clean(n.value, 120);
      if (n.enabled === false) e.enabled = false;
      if (n.focused) e.focused = true;
      if (n.selected) e.selected = true;
      if (f) e.frame = f;
      if (can.length) e.can = can;
      if (n.rows) e.rows = n.rows; // a table or outline shows only its visible rows: scroll it for the rest
      if (other.length) e.actions = other;
      out.push(e);
    }
    if (zero && !isWindow) return;
    // Landmarks name the path; unnamed plain containers don't, so a ref doesn't change when a group is added.
    const landmark = isWindow || (LANDMARK.has(role) && (!NAMED_LANDMARK.has(role) || label));
    const nextTrail = landmark && !keep ? full : keep ? full : trail;
    const nextClip = SCROLLERS.has(role) && f ? f : clip;
    const nextParentLabel = keep || landmark ? label : parentLabel;
    for (const k of n.children || []) walk(k, nextTrail, nextClip, nextParentLabel);
  };
  for (const w of windows || []) walk(w, [], null, null);
  // Shortest unique ref: the last segment, then more of the path, then an occurrence number.
  const segsOf = (e) => e.full.split(' > ');
  const refFor = (e, k) => segsOf(e).slice(-k).join(' > ');
  for (const e of out) {
    const segs = segsOf(e);
    let k = 1;
    const clash = (n) => out.some((o) => o !== e && refFor(o, n) === refFor(e, n));
    while (k < segs.length && clash(k)) k++;
    // identical all the way up (two "OK" buttons side by side): the short ref plus an occurrence number
    if (clash(k)) k = 1;
    e.ref = (scope ? `${scope} > ` : '') + refFor(e, k);
  }
  const counts = new Map();
  for (const e of out) {
    const c = (counts.get(e.ref) || 0) + 1;
    counts.set(e.ref, c);
    if (c > 1) e.ref = `${e.ref}#${c}`;
  }
  const kept = out.slice(0, max);
  kept.forEach((e, i) => { e.i = i; });
  return { elements: kept, dropped: out.length - kept.length };
}

// The element an input names: "#12", an exact ref, or (replays) a unique suffix match on the full path.
export function findElement(elements, want) {
  if (want == null) return { error: 'no element named' };
  const w = String(want).trim();
  const m = w.match(/^#(\d+)$/);
  if (m) { const e = elements.find((x) => x.i === Number(m[1])); return e ? { e } : { error: `#${m[1]} isn't on this screen (0-${elements.length - 1})` }; }
  const exact = elements.find((x) => x.ref === w);
  if (exact) return { e: exact };
  const base = w.replace(/#\d+$/, '');
  const nth = Number((w.match(/#(\d+)$/) || [])[1] || 1);
  const hits = elements.filter((x) => x.full === base || x.full.endsWith(` > ${base}`) || x.ref.replace(/#\d+$/, '') === base);
  if (hits.length === 1 || (hits.length > 1 && /#\d+$/.test(w) && hits[nth - 1])) return { e: hits.length === 1 ? hits[0] : hits[nth - 1], fuzzy: true };
  if (hits.length > 1) return { error: `"${w}" matches ${hits.length} elements: ${hits.slice(0, 5).map((x) => x.ref).join(', ')}` };
  // a bare label ("Edit field") names the one element that carries it
  const named = elements.filter((x) => x.label === w);
  if (named.length === 1) return { e: named[0], fuzzy: true };
  if (named.length > 1) return { error: `"${w}" labels ${named.length} elements: ${named.slice(0, 5).map((x) => x.ref).join(', ')}` };
  return { error: `"${w}" isn't on this screen` };
}

// ---------- the screen (pure) ----------

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const KEY_PATTERN = '^((cmd|command|shift|alt|option|opt|ctrl|control|fn)\\+)*([a-z0-9]|return|enter|tab|space|delete|backspace|escape|esc|forwarddelete|home|end|pageup|pagedown|left|right|up|down|f[1-9]|f1[0-2]|[-=\\[\\];\',./`\\\\])$';
const publicEl = ({ at: _a, full: _f, ...e }) => e;

export function uiScreen({ host, layer = 'ax', front = null, target = null, window = null, alerts = [], elements = [], dropped = 0, menus = [], apps = [], installed = [], gate = null, ax = null, prot = null, secrets = [], truncated = false, ms = null, errors = [], now = Date.now(), note = null, accessory = [] }) {
  const pub = elements.map(publicEl);
  const refsWith = (c) => elements.filter((e) => (e.can || []).includes(c)).map((e) => e.ref);
  const idx = (c) => elements.filter((e) => (e.can || []).includes(c)).map((e) => `#${e.i}`);
  const enumOf = (c) => [...refsWith(c), ...idx(c)];
  const appName = target?.name || front?.name || null;
  const state = {
    layer,
    app: target ? { name: target.name, bundle: target.bundle || null, pid: target.pid, front: Boolean(front && target.pid === front.pid) } : null,
    window: window ? { title: window.title || null, frame: window.frame || null } : null,
    alerts,
    elements: pub,
  };
  if (prot) state.protected = prot;
  // Windows of menu-bar and agent apps on the screen (not in the app list): `hackamore ls <app>` drives them.
  if (accessory.length) state.accessory = accessory.map((a) => ({ app: a.name, pid: a.pid, windows: a.windows.map((w) => ({ title: w.title, frame: w.frame })) }));
  if (ax) state.ax = ax;
  if (note) state.note = note;
  if (menus.length) state.menus = [...new Set(menus.map((m) => m.split(' > ')[0]))];
  const actions = [];
  // Reins' action shape: { name, title, input, from }. `from` is the node that offers it: the window (or app) for
  // what acts on the screen, the app for its menus, and "mac" for switching apps.
  const here = window?.title || appName || 'screen';
  const fromOf = (name) => (name === 'menu' ? appName || 'app' : name === 'open_app' || name === 'activate' ? 'mac' : here);
  const add = (name, input, title) => actions.push({ name, title, input, from: fromOf(name) });
  const appScope = { app: { type: 'string', enum: apps.map((a) => a.name) } };
  const drivable = layer !== 'none' && !(prot && !prot.read);
  if (drivable && elements.length) {
    add('click', obj({ element: { type: 'string', enum: enumOf('click') }, count: { type: 'integer', minimum: 1, maximum: 3 }, button: { type: 'string', enum: ['left', 'right'] }, ...appScope }, ['element']), 'press it (AXPress), or click its centre when it has no press action; count 2 opens');
    const sv = enumOf('set_value');
    if (sv.length) add('set_value', obj({ element: { type: 'string', enum: sv }, value: { type: 'string' }, ...appScope }, ['element', 'value']), 'set a text field, checkbox or slider directly');
    const pf = elements.filter((e) => (e.can || []).includes('perform'));
    if (pf.length) add('perform', obj({ element: { type: 'string', enum: enumOf('perform') }, action: { type: 'string', enum: [...new Set(pf.flatMap((e) => e.actions))] }, ...appScope }, ['element', 'action']), 'an accessibility action other than press (AXShowMenu, AXIncrement, AXOpen, …)');
    const sc = enumOf('scroll');
    if (sc.length) add('scroll', obj({ element: { type: 'string', enum: sc }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 50 }, ...appScope }, ['element', 'direction']), 'scroll a list, table or page (lines)');
  }
  if (layer === 'pixels' && elements.length) {
    // pixels: click also takes raw coordinates in the screenshot's pixel space
    const c = actions.find((a) => a.name === 'click');
    if (c) { c.input.properties.x = { type: 'integer', minimum: 0, maximum: 20000 }; c.input.properties.y = { type: 'integer', minimum: 0, maximum: 20000 }; c.input.required = []; }
  }
  if (drivable && !(prot && prot.read === false)) {
    add('type_text', obj({ text: { type: 'string', minLength: 1 }, element: { type: 'string', enum: enumOf('type_text') }, ...appScope }, ['text']), 'type into the focused field, or into `element` after focusing it (never a password: see type_secret)');
    add('press_key', obj({ key: { type: 'string', pattern: KEY_PATTERN }, ...appScope }, ['key']), 'one key or combination, e.g. "cmd+w", "return", "shift+tab"');
    if (secrets.length) add('type_secret', obj({ keychain_item: { type: 'string', enum: secrets }, element: { type: 'string', enum: enumOf('type_secret') } }, ['keychain_item']), 'type a secret read on that Mac from its Keychain by item name (named in the owner\'s config); the value never leaves that Mac');
  }
  if (drivable && menus.length) add('menu', obj({ item: { type: 'string', enum: menus }, ...appScope }, ['item']), 'choose a menu-bar item (Menu > Item) without opening the menu');
  if (layer !== 'none') {
    const inst = installed.filter((n) => !PROTECTED.some((p) => p.name === n && !p.read));
    if (inst.length) add('open_app', obj({ app: { type: 'string', enum: inst } }, ['app']), 'open (or bring forward) an installed app');
    const others = apps.filter((a) => a.pid !== front?.pid && !PROTECTED.some((p) => (p.match.test(a.bundle || '') || p.name === a.name) && !p.read)).map((a) => a.name);
    if (others.length) add('activate', obj({ app: { type: 'string', enum: others } }, ['app']), 'bring a running app to the front');
  }
  const winTitle = window?.title || null;
  return {
    focus: winTitle || appName || 'screen',
    path: ['mac', host, ...(appName ? [appName] : []), ...(winTitle ? [winTitle] : [])],
    state,
    // person is context, not state: its idle seconds tick, and state changes only when the screen does
    context: { as_of: new Date(now).toISOString(), ms, person: gate ? { active: !gate.open, idle_s: gate.idle ?? null, why: gate.why } : null, truncated: truncated || dropped > 0 || undefined, dropped: dropped || undefined, front: front ? front.name : null, running: apps.map((a) => a.name), errors },
    actions,
  };
}

// ---------- validation ----------

export async function validateInput(schema, input) {
  for (const [k, sub] of Object.entries(schema.properties || {})) {
    if (sub.pattern && typeof input[k] === 'string' && !new RegExp(sub.pattern, 'i').test(input[k])) return { path: `$.${k}`, message: `$.${k}: ${JSON.stringify(input[k])} isn't a key or combination like "cmd+w"` };
  }
  // `element` is checked against the live screen (findElement), so a replayed ref may match by suffix.
  const loose = { ...schema, properties: Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, k === 'element' ? { type: 'string' } : v])) };
  return validateSchema(loose, input);
}

// ---------- revisions, packing and diffs (pure) ----------
// What crosses the bus is small: element enums are sent as {"$from":"<capability>"} and rebuilt from the elements
// (pack/unpack), and after the first screen only what changed is sent (diffView/applyDiff against the rev the
// caller already holds). Each Hub message is one HTTP post, so bytes are time.

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function revOf(view) {
  const { context: _c, rev: _r, ...rest } = view;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
}

export function pack(view) {
  const actions = view.actions.map((a) => {
    const e = a.input?.properties?.element;
    if (!e?.enum) return a;
    const cap = a.name === 'type_text' || a.name === 'type_secret' || a.name === 'set_value' || a.name === 'perform' || a.name === 'scroll' ? a.name : 'click';
    return { ...a, input: { ...a.input, properties: { ...a.input.properties, element: { type: 'string', $from: cap } } } };
  });
  return { ...view, actions };
}

export function unpack(view) {
  const els = view.state?.elements || [];
  const enumOf = (c) => [...els.filter((e) => (e.can || []).includes(c)).map((e) => e.ref), ...els.filter((e) => (e.can || []).includes(c)).map((e) => `#${e.i}`)];
  const actions = (view.actions || []).map((a) => {
    const e = a.input?.properties?.element;
    if (!e?.$from) return a;
    return { ...a, input: { ...a.input, properties: { ...a.input.properties, element: { type: 'string', enum: enumOf(e.$from) } } } };
  });
  return { ...view, actions };
}

export function diffView(prev, next) {
  const d = { rev: next.rev, since: prev.rev };
  for (const k of ['focus', 'path', 'context']) if (!eq(prev[k], next[k])) d[k] = next[k];
  const ps = prev.state || {}, ns = next.state || {};
  const st = {}, gone = [];
  for (const k of new Set([...Object.keys(ps), ...Object.keys(ns)])) {
    if (k === 'elements') continue;
    if (!(k in ns)) gone.push(k); else if (!eq(ps[k], ns[k])) st[k] = ns[k];
  }
  if (Object.keys(st).length) d.state = st;
  if (gone.length) d.state_del = gone;
  const strip = ({ i: _i, ...e }) => e;
  const pm = new Map((ps.elements || []).map((e) => [e.ref, e]));
  const nm = new Map((ns.elements || []).map((e) => [e.ref, e]));
  const put = [...nm.values()].filter((e) => !pm.has(e.ref) || !eq(strip(pm.get(e.ref)), strip(e))).map(strip);
  const del = [...pm.keys()].filter((r) => !nm.has(r));
  const order = (ns.elements || []).map((e) => e.ref);
  if (put.length) d.put = put;
  if (del.length) d.del = del;
  if (!eq((ps.elements || []).map((e) => e.ref), order)) d.order = order;
  const pa = new Map((prev.actions || []).map((a) => [a.name, a]));
  const aput = (next.actions || []).filter((a) => !eq(pa.get(a.name), a));
  const names = (next.actions || []).map((a) => a.name);
  if (aput.length) d.actions_put = aput;
  if (!eq([...pa.keys()], names)) d.actions_order = names;
  return d;
}

export function applyDiff(prev, d) {
  if (d.since !== prev.rev) throw new Error(`diff is against ${d.since}, have ${prev.rev}`);
  const state = { ...(prev.state || {}), ...(d.state || {}) };
  for (const k of d.state_del || []) delete state[k];
  const m = new Map((prev.state?.elements || []).map((e) => [e.ref, e]));
  for (const r of d.del || []) m.delete(r);
  for (const e of d.put || []) m.set(e.ref, e);
  const order = d.order || (prev.state?.elements || []).map((e) => e.ref);
  state.elements = order.map((r, i) => ({ i, ...m.get(r), i }));
  const am = new Map((prev.actions || []).map((a) => [a.name, a]));
  for (const a of d.actions_put || []) am.set(a.name, a);
  const actions = (d.actions_order || (prev.actions || []).map((a) => a.name)).map((n) => am.get(n));
  return { focus: d.focus ?? prev.focus, path: d.path ?? prev.path, state, context: d.context ?? prev.context, actions, rev: d.rev };
}

// ---------- reading this Mac (runs next to the engine) ----------

export function installedApps(dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')]) {
  const out = new Map();
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (n.endsWith('.app') && !out.has(n.slice(0, -4))) out.set(n.slice(0, -4), path.join(d, n));
  }
  return out;
}

// Accessory and agent apps (menu-bar apps, LSUIElement apps such as OneDrive) aren't in the regular app list; a
// window of theirs on the screen makes them visible and drivable (a first-run window of such an app sat on the screen
// where `ls` couldn't see it). Not the system's own chrome, and not menu-bar items (layer 25+).
export const SYSTEM_OWNERS = new Set(['Window Server', 'Dock', 'Control Center', 'ControlCenter', 'SystemUIServer', 'Notification Center', 'NotificationCenter', 'TextInputMenuAgent', 'TextInputSwitcher', 'Spotlight', 'loginwindow', 'WindowManager', 'Wallpaper', 'UserNotificationCenter', 'universalAccessAuthWarn', 'SecurityAgent', 'CoreServicesUIAgent', 'screencaptureui', 'Screenshot', 'Siri', 'AirPlayUIAgent', 'Menu Bar', 'Accessibility', 'talagent', 'ViewBridgeAuxiliary', 'Open and Save Panel Service', 'CursorUIViewService', 'AutoFill', 'universalcontrol', 'Universal Control', 'Ouro Reins Agent']);
export function accessoryApps(windows = [], apps = []) {
  const regular = new Set(apps.map((a) => a.pid));
  const by = new Map();
  for (const w of windows) {
    if (regular.has(w.pid) || SYSTEM_OWNERS.has(w.owner) || !w.owner || (w.layer || 0) >= 25 || (w.layer || 0) < 0) continue;
    const f = w.frame || [];
    if (!(f[2] >= 120 && f[3] >= 60)) continue;
    if (!by.has(w.pid)) by.set(w.pid, { pid: w.pid, name: w.owner, accessory: true, windows: [] });
    by.get(w.pid).windows.push({ title: w.title || null, frame: f, layer: w.layer || 0 });
  }
  return [...by.values()];
}

export const isAlert = (w) => (w.owner === 'UserNotificationCenter' && w.layer >= 8) || ['SecurityAgent', 'universalAccessAuthWarn', 'CoreServicesUIAgent'].includes(w.owner);

export function pickApp(apps, want) {
  if (!want) return null;
  const w = String(want).toLowerCase();
  return apps.find((a) => (a.bundle || '').toLowerCase() === w) || apps.find((a) => a.name.toLowerCase() === w) || apps.find((a) => a.name.toLowerCase().startsWith(w)) || null;
}

export const promptDecisionsFor = () => loadConfig().prompt_decisions;
export const secretsFor = () => loadConfig().secrets;

export const PERMISSION_FIX = 'once per Mac, a person turns on "Ouro Reins Agent" in System Settings > Privacy & Security > Accessibility (and Screen & System Audio Recording for its pixel layer); `hackamore agent grant --person-here` raises the macOS dialog that opens that page. macOS asks for the Mac\'s password there, which agents never type, and agents never flip this setting themselves';

// Per-process warm state: a resident process keeps it between requests, which is most of why a call is fast.
export function newCache() { return { trust: null, trustAt: 0, installed: null, installedAt: 0, secrets: null, menus: new Map(), last: null, views: new Map() }; }
let CACHED = newCache();
export function resetCache() { CACHED = newCache(); }

// The gate's facts from the engine (one in-process call) instead of two ioreg spawns; ioreg if the engine can't.
export async function gateMachine(E) {
  const r = await E.req('idle').catch(() => null);
  if (r?.ok) return { idle: r.idle, locked: r.locked, why: r.why, user: r.user, now: r.now };
  const G = await import('./gate.mjs');
  return G.readMachine();
}

export function rememberView(view, cache = CACHED, keep = 24) {
  cache.views.set(view.rev, view);
  while (cache.views.size > keep) cache.views.delete(cache.views.keys().next().value);
}

// Everything a look learns, including the hidden element addresses. deps are injected by tests.
export async function look({ app = null, menus = true, host = 'local', me = null, eng = null, gateRead = null, gateState = null, installed = installedApps, cache = CACHED } = {}) {
  const t0 = Date.now();
  const E = eng || (await engine());
  const G = await import('./gate.mjs');
  const now = Date.now();
  if (!cache.trust || now - cache.trustAt > 10000 || cache.trustOf !== E) { cache.trust = await E.req('trust'); cache.trustAt = now; cache.trustOf = E; }
  if (!cache.installed || now - cache.installedAt > 60000) { cache.installed = installed(); cache.installedAt = now; }
  cache.secrets ??= secretsFor(me);
  const trust = { ...cache.trust, engine: E.kind || 'child' };
  const gm = gateRead ? gateRead() : await gateMachine(E);
  const gv = G.ownedVerdict(gm, gateState ? gateState() : G.loadState());
  const gate = { ...gv, idle: gm.idle };
  // The app list changes rarely; the front app is one cheap call every time.
  if (!cache.apps || now - cache.appsAt > 2000) { cache.apps = await E.req('apps'); cache.appsAt = now; }
  const frontR = await E.req('front');
  const winsR = await E.req('windows');
  const apps = [...(cache.apps.apps || [])];
  const front = frontR.front || cache.apps.front || null;
  if (front && !apps.some((a) => a.pid === front.pid)) { cache.apps = await E.req('apps'); cache.appsAt = now; }
  const accessory = accessoryApps(winsR.windows || [], cache.apps.apps || []);
  if (accessory.length) apps.push(...accessory.filter((x) => !apps.some((a) => a.pid === x.pid)));
  const inst = [...cache.installed.keys()].sort();
  const alertWins = (winsR.windows || []).filter(isAlert);
  const base = { host, front, apps, installed: inst, gate, errors: [], secrets: cache.secrets, accessory };
  const finish = (view, extra) => { view.rev = revOf(view); view.context.ms = Date.now() - t0; return { trust, base, view, apps, front, gate, installedMap: cache.installed, ...extra }; };
  if (!trust.ax) {
    return finish(uiScreen({ ...base, layer: 'none', ax: { trusted: false, engine: trust.engine, screen_capture: Boolean(trust.screen_capture), fix: PERMISSION_FIX }, note: 'no accessibility tree here: hackamore ls --layer pixels works where a pixel driver exists (this Mac\'s own screen once the agent may record it, or a KVM through housesitter)' }), { elements: [], menuMap: new Map() });
  }
  // A menu-bar app with no window on the screen (OneDrive signed out) is found by its process name.
  if (app && !pickApp(apps, app) && /^[\w .-]{1,60}$/.test(app)) {
    const { spawnSync } = await import('node:child_process');
    const pid = Number(String(spawnSync('/usr/bin/pgrep', ['-x', app], { encoding: 'utf8', timeout: 2000 }).stdout || '').split('\n')[0]);
    if (pid > 0) apps.push({ pid, name: app, accessory: true, windows: [] });
  }
  const target = pickApp(apps, app) || front;
  if (app && !pickApp(apps, app)) base.errors.push(`${app} isn't running; showing the frontmost app`);
  const prot0 = protection(target);
  const elements = [];
  let dropped = 0, window = null, truncated = false, prot = prot0, menuItems = [], menuMap = new Map();
  const alerts = [];
  // Blocking alerts first: they are what a person would see on top.
  for (const aw of alertWins) {
    const a = { owner: aw.owner, title: aw.title || null };
    if (aw.owner === 'UserNotificationCenter') {
      const t = await E.req('tree', { pid: aw.pid, maxDepth: 12, budgetMs: 600 });
      const text = textsOf(t.windows || []).join(' · ');
      a.text = text.slice(0, 400);
      const pr = prune(t.windows || [], { pid: aw.pid, scope: 'alert' });
      const hasSecure = pr.elements.some((e) => e.role === 'securetextfield');
      elements.push(...pr.elements.map((e) => ({ ...e, alert: { owner: aw.owner, text: a.text, hasSecure } })));
    }
    alerts.push(a);
  }
  if (target && (!prot0 || prot0.read)) {
    const t = await E.req('tree', { pid: target.pid, maxDepth: 40, maxChildren: 120, maxNodes: 3000, budgetMs: 1500 });
    if (!t.ok) base.errors.push(`tree: ${t.error}${t.message ? ` (${t.message})` : ''}`);
    truncated = Boolean(t.truncated);
    const w0 = (t.windows || [])[0];
    window = w0 ? { title: w0.title || null, frame: w0.frame || null } : null;
    prot = protection(target, window?.title) || prot0;
    const pr = prune(t.windows || [], { pid: target.pid, max: MAX_ELEMENTS - elements.length });
    elements.push(...pr.elements);
    // A menu-bar app's status items (AXExtrasMenuBar): pressing one opens its menu or panel, no pointer.
    if (target.accessory) {
      const x = await E.req('extras', { pid: target.pid }).catch(() => null);
      for (const it of x?.extras || []) {
        const label = it.title || it.desc || target.name;
        elements.push({ role: 'menubaritem', label, full: `menu bar > menubaritem[${label}]`, ref: `menu bar > menubaritem[${label}]`, at: { pid: target.pid, p: it.p }, ...(it.frame ? { frame: it.frame } : {}), can: ['click'] });
      }
    }
    dropped = pr.dropped;
    if (menus) {
      let mc = cache.menus.get(target.pid);
      if (!mc || now - mc.at > 5000) {
        const m = await E.req('menus', { pid: target.pid, depth: 1 });
        const items = [], map = new Map();
        for (const top of m.menus || []) {
          if (/^apple$/i.test(top.title) || !top.title) continue;
          for (const it of top.items || []) {
            if (it.enabled === false || it.submenu || !it.title) continue;
            const k = `${top.title} > ${it.title}`;
            if (!map.has(k)) { map.set(k, { pid: target.pid, p: it.p }); items.push(k); }
          }
        }
        mc = { at: now, items, map };
        cache.menus.set(target.pid, mc);
      }
      menuItems = mc.items; menuMap = mc.map;
    }
  }
  elements.forEach((e, i) => { e.i = i; });
  const note = prot && !prot.read ? `not read: ${prot.why}`
    : !window && target ? `${target.name} has no window on this screen (none open, minimized, or on another Space): open one with menu/press_key, or activate it`
      : !elements.length ? 'this window exposes no accessibility elements (canvas or Electron?): try --layer pixels' : null;
  const view = uiScreen({ ...base, layer: 'ax', target, window, alerts, elements, dropped, menus: menuItems, prot, truncated, note, ax: { trusted: true, engine: trust.engine, screen_capture: Boolean(trust.screen_capture) } });
  // The screen's identity (front app, window, alerts), without the elements, values and frames, which can keep
  // streaming (a folder filling in, a window animating) long after the action has landed.
  const sig = createHash('sha256').update(JSON.stringify([view.focus, window?.title, front?.pid, alerts.map((a) => a.owner)])).digest('hex').slice(0, 12);
  const L = finish(view, { elements, menuMap, target, prot, window, at: Date.now(), sig });
  cache.last = L;
  return L;
}

// ---------- acting ----------

// The gate around one action, with src/gate.mjs's own rules (ownedVerdict, init/pre/post): open only when nobody but us
// has touched the Mac for idleMin seconds; our own marked input doesn't count, a person's does and stops us.
// `background` (the background class): an action that moves no pointer and changes no focus or front app (an AXPress
// on a dialog of an app that isn't in front, an AX value set there) runs while a person is active, without marks,
// since it makes no input event, so it is never blocked on a human. fn gets { background: true } then.
export async function gated(fn, { idleMin = 90, read, io, ours = null, background = false }) {
  const G = await import('./gate.mjs');
  const m = await read();
  let s = G.mergeOurs(io.load(), ours, m.now);
  const v = G.ownedVerdict(m, s, { idleMin });
  // A locked screen isn't a person at it: its own refusal, so the caller can unlock it and retry (the `onLocked` hook).
  if (m.locked) return { refused: 'screen-locked', message: `the screen is locked (${m.why || 'locked'}). Fix: unlock the screen; hackamore never types a password.` };
  if (!v.open && background) return { r: await fn({ background: true }), background: true };
  if (!v.open) return { refused: 'person-active', message: `someone is using this Mac: ${v.why}. Fix: wait until it has been idle ${idleMin} s (hackamore gate check); never drive a screen a person is using. What runs anyway: an AX press or value set in an app that isn't in front (the background class).` };
  if (!s || s.stop || s.mark == null || G.verdict(m, { idleMin }).open) {
    const i = G.step('init', m, null, { idleMin });
    if (!i.ok) return { refused: 'person-active', message: i.msg };
    s = i.state;
  }
  const pre = G.step('pre', m, s, { idleMin });
  io.save(pre.state);
  if (!pre.ok) return { refused: 'person-active', message: pre.msg };
  const r = await fn({ background: false });
  io.save(G.step('post', await read(), pre.state, { idleMin }).state);
  return { r };
}

function keychainSecret(item) {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/security', ['find-generic-password', '-s', item, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('close', (code) => resolve(code === 0 ? out.replace(/\n$/, '') : null));
    p.on('error', () => resolve(null));
  });
}

// After an action: read until the screen stops changing. A press is synchronous in AX, so most screens are final
// on the first read; one confirming read 30 ms later catches a second wave. Nothing changed: poll up to quietMs.
// Done when the action shows: the identity (sig: front app, window, alerts) changed and holds for one more read, or
// only the content changed (a value, a toggle), which needs no confirming. Nothing yet: poll until quietMs.
// Elements may keep streaming in after that; the reply has the latest read, and the next ls has the rest.
// probeFn, when given, confirms a changed identity cheaply (the window server's list: front app and its windows, no
// question to the app, ~1 ms) instead of a second full read, which waits on an app still busy animating.
export async function settle(lookFn, pre, { quietMs = 100, maxMs = 800, waitFor = null, sleepFn = sleep, now = Date.now, probeFn = null } = {}) {
  const t0 = now();
  const preSig = typeof pre === 'object' ? pre.sig ?? pre.view?.rev : pre;
  const preRev = typeof pre === 'object' ? pre.view?.rev : pre;
  const sigOf = (L) => L.sig ?? L.view.rev;
  let cur = await lookFn();
  for (;;) {
    if (now() - t0 > maxMs) return cur;
    if (waitFor && !waitFor(cur)) { await sleepFn(40); cur = await lookFn(); continue; }
    if (sigOf(cur) !== preSig) {
      const p1 = probeFn ? await probeFn() : null;
      await sleepFn(30);
      if (probeFn && p1 === (await probeFn())) return cur;
      const nx = await lookFn();
      if (sigOf(nx) === sigOf(cur)) return nx;
      cur = nx; continue;
    }
    if (cur.view.rev !== preRev) return cur;
    if (now() - t0 >= quietMs) return cur;
    await sleepFn(30);
    cur = await lookFn();
  }
}

// The window server's view of the screen: the front app and every normal window's owner and frame.
export async function windowProbe(E) {
  const [f, w] = await Promise.all([E.req('front'), E.req('windows')]);
  return JSON.stringify([f.front?.pid, (w.windows || []).filter((x) => x.layer === 0).map((x) => [x.pid, x.frame])]);
}

// One action on this Mac. Returns { code, reply } with Reins' exit codes (0 ok, 2 refused, 1 failed) and the look
// after it (L), so a batch can chain without reading the screen twice.
export async function act(action, input = {}, opts = {}) {
  const { app = null, idleMin = 90, eng = null, gateRead = null, gateIO = null, me = null, host = 'local', installed = installedApps, secret = keychainSecret, cache = CACHED, settleMode = 'full', gateState = null, ours = null } = opts;
  const E = eng || (await engine());
  const G = await import('./gate.mjs');
  const T0 = Date.now();
  const ms = {};
  const target = input.app || app;
  const lookOpts = { host, me, eng: E, gateRead, gateState, installed, cache };
  // The screen we act on: the last look if it is this app's and fresh (a batch's previous step, or the ls just
  // before), otherwise a new one. A stale path is caught below and read again.
  const fresh = async () => look({ ...lookOpts, app: target });
  let L = cache.last;
  const front = L ? (await E.req('front')).front : null;
  const usable = L && Date.now() - L.at < 5000 && L.front?.pid === front?.pid && (!target || pickApp(L.apps, target)?.pid === L.target?.pid);
  if (!usable) L = await fresh();
  ms.read = Date.now() - T0;
  const refuse = (refused, message, extra = {}) => ({ code: 2, L, reply: { ok: false, refused, message, ...extra } });
  if (L.view.state.layer === 'none') return refuse('permission-missing', `no accessibility permission on this Mac. Fix: ${PERMISSION_FIX}.`);
  const reqApp = target ? pickApp(L.apps || [], target) : null;
  if ((action === 'open_app' || action === 'activate') && input.app) {
    const p = PROTECTED.find((x) => x.name === input.app || x.match.test(reqApp?.bundle || ''));
    if (p && !p.read) return refuse('app-protected', `${input.app}: ${p.why}`);
  }
  const offered = L.view.actions.find((a) => a.name === action);
  if (!offered) {
    const pr = L.prot || (reqApp && protection(reqApp));
    if (pr && !pr.read) return refuse('app-protected', `${pr.app}: ${pr.why}`);
    const names = L.view.actions.map((a) => a.name);
    return refuse('action-unavailable', `${action} isn't available on ${L.view.focus}. Fix: use one of: ${names.join(', ') || '(none)'}.`, { available: names });
  }
  const { settle_ms: settleIn, ...rest } = input;
  const bad = await validateInput(offered.input, rest);
  if (bad) return refuse('input-invalid', bad.message, { path: bad.path, schema: offered.input });
  const resolveEl = () => {
    if (input.element == null) return { e: null };
    const f = findElement(L.elements, input.element);
    if (f.error) return f;
    const el = f.e;
    const need = action === 'type_text' ? ['type_text', 'set_value'] : [action];
    if (!need.some((c) => (el.can || []).includes(c)) && !(action === 'click' && el.frame)) return { error: `${el.ref} can't ${action} (it can: ${(el.can || []).join(', ') || 'nothing'})` };
    return f;
  };
  let f = resolveEl();
  if (f.error && usable) { L = await fresh(); f = resolveEl(); }
  if (f.error) return refuse('input-invalid', `$.element: ${f.error}`, { path: '$.element' });
  let el = f.e;
    if (el?.alert) {
    const decisions = opts.decisions ?? promptDecisionsFor();
    const ok = alertClickAllowed({ alertText: el.alert.text, button: el.label, hasSecureField: el.alert.hasSecure, owner: el.alert.owner, decisions });
    if (action !== 'click' || !ok.ok) return refuse('app-protected', `alert: ${ok.why || 'only clicks answer an alert'}`);
  } else if (L.prot && !['open_app', 'activate'].includes(action)) {
    return refuse('app-protected', `${L.prot.app}: ${L.prot.why}`);
  }
  if (action === 'type_text' && el?.role === 'securetextfield') return refuse('input-invalid', '$.element: a password field takes type_secret (a Keychain item name), never text', { path: '$.element' });
  let pid = el?.at?.pid || L.target?.pid;
  const background = L.target && L.front && L.target.pid !== L.front.pid;
  const BG_PERFORM = [...PRESSY, 'AXCancel', 'AXIncrement', 'AXDecrement'];
  const bgClass = (background && !el?.alert && (
    (action === 'click' && el && input.button !== 'right' && ((input.count || 1) === 1 || (input.count === 2 && (el.actions || []).includes('AXOpen'))))
    || (action === 'perform' && BG_PERFORM.includes(input.action))
    || (action === 'set_value' && el && el.role !== 'securetextfield')));
  // The pointer never moves for an app that isn't in front, whatever the gate says: a click or scroll at its
  // coordinates lands on whatever is in front there (a background double-click once fell back to a pointer click
  // on the live screen). Such actions are AX-only or they fail.
  const pointer = (op, a) => (background && !el?.alert
    ? { ok: false, error: 'pointer-in-background', message: `${el?.ref || action}: ${L.target?.name || 'this app'} isn't in front, so this would move the pointer over another app. Fix: use an AX action (click with count 1 presses it; perform), or activate the app first when nobody is at the Mac` }
    : E.req(op, a));
  const run = async ({ background: quiet = false } = {}) => {
    switch (action) {
      case 'click': {
        const acts = el.actions || [];
        const count = input.count || 1;
        if (input.button === 'right') return el.frame ? pointer('click', { x: center(el.frame)[0], y: center(el.frame)[1], button: 'right' }) : { ok: false, error: 'no-frame' };
        if (count === 2 && acts.includes('AXOpen')) return { ...(await E.req('perform', { pid, path: el.at.p, action: 'AXOpen' })), how: 'AXOpen' };
        if (count === 1 && el.alert) {
          // A prompt: press it first (no pointer); the pointer only when nobody is at the Mac and macOS ignored the press.
          const viaAx = await E.req('perform', { pid, path: el.at.p, action: 'AXPress' });
          await sleep(300);
          const still = ((await E.req('windows')).windows || []).some((w) => w.pid === el.at.pid && isAlert(w));
          if (viaAx.ok && !still) return { ...viaAx, how: 'AXPress' };
          if (quiet) return { ok: false, error: 'needs-hardware', message: `macOS ignored the press on ${el.ref} and a person is at the Mac, so it isn't clicked with the pointer` };
        }
        if (count === 1 && !el.alert) {
          const viaAx = await E.req('perform', { pid, path: el.at.p, action: 'AXPress' });
          if (viaAx.ok) return { ...viaAx, how: 'AXPress' };
          if (quiet) return { ...viaAx, how: 'AXPress' };
        }
        if (!el.frame) return { ok: false, error: 'no-press-no-frame', message: `${el.ref} has no press action and no frame to click` };
        const [x, y] = center(el.frame);
        if (quiet) return { ok: false, error: 'person-active', message: `${el.ref} has no AX press here, and a pointer click needs nobody at the Mac` };
        const pc = await pointer('click', { x, y, count });
        return pc.ok ? { ...pc, how: `click at ${Math.round(x)},${Math.round(y)}` } : pc;
      }
      case 'perform': return E.req('perform', { pid, path: el.at.p, action: input.action });
      case 'set_value': {
        const v = el.role === 'checkbox' || el.role === 'switch' ? /^(1|true|on|yes)$/i.test(input.value) : input.value;
        return E.req('set', { pid, path: el.at.p, value: v });
      }
      case 'scroll': {
        const [x, y] = center(el.frame);
        const n = input.amount || 5;
        return pointer('scroll', { x, y, dy: input.direction === 'up' ? n : input.direction === 'down' ? -n : 0, dx: input.direction === 'left' ? n : input.direction === 'right' ? -n : 0 });
      }
      case 'type_text': {
        if (el) { const fo = await E.req('focus', { pid, path: el.at.p }); if (!fo.ok) await E.req('perform', { pid, path: el.at.p, action: 'AXPress' }); }
        return E.req('type', { text: input.text, ...(background ? { pid } : {}) }, 15000);
      }
      case 'type_secret': {
        if (!(L.base.secrets || []).includes(input.keychain_item)) return { ok: false, error: 'not-allowed' };
        const s = await secret(input.keychain_item);
        if (s == null) return { ok: false, error: 'no-keychain-item', message: `no Keychain item "${input.keychain_item}" on this Mac` };
        if (el) await E.req('focus', { pid, path: el.at.p });
        const r = await E.req('type', { text: s }, 15000);
        return { ok: r.ok, error: r.error };
      }
      case 'press_key': return E.req('key', { combo: input.key, ...(background ? { pid } : {}) });
      case 'menu': {
        const m = L.menuMap.get(input.item);
        return m ? E.req('perform', { pid: m.pid, path: m.p, action: 'AXPress' }) : { ok: false, error: 'no-menu-item' };
      }
      case 'open_app': {
        const p = L.installedMap.get(input.app);
        return p ? E.req('open', { path: p }, 10000) : { ok: false, error: 'not-installed' };
      }
      case 'activate': {
        const a = pickApp(L.apps, input.app);
        return a ? E.req('raise', { pid: a.pid }) : { ok: false, error: 'not-running' };
      }
      default: return { ok: false, error: 'unknown-action' };
    }
  };
  const io = gateIO || { load: G.loadState, save: G.saveState };
  const t1 = Date.now();
  let tRun = 0;
  // The element moved between the read and the act (a list refilling under a search): read again, act once more.
  const runFresh = async (mode) => {
    let x = await run(mode);
    if (x.error === 'no-element' && el) {
      L = await fresh();
      const f2 = resolveEl();
      if (!f2.error && !f2.e.alert) { el = f2.e; pid = el.at?.pid || L.target?.pid; x = await run(mode); }
    }
    return x;
  };
  const g = await gated(async (mode) => { const t = Date.now(); const x = await runFresh(mode); tRun = Date.now() - t; return x; }, { idleMin, read: gateRead ? async () => gateRead() : () => gateMachine(E), io, ours, background: bgClass });
  if (g.refused) return refuse(g.refused, g.message);
  const r = g.r;
  ms.act = tRun; ms.gate = Date.now() - t1 - tRun;
  const t2 = Date.now();
  const switching = action === 'open_app' || action === 'activate';
  const nextApp = switching ? null : (target || (L.target?.pid !== L.front?.pid ? L.target?.pid && L.target.name : null));
  const wantFront = switching ? input.app : null;
  if (switching) cache.menus.clear();
  const after = settleMode === 'none' ? await look({ ...lookOpts, app: nextApp })
    : await settle(() => look({ ...lookOpts, app: nextApp }), L, {
      quietMs: settleIn ?? (switching ? 300 : 100),
      maxMs: switching ? 4000 : 800,
      waitFor: wantFront ? (x) => x.front?.name === wantFront || x.front?.name?.toLowerCase().startsWith(String(wantFront).toLowerCase()) : null,
      probeFn: () => windowProbe(E),
    });
  ms.settle = Date.now() - t2; ms.total = Date.now() - T0;
  const bg = g.background ? { background: true } : {};
  if (!r.ok) return { code: 1, L: after, reply: { ok: false, failed: 'action-failed', action, message: r.message || r.error || 'failed', on: el?.ref || null, ms, ...bg } };
  return { code: 0, L: after, reply: { ok: true, action, on: el?.ref || null, how: r.how || null, ms, ...bg } };
}

// A batch step's `until`: Reins' dotted paths into the screen, plus `@<element>.<field>` (`@<element>` alone: it's
// on the screen), which names an element the way `element` does (ref, label or #index), so a condition survives
// the indexes moving as a screen fills in.
export function uiHolds(until, L, holds) {
  if (!until) return true;
  const plain = {};
  for (const [k, want] of Object.entries(until)) {
    // "$contains": "<text>": the screen shows it (a label or value, OCR's lines on the pixel layer). Case and
    // symbols count, so a typed field can be checked character for character.
    if (k === '$contains') {
      const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
      const w = norm(want);
      const texts = (L.elements || []).flatMap((e) => [e.label, e.value]).filter((t) => t != null).map(norm);
      if (!(texts.some((t) => t.includes(w)) || texts.join(' ').includes(w))) return false;
      continue;
    }
    if (!k.startsWith('@')) { plain[k] = want; continue; }
    const m = k.slice(1).match(/^(.*?)(?:\.(value|label|enabled|focused|selected|role|frame))?$/);
    const f = findElement(L.elements || [], m[1]);
    const got = !m[2] ? !f.error : f.error ? undefined : m[2] === 'enabled' ? f.e.enabled !== false : m[2] === 'focused' || m[2] === 'selected' ? Boolean(f.e[m[2]]) : f.e[m[2]];
    if (JSON.stringify(got) !== JSON.stringify(want)) return false;
  }
  return holds(plain, L.view);
}

// Many steps in one call: each { action, input, app?, until?, timeout_ms? }, or only { until } to wait. A step's
// `until` ({ "<dotted path into the screen>": value }, as in Reins' journeys) is polled here on the Mac, so a form
// fill or a whole journey is one round trip. Stops at the first refusal, failure or unmet until.
export async function batch(steps, opts = {}) {
  const E = opts.eng || (await engine());
  const t0 = Date.now();
  const results = [];
  let L = null, code = 0, reply = null;
  for (const [n, s] of (steps || []).entries()) {
    const ts = Date.now();
    if (s.action) {
      const last = n === (steps.length - 1);
      const r = await act(s.action, s.input || {}, { ...opts, eng: E, app: s.app || opts.app, settleMode: last || s.until ? 'full' : 'none' });
      L = r.L || L;
      results.push({ n, action: s.action, ok: r.code === 0, on: r.reply.on ?? null, how: r.reply.how ?? undefined, ms: Date.now() - ts, ...(r.code ? { refused: r.reply.refused, failed: r.reply.failed, message: r.reply.message, path: r.reply.path } : {}) });
      if (r.code) { code = r.code; reply = r.reply; break; }
    }
    if (s.until) {
      const end = Date.now() + (s.timeout_ms ?? 2000);
      L = L || (await look({ ...opts, eng: E, app: s.app || opts.app }));
      const ok = (x) => uiHolds(s.until, x, holds);
      while (!ok(L) && Date.now() < end) { await sleep(20); L = await look({ ...opts, eng: E, app: s.app || opts.app }); }
      if (!ok(L)) {
        code = 1;
        results.push({ n, until: s.until, ok: false, failed: 'until-not-met', ms: Date.now() - ts });
        reply = { ok: false, failed: 'until-not-met', step: n, until: s.until };
        break;
      }
      if (!s.action) results.push({ n, until: s.until, ok: true, ms: Date.now() - ts });
    }
  }
  L = L || (await look({ ...opts, eng: E }));
  return { code, L, reply: { ok: code === 0, ...(reply || {}), steps: results, ms: Date.now() - t0 } };
}

// ---------- the wire op (what a transport carries) ----------
// args: { cmd: ls|do|batch, app, menus, action, input, steps, idle, since, layer, host }. The reply (stdout, one
// JSON line) is { code, reply, screen } where screen is { rev, view } or { rev, diff } against `since`.

export function wireScreen(view, since, cache = CACHED) {
  const p = pack(view);
  rememberView(p, cache);
  const prev = since && cache.views.get(since);
  if (prev && prev.rev !== p.rev) return { rev: p.rev, diff: diffView(prev, p) };
  if (prev) return { rev: p.rev, same: true, context: p.context };
  return { rev: p.rev, view: p };
}

// Where the keyboard's focus is on this Mac: the front app and the role of its focused element (never its value or
// text), read even for apps whose content is protected, because it only decides whether keystrokes may be sent.
export async function focusFacts(E) {
  const f = (await E.req('front')).front;
  if (!f) return { ok: false, front: null, focused_role: null };
  const t = f.pid ? await E.req('tree', { pid: f.pid, maxNodes: 1500, maxDepth: 40, budgetMs: 1200 }, 4000) : {};
  // The focused node's subrole tells a password field (AXSecureTextField) from a plain one.
  // The app's AXFocusedUIElement decides the role; among nodes flagged focused (a window's last focus keeps its flag), the
  // one with that role, latest in reading order (a sheet comes after its window), gives the subrole.
  const focused = [];
  const walk = (n) => { if (!n) return; if (n.focused) focused.push(n); for (const c of n.children || []) walk(c); };
  for (const w of t.windows || []) walk(w);
  const role = t.focused_role || null;
  const node = [...focused].reverse().find((n) => n.role === role) || null;
  // An authentication sheet draws its fields in another process, so the app reports the sheet itself as focused; the
  // frames of its password fields let the pixel layer confirm the focus ring on the one meant (ui-pixels).
  const sheetSecure = [];
  const inSheet = (n, sheet) => { if (!n) return; const sh = sheet || n.role === 'AXSheet'; if (sh && (n.subrole === 'AXSecureTextField' || n.role === 'AXSecureTextField') && n.frame) sheetSecure.push(n.frame); for (const c of n.children || []) inSheet(c, sh); };
  if (role === 'AXSheet') for (const w of t.windows || []) inSheet(w, false);
  // The system-wide focused element reaches into the process that draws the sheet's fields.
  const sys = (await E.req('sysfocus').catch(() => null))?.focused || null;
  const secure = await secureInput().catch(() => null);
  return { ok: true, front: { name: f.name, bundle: f.bundle || null, pid: f.pid }, focused_role: role, focused_subrole: node?.subrole || null, system_focus: sys ? { ...sys, front: f.name, front_bundle: f.bundle || null, secure_input: secure } : null, ...(role === 'AXSheet' ? { sheet_secure: sheetSecure } : {}) };
}

// macOS turns on Secure Event Input while a password field has the keyboard focus, and names the process that owns
// it (kCGSSessionSecureInputPID). A password field drawn in another process (an authentication sheet's remote view)
// is invisible to accessibility; this still shows it is the one taking the keys. { pid, name } or null.
const run = (cmd, args) => new Promise((resolve) => { const c = spawn(cmd, args); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('error', () => resolve('')); c.on('close', () => resolve(o)); });
export async function secureInput({ exec = run } = {}) {
  const m = /"kCGSSessionSecureInputPID"=(\d+)/.exec(await exec('/usr/sbin/ioreg', ['-l', '-w', '0', '-d', '1']));
  if (!m) return null;
  const name = (await exec('/bin/ps', ['-p', m[1], '-o', 'comm='])).trim();
  return { pid: Number(m[1]), name: path.basename(name) || null };
}

// ---------- windows across a restart ----------
// An app restarted by a tool must come back where the person keeps it: same display, frame and full-screen state.
export async function appWindows(E, bundle) {
  const a = await E.req('apps');
  const app = (a.apps || []).find((x) => x.bundle === bundle);
  if (!app) return { ok: false, error: 'not-running', bundle };
  const r = await E.req('appwindows', { pid: app.pid });
  return { ok: !!r.ok, pid: app.pid, windows: r.windows || [] };
}

// Pure: which saved window each current one becomes (same title first, then by order), and what to set.
export function placementPlan(saved, current) {
  const left = [...saved];
  const steps = [];
  for (const w of current) {
    let i = left.findIndex((s) => s.title && s.title === w.title);
    if (i < 0) i = 0;
    const want = left.splice(i, 1)[0];
    if (!want) break;
    if (want.fullscreen) { if (!w.fullscreen) steps.push({ index: w.index, attr: 'AXFullScreen', value: true }); continue; }
    if (w.fullscreen) steps.push({ index: w.index, attr: 'AXFullScreen', value: false });
    const [x, y, wd, ht] = want.frame;
    if (!w.frame || w.frame[0] !== x || w.frame[1] !== y) steps.push({ index: w.index, attr: 'AXPosition', value: { x, y } });
    if (!w.frame || w.frame[2] !== wd || w.frame[3] !== ht) steps.push({ index: w.index, attr: 'AXSize', value: { w: wd, h: ht } });
  }
  return steps;
}

export async function placeWindows(E, bundle, saved, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const now = await appWindows(E, bundle);
  if (!now.ok) return now;
  const steps = placementPlan(saved, now.windows);
  const results = [];
  for (const st of steps) {
    // Position before size: a size that runs off the old display is clipped until the window has moved.
    const r = await E.req('set', { pid: now.pid, path: `w${st.index}`, attr: st.attr, value: st.value });
    results.push({ ...st, ok: !!r.ok, error: r.error || null });
    if (st.attr === 'AXFullScreen') await sleep(1500);
  }
  const after = await appWindows(E, bundle);
  const left = placementPlan(saved, after.windows || []);
  return { ok: left.length === 0, steps: results, windows: after.windows, unmet: left };
}

// One request as a transport carries it: { cmd: ls|do|batch|gate|focus|windows|place, ... } in, { exit, stdout } out,
// where stdout is one JSON line { code, reply, screen, ms }. `screen` is { rev, view } or { rev, diff } against `since`.
export async function busHandler(a = {}, { me = null } = {}) {
  const t0 = Date.now();
  const out = (code, reply, view) => ({ exit: code, stdout: JSON.stringify({ code, reply, screen: view ? wireScreen(view, a.since) : null, ms: Date.now() - t0 }) + '\n' });
  try {
    if (a.cmd === 'gate') return out(0, { ok: true, gate: await gateMachine(await engine()) });
    if (a.layer === 'pixels') {
      const P = await import('./pixels.mjs');
      const E = await engine();
      const drv = await P.localDriver(E);
      if (!drv) return out(2, { ok: false, refused: 'permission-missing', message: 'this Mac\'s agent may not record its screen, so it has no local pixel layer. Fix: ' + PERMISSION_FIX });
      const ocr = P.engineOcr(E);
      if (a.cmd === 'do') { const r = await P.pixelDo(a.action, a.input || {}, { driver: drv, ocr, host: a.host || me || 'local', idleMin: a.idle || 90, gateFor: async () => gateMachine(E), focusFor: async () => focusFacts(E) }); return out(r.code, r.reply, r.view); }
      const v = await P.pixelLook({ driver: drv, ocr, host: a.host || me || 'local', gate: await gateMachine(E) });
      return out(0, { ok: true }, v.view);
    }
    if (a.cmd === 'focus') { const r = await focusFacts(await engine()); return out(0, r); }
    if (a.cmd === 'windows') { const r = await appWindows(await engine(), a.bundle); return out(r.ok ? 0 : 1, r); }
    if (a.cmd === 'place') { const r = await placeWindows(await engine(), a.bundle, a.windows || []); return out(r.ok ? 0 : 1, r); }
    const common = { app: a.app, idleMin: a.idle || 90, me, host: a.host || me || 'local', ours: a.ours ?? null };
    if (a.cmd === 'ls') { const L = await look({ ...common, menus: a.menus !== false }); return out(0, { ok: true }, L.view); }
    if (a.cmd === 'do') { const r = await act(a.action, a.input || {}, common); return out(r.code, r.reply, r.L?.view); }
    if (a.cmd === 'batch') { const r = await batch(a.steps || [], common); return out(r.code, r.reply, r.L?.view); }
    return out(2, { ok: false, refused: 'input-invalid', path: '$.cmd', message: 'cmd is ls, do or batch' });
  } catch (e) {
    return out(1, { ok: false, failed: 'action-failed', message: e.message });
  }
}

// ---------- Reins' reply shape ----------
// Internally a refusal is { refused | failed, message, path?, available? }; on the wire it is Reins' (and Ouro AX's)
// problem: { code, exit, thing, problem, fix, message }, plus the code's own fields. Same as OuroReins' ReinsReply.
export function problemOf(r, action = null) {
  const code = r?.refused || r?.failed;
  if (!code) return null;
  const exit = r.refused ? 2 : 1;
  const thing = action ? `do ${action}` : 'request';
  const raw = String(r.message || code);
  const m = raw.match(/^([\s\S]*?)\.?\s*Fix:\s*([\s\S]*?)\.?$/);
  const problem = (m ? m[1] : raw).replace(/\.$/, '');
  const fix = m ? m[2] : null;
  const e = { code, exit, thing, problem, fix, message: `${thing}: ${problem}.${fix ? ` Fix: ${fix}.` : ''}` };
  for (const k of ['path', 'available', 'schema', 'step', 'until', 'layer']) if (r[k] !== undefined) e[k] = r[k];
  return e;
}

export function wireReply(r, action = null) {
  const { refused: _r, failed: _f, message: _m, path: _p, available: _a, schema: _s, until: _u, ...rest } = r || {};
  const e = problemOf(r, action);
  const out = { ...rest, ok: !e && r?.ok !== false };
  if (e) out.error = e;
  if (Array.isArray(rest.steps)) out.steps = rest.steps.map((x) => { const pe = problemOf(x, x.action); const { refused: _a1, failed: _b1, message: _c1, path: _d1, ...y } = x; return pe ? { ...y, error: pe } : y; });
  return out;
}

// ---------- the client (any Mac, through a transport) ----------

export const screenFile = (host, dir = CACHE) => path.join(dir, `screen-${host.replace(/[^\w.-]/g, '_')}.json`);
export function readScreen(host, dir) { try { return JSON.parse(fs.readFileSync(screenFile(host, dir), 'utf8')); } catch { return null; } }
export function writeScreen(host, view, dir = CACHE) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = screenFile(host, dir);
  fs.writeFileSync(`${f}.new-${process.pid}`, JSON.stringify(view));
  fs.renameSync(`${f}.new-${process.pid}`, f);
}

// The full (unpacked) view from a wire screen and the cached one; null if the diff can't be applied.
export function expand(wire, cached) {
  if (!wire) return null;
  if (wire.view) return wire.view;
  if (wire.same && cached?.rev === wire.rev) return { ...cached, context: wire.context || cached.context };
  if (wire.diff && cached?.rev === wire.diff.since) return applyDiff(cached, wire.diff);
  return null;
}

export function lastJsonLine(text) {
  for (const l of String(text || '').trim().split('\n').reverse()) { try { return JSON.parse(l); } catch { /* not JSON */ } }
  return null;
}

// A transport carries one request to the Mac that holds the engine and brings back { ok, exit, stdout }.
// Local: this process. Command: any shell command that runs `hackamore wire` on that Mac, such as
// `ssh mini hackamore wire`; the request is one JSON line on its stdin.
export const localTransport = async (args) => ({ ok: true, ...(await busHandler(args)), via: 'local' });
export function commandTransport(command, { spawnFn = spawn } = {}) {
  return (args, { timeoutMs = 15000 } = {}) => new Promise((resolve) => {
    const p = spawnFn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ ok: false, exit: 1, stdout, message: `no reply within ${timeoutMs} ms from \`${command}\``, via: command }); }, timeoutMs);
    p.stdout.on('data', (b) => { stdout += b; });
    p.stderr.on('data', (b) => { stderr += b; });
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, exit: 1, stdout, message: e.message, via: command }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, exit: code, stdout, message: stderr.trim().slice(-300) || undefined, via: command }); });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(args) + '\n');
  });
}

export async function callUi(host, args, { transport = localTransport, timeoutMs = 15000, dir = CACHE, useCache = true } = {}) {
  const cached = useCache ? readScreen(host, dir) : null;
  // The KVM's pixel layer marks its own input here on the controller; the Mac counts it as ours, not a person's.
  let ours = null;
  if (transport !== localTransport) { const G = await import('./gate.mjs'); const P = await import('./pixels.mjs'); ours = G.oursOf(G.loadState(P.gateFile(host))); }
  const go = async (since) => {
    const r = await transport({ ...args, host, since: since || undefined, ...(ours ? { ours } : {}) }, { timeoutMs });
    return { r, j: lastJsonLine(r.stdout || '') };
  };
  let { r, j } = await go(cached?.rev);
  let view = j ? expand(j.screen, cached) : null;
  if (j && j.screen && !view) { ({ r, j } = await go(null)); view = j ? expand(j.screen, null) : null; }
  if (view) writeScreen(host, view, dir);
  if (!j) return { name: host, via: r.via, exit: r.ok ? 1 : (r.exit || 1), reply: { ok: false, failed: 'action-failed', message: r.message || r.code || 'no reply from that Mac' } };
  return { name: host, via: r.via, exit: j.code, reply: j.reply, view: view ? unpack(view) : null, wire: j.screen, server_ms: j.ms };
}

export function parseUiArgs(args) {
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const flags = ['--record', '--layer', '--idle', '--app', '--via', '--as', '--kvm'];
  const pos = args.filter((x, i) => !x.startsWith('--') && !flags.includes(args[i - 1]));
  return { pos, record: val('--record'), layer: val('--layer') || 'auto', idle: val('--idle') ? Number(val('--idle')) : 90, app: val('--app'), via: val('--via'), as: val('--as'), kvm: val('--kvm'), menus: !args.includes('--no-menus'), diff: args.includes('--diff') };
}

// Pixel layer from a KVM, through housesitter: the pixels and keys go there, the gate and the focus checks still come
// from the Mac through the transport.
async function viaKvm(host, cmd, p, transport) {
  try {
    const P = await import('./pixels.mjs');
    const G0 = await import('./gate.mjs');
    const drv = await P.housesitterDriver(p.kvm);
    // OCR needs no permission, so a resident agent here does it with Vision already loaded; a fresh engine pays Vision's first load.
    const E = await engine();
    const ocr = P.engineOcr(E);
    // Secrets for a Mac driven through its KVM are read here, on the controller, from its own Keychain, and go to the
    // KVM's keyboard: never argv, never the transport.
    const secrets = secretsFor();
    const sec = { secrets, secret: keychainSecret, settleMs: Number(process.env.HACKAMORE_PIXEL_SETTLE_MS || 250) };
    const gateFor = P.remoteGate(transport, host);
    if (cmd === 'ls') {
      const [g, v] = await Promise.all([gateFor(), P.pixelLook({ driver: drv, ocr, host, gate: null, secrets })]);
      if (g) v.view.context.person = { active: !G0.verdict(g).open, idle_s: g.idle ?? null, why: G0.verdict(g).why };
      return { code: 0, reply: { ok: true }, view: v.view };
    }
    // A fresh read of the driven Mac's focus before every keystroke action (pixels.mjs keyboardGuard); none: nothing typed.
    const focusFor = async () => { const r = await callUi(host, { cmd: 'focus' }, { transport, useCache: false }); return r.reply?.ok ? r.reply : null; };
    if (cmd === 'batch') return await P.pixelBatch(p.steps, { driver: drv, ocr, host, idleMin: p.idle, gateFor, focusFor, ...sec });
    return await P.pixelDo(p.action, p.input, { driver: drv, ocr, host, idleMin: p.idle, gateFor, focusFor, ...sec });
  } catch (e) {
    return { code: e.refused ? 2 : 1, reply: { ok: false, ...(e.refused ? { refused: e.refused } : { failed: 'action-failed' }), layer: 'pixels', message: e.message } };
  }
}

export const USAGE = "usage: hackamore ls [app] [--layer auto|ax|pixels] [--no-menus] [--diff]\n       hackamore do <action> '<json>' [--app A] [--record <file>] [--idle 90] [--diff]\n       hackamore batch '<json array of {action,input,until?,app?}>' [--record <file>] [--diff]\n       add --via '<command that runs `hackamore wire` on the Mac>' (for example 'ssh mini hackamore wire') to drive another Mac, and --kvm <name> for the pixels of a housesitter KVM";

// A recorded journey is a JSON array of steps; `hackamore journey <file>` replays it as one batch.
export function recordStep(file, step) {
  let steps = [];
  try { steps = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  steps.push(step);
  fs.writeFileSync(file, JSON.stringify(steps, null, 2) + '\n');
  return { file, steps: steps.length };
}

export async function cmdUiReins(sub, args, deps = {}) {
  const p = parseUiArgs(args);
  const [a1, a2] = p.pos;
  const t0 = Date.now();
  const transport = deps.transport || (p.via ? commandTransport(p.via) : localTransport);
  const host = p.as || (p.via ? `via-${createHash('sha256').update(p.via).digest('hex').slice(0, 8)}` : 'local');
  const remote = transport !== localTransport;
  const remotePixels = Boolean(p.kvm);
  const call = deps.call || ((h, a) => callUi(h, a, { transport }));
  const print = deps.print || ((o) => console.log(JSON.stringify(o, null, 2)));
  const parse = (txt, what) => { try { return { v: JSON.parse(txt) }; } catch { return { err: { ok: false, refused: 'input-invalid', path: '$', message: `$: ${what} isn't JSON: ${String(txt).slice(0, 80)}` } }; } };
  let inp = null, st = null;
  if (sub === 'do') {
    if (!a1) throw new Error(USAGE);
    inp = a2 ? parse(a2, 'the input') : { v: {} };
    if (inp.err) { print(inp.err); return 2; }
  } else if (sub === 'batch') {
    st = a1 ? parse(a1, 'the steps') : { err: { ok: false, refused: 'input-invalid', path: '$', message: 'batch takes a JSON array of steps' } };
    if (st.err) { print(st.err); return 2; }
  } else if (sub !== 'ls') throw new Error(USAGE);
  const once = async () => {
    let x = null;
    if (sub === 'ls') {
      x = remotePixels ? await viaKvm(host, 'ls', p, transport) : null;
      if (!x) x = await call(host, { cmd: 'ls', app: a1 || p.app, menus: p.menus, layer: p.layer === 'pixels' ? 'pixels' : 'ax' });
    } else if (sub === 'do') {
      x = remotePixels ? await viaKvm(host, 'do', { ...p, action: a1, input: inp.v }, transport) : null;
      if (!x) x = await call(host, { cmd: 'do', action: a1, input: inp.v, app: p.app, idle: p.idle, layer: p.layer === 'pixels' ? 'pixels' : 'ax' });
    } else {
      x = remotePixels ? await viaKvm(host, 'batch', { ...p, steps: st.v }, transport) : null;
      if (!x) x = await call(host, { cmd: 'batch', steps: st.v, app: p.app, idle: p.idle });
    }
    return x;
  };
  let r = await once();
  if (sub === 'ls' && p.layer === 'auto' && r.view?.state?.layer === 'none' && p.kvm) { const k = await viaKvm(host, 'ls', p, transport).catch(() => null); if (k) r = k; }
  // Locked: nothing ran. The caller may unlock it (deps.onLocked) and have it tried once more. Only on this path, so
  // an unlocked Mac pays no extra round trip.
  if (sub !== 'ls' && r?.reply?.refused === 'screen-locked' && !(r.reply.steps || []).some((x) => x.ok) && deps.onLocked) {
    const u = await deps.onLocked();
    if (u === 'printed') return 2;
    if (u) r = await once();
  }
  const code = r.exit ?? r.code ?? 1;
  const timing = { via: r.via || (remotePixels ? 'kvm' : remote ? 'transport' : 'local'), e2e_ms: Date.now() - t0, server_ms: r.server_ms ?? null };
  let out;
  if (sub === 'ls') out = p.diff && r.wire?.diff ? { diff: r.wire.diff, ...timing } : r.view ? { ...r.view, timing } : { ...wireReply(r.reply, 'ls'), timing };
  else out = { ...wireReply(r.reply, sub === 'do' ? a1 : 'batch'), ...timing, screen: p.diff && r.wire?.diff ? { diff: r.wire.diff } : r.view };
  if (code === 0 && p.record && sub !== 'ls') {
    const steps = sub === 'batch' ? st.v : [{ action: a1, input: inp.v }];
    for (const s of steps) {
      if (!s.action) continue;
      const step = { action: s.action, input: s.input || {} };
      if (s.app || p.app) step.app = s.app || p.app;
      if (s.until) step.until = s.until;
      out.recorded = (deps.record || recordStep)(p.record, step);
    }
  }
  print(out);
  return code;
}

// Replays a recorded journey (a JSON array of steps) as one batch.
export async function journeyBatch(host, steps, { call = callUi } = {}) {
  const r = await call(host, { cmd: 'batch', steps: steps.map((s) => ({ action: s.action, input: s.input || {}, app: s.app, until: s.until })) });
  return { code: r.exit, reply: { ...r.reply, screen: r.view } };
}
