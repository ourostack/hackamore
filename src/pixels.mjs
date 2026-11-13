// The pixel layer of hackamore: the same ls/do vocabulary when a Mac has no usable accessibility tree (before login,
// FileVault, canvas or Electron surfaces, a hung WindowServer, or an agent with no Accessibility grant).
// A screenshot, Apple Vision's text boxes as clickable elements (role "text", ref text[Label]), and input through a
// pixel driver. The state says "layer":"pixels".
// A pixel driver is { name, screenshot(), click(x, y, { button, count }), type(text), key(combo), scroll?(x, y, dy, dx) }
// with every coordinate in the screenshot's own pixel space; screenshot() returns { file } or { image: Buffer }
// (PNG or JPEG), plus width/height when it knows them.
// Drivers: localDriver (a Mac's own screen, where the Ouro Reins Agent may record the screen and post input) and
// housesitterDriver (an IP-KVM through housesitter: HDMI capture and USB keyboard/mouse, which need no permission on
// the Mac at all, so it works at FileVault, the login window and on a Mac with no grants).

import { spawn } from 'node:child_process';
const SHEET_DRAWERS = ['coreautha', 'LocalAuthenticationRemoteService', 'SecurityAgent', 'loginwindow'];
import fs from 'node:fs';
import path from 'node:path';
import * as G from './gate.mjs';
import * as U from './ax.mjs';
import { holds } from './validate.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- OCR text → elements (pure) ----------

export function pixelElements(lines, { minConf = 0.3, max = U.MAX_ELEMENTS } = {}) {
  const out = [];
  for (const l of lines || []) {
    const label = String(l.text || '').replace(/\s+/g, ' ').trim();
    if (!label || (l.conf != null && l.conf < minConf)) continue;
    const [x, y, w, h] = l.box;
    if (w <= 0 || h <= 0) continue;
    const short = label.length > 60 ? `${label.slice(0, 59)}…` : label;
    out.push({ role: 'text', label: short, frame: [x, y, w, h], can: ['click'], full: `text[${short.replace(/[[\]]/g, '')}]`, at: { box: [x, y, w, h] } });
  }
  // reading order: top to bottom, then left to right (rows within half a line height)
  out.sort((a, b) => (Math.abs(a.frame[1] - b.frame[1]) < Math.min(a.frame[3], b.frame[3]) / 2 ? a.frame[0] - b.frame[0] : a.frame[1] - b.frame[1]));
  const counts = new Map();
  for (const e of out) {
    const c = (counts.get(e.full) || 0) + 1;
    counts.set(e.full, c);
    e.ref = c > 1 ? `${e.full}#${c}` : e.full;
  }
  const kept = out.slice(0, max);
  kept.forEach((e, i) => { e.i = i; });
  return kept;
}

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// The front app, as the menu bar names it: the leftmost text in the top strip (OCR runs the app's name into its first
// menus, "Some App File Edit"). A protected app in front means the keyboard and clicks would drive it, which the
// owner's protected list refuses; only open_app (Spotlight, a system shortcut) brings another forward.
export function pixelFront(elements, shot = {}) {
  const H = shot.height || 0, W = shot.width || 0;
  const bar = elements.filter((e) => e.frame[1] + e.frame[3] <= Math.max(36, H * 0.03) && (!W || e.frame[0] < W * 0.3));
  if (!bar.length) return null;
  const first = bar.reduce((a, b) => (b.frame[0] < a.frame[0] ? b : a));
  const p = U.PROTECTED.find((x) => x.name && (first.label === x.name || first.label.startsWith(`${x.name} `)));
  return { menu_bar: first.label, ...(p ? { protected: { app: p.name, why: p.why } } : {}) };
}

export function pixelScreen({ host, shot, lines, gate = null, driver = 'unknown', ms = null, errors = [], secrets = [], now = Date.now() }) {
  const elements = pixelElements(lines);
  const gv = gate && !('open' in gate) ? { ...G.verdict(gate), idle: gate.idle } : gate;
  const view = U.uiScreen({ host, layer: 'pixels', elements, gate: gv, secrets, errors, now, note: `pixels from ${driver}: text found by OCR, clicked at the centre of its box; click also takes x/y in the screenshot's pixels` });
  view.state.screen = { width: shot.width, height: shot.height, source: driver };
  view.focus = 'screen';
  view.path = ['mac', host, 'screen'];
  view.actions = view.actions.filter((a) => !['open_app', 'activate', 'set_value', 'perform', 'scroll', 'menu'].includes(a.name));
  view.actions.push({ name: 'hover', input: obj({ element: elements.length ? { type: 'string', enum: elements.map((e) => e.ref) } : { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: shot.width || 20000 }, y: { type: 'integer', minimum: 0, maximum: shot.height || 20000 } }), title: 'move the pointer there without clicking (reveals a notification\'s close button)', from: 'screen' });
  const unattended = { type: 'boolean' };
  for (const a of view.actions) a.input.properties.unattended = unattended;
  // type_text answers whether OCR sees the text afterwards (`seen`); verify: true makes a miss a failure.
  const tt = view.actions.find((a) => a.name === 'type_text');
  if (tt) tt.input.properties.verify = { type: 'boolean' };
  // Keystrokes go wherever the Mac's focus is, which a picture can't show: each names the app it is meant for, and
  // pixelDo checks it against a fresh accessibility read of the driven Mac before sending anything (keyboardGuard).
  for (const a of view.actions) if (KEYBOARD.includes(a.name)) { a.input.properties.expect_app = { type: 'string', minLength: 1 }; a.input.required = [...new Set([...(a.input.required || []), 'expect_app'])]; }
  if (!view.actions.some((a) => a.name === 'click')) view.actions.unshift({ name: 'click', input: obj({ x: { type: 'integer', minimum: 0, maximum: shot.width || 20000 }, y: { type: 'integer', minimum: 0, maximum: shot.height || 20000 }, count: { type: 'integer', minimum: 1, maximum: 3 }, button: { type: 'string', enum: ['left', 'right'] }, unattended }), title: 'click at a point in the screenshot', from: 'screen' });
  else { const c = view.actions.find((a) => a.name === 'click'); c.input.properties.x.maximum = shot.width || 20000; c.input.properties.y.maximum = shot.height || 20000; }
  const front = pixelFront(elements, shot);
  if (front) view.state.front = front;
  if (front?.protected) {
    view.state.protected = front.protected;
    view.actions = [];
    view.state.note = `${front.protected.app} is in front: ${front.protected.why}. Nothing is offered: bring another app forward with "open -a <App>".`;
  }
  view.rev = U.revOf(view);
  view.context.ms = ms;
  return { view, elements };
}

// ---------- the keyboard guard ----------

// Actions that send keystrokes. A pixel layer sees a picture, not where the keyboard's focus is, so on 2026-11-09 a
// path and two Returns meant for System Settings' file picker landed in a chat window as a message.
export const KEYBOARD = ['type_text', 'type_secret', 'press_key'];
export const TEXT_ROLES = ['AXTextField', 'AXSecureTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'];

// Pure: may this keystroke action go to the Mac whose fresh focus facts are `focus` ({ front: { name, bundle },
// focused_role }, read after the last input and just before this one)? null when it may; otherwise the reason.
// Fails closed: no facts, another app in front, or no text field focused all refuse.
export function keyboardGuard(action, input = {}, focus = null) {
  if (!KEYBOARD.includes(action)) return null;
  if (!input.expect_app) return 'name the app the keystrokes are for (expect_app: its name or bundle id)';
  if (!focus || !focus.front) return 'the driven Mac\'s focus could not be read, so nothing is typed';
  const want = String(input.expect_app).toLowerCase();
  const front = [focus.front.name, focus.front.bundle].filter(Boolean).map((x) => String(x).toLowerCase());
  if (!front.includes(want)) return `${focus.front.name || focus.front.bundle} is in front, not ${input.expect_app}: nothing is typed`;
  // A secret needs the system-wide focused element to be a password field (an authentication sheet's field is drawn
  // by another process; only the system-wide focus reaches it). Nothing else counts, a picture least of all.
  if (action === 'type_secret') {
    const sys = focus.system_focus;
    return sys && (sys.subrole === 'AXSecureTextField' || sys.role === 'AXSecureTextField' || (sys.secure_input && SHEET_DRAWERS.includes(sys.secure_input.name))) ? null : `the keyboard focus is ${sys ? `${sys.role || 'nothing'} in ${sys.app || sys.bundle}` : 'unknown'}, not a password field: no secret is typed`;
  }
  if (!TEXT_ROLES.includes(focus.focused_role)) return `the focused element in ${focus.front.name} is ${focus.focused_role || 'nothing'}, not a text field: nothing is typed`;
  if (action === 'type_secret' && focus.focused_role !== 'AXSecureTextField' && focus.focused_subrole !== 'AXSecureTextField') return `the focused field in ${focus.front.name} is not a password field: no secret is typed`;
  return null;
}

// ---------- reading and acting ----------

async function shotFile(driver, cache = U.CACHE) {
  const s = await driver.screenshot();
  if (s.file) return s;
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const f = path.join(cache, `pixels-${process.pid}.img`);
  fs.writeFileSync(f, s.image);
  return { ...s, file: f };
}

export async function pixelLook({ driver, ocr, host, gate = null, secrets = [] }) {
  const t0 = Date.now();
  const s = await shotFile(driver);
  const o = await ocr(s.file);
  if (!o.ok) throw new Error(`ocr: ${o.error || 'failed'}`);
  return { ...pixelScreen({ host, shot: { width: o.width || s.width, height: o.height || s.height }, lines: o.lines, gate, driver: driver.name, ms: Date.now() - t0, secrets }), shot: s };
}

// gateFor() → gate.mjs machine facts ({ idle, locked, why, now }) of the Mac being driven, or null if unreadable
// (a Mac at FileVault or the login window can't answer). Unreadable is refused unless the caller asserts
// `unattended: true`, which it may only do when the Mac is provably not in use (down on Hub, at FileVault).
// The gate state for a Mac driven through pixels is kept on the Mac doing the driving, one file per driven Mac, so it
// never mixes with this Mac's own gate. KVM input resets the driven Mac's idle time like any keyboard, so the same
// marks tell our input from a person's.
export const gateFile = (host) => path.join(path.dirname(G.STATE), `pixels-${String(host).replace(/[^\w.-]/g, '_')}.json`);

// gate (optional): the driven Mac's gate facts already read for this step (a batch reads the next step's while this
// one settles). Otherwise they're read once, alongside the screenshot: one bus round trip a step, not three (the
// gate's 'post' mark is the Mac's clock at that read plus the time since, which needs no second read).
export async function pixelDo(action, input = {}, { driver, ocr, host, idleMin = 90, gateFor = async () => null, settleMs = 400, secret = null, secrets = [], gateIO = null, before: given = null, look = true, gate: prefetched, onActed = null, focusFor = async () => null }) {
  const io = gateIO || { load: () => G.loadState(gateFile(host)), save: (s) => G.saveState(s, gateFile(host)) };
  const tRead = Date.now();
  const [m, looked] = await Promise.all([prefetched !== undefined ? prefetched : gateFor(), given ? null : pixelLook({ driver, ocr, host, gate: null, secrets })]);
  const gate = m ? { ...G.verdict(m, { idleMin }), idle: m.idle } : null;
  const before = given || looked;
  const view = before.view;
  if (gate) view.context.person = { active: !gate.open, idle_s: gate.idle ?? null, why: gate.why };
  const refuse = (refused, message, extra = {}) => ({ code: 2, view, reply: { ok: false, refused, message, ...extra } });
  if (view.state.protected) return refuse('app-protected', `${view.state.protected.app}: ${view.state.protected.why}. Fix: bring another app forward with "open -a <App>".`);
  const offered = view.actions.find((a) => a.name === action);
  if (!offered) return refuse('action-unavailable', `${action} isn't available on the pixel layer. Fix: use one of: ${view.actions.map((a) => a.name).join(', ')}.`, { available: view.actions.map((a) => a.name) });
  const { settle_ms: settleIn, ...rest } = input;
  const bad = await U.validateInput(offered.input, rest);
  if (bad) return refuse('input-invalid', bad.message, { path: bad.path });
  if (!m && input.unattended !== true) {
    return refuse('person-active', `can't tell whether anyone is using ${host} (its gate didn't answer). Fix: pass "unattended": true only if it is provably not in use (down on Hub, at FileVault).`);
  }
  let el = null;
  if (input.element != null) {
    const f = U.findElement(before.elements, input.element);
    if (f.error) return refuse('input-invalid', `$.element: ${f.error}`, { path: '$.element' });
    el = f.e;
  }
  if (action === 'click' && !el && (input.x == null || input.y == null)) return refuse('input-invalid', '$: click needs element, or x and y', { path: '$' });
  if (action === 'type_text' && /password|passcode/i.test(view.state.elements.map((e) => e.label).join(' ')) && !el) {
    return refuse('input-invalid', '$.text: the screen asks for a password; secrets go through type_secret (a Keychain item name), never text', { path: '$.text' });
  }
  const run = async () => {
    // Read where the keyboard's focus is now, after any earlier input, and send nothing if it isn't the field meant.
    if (KEYBOARD.includes(action)) {
      let focus = null;
      try { focus = await focusFor(); } catch { focus = null; }
      const no = keyboardGuard(action, input, focus);
      if (no) return { ok: false, error: `focus-unverified: ${no}`, refused: 'focus-unverified' };
    }
    try {
      return await perform();
    } catch (e) { return { ok: false, error: e.message }; }
  };
  const perform = async () => {
    switch (action) {
      case 'click': {
        const [x, y] = el ? [el.frame[0] + el.frame[2] / 2, el.frame[1] + el.frame[3] / 2] : [input.x, input.y];
        await driver.click(Math.round(x), Math.round(y), { button: input.button || 'left', count: input.count || 1 });
        return { ok: true, how: `click at ${Math.round(x)},${Math.round(y)}` };
      }
      case 'type_text':
        if (el) await driver.click(Math.round(el.frame[0] + el.frame[2] / 2), Math.round(el.frame[1] + el.frame[3] / 2), { button: 'left', count: 1 });
        await driver.type(input.text, { expect: { app: input.expect_app } }); return { ok: true };
      case 'type_secret': {
        if (!secrets.includes(input.keychain_item) || !secret) return { ok: false, error: 'not-allowed' };
        const s = await secret(input.keychain_item);
        if (s == null) return { ok: false, error: 'no-keychain-item' };
        if (!driver.typeSecret) return { ok: false, error: 'this pixel driver has no secret path' };
        // Only into a screen that is asking for a password (the caller verifies which field on the picture first).
        if (!/password/i.test(view.state.elements.map((e) => e.label).join(' '))) return { ok: false, error: 'no password field on this screen: nothing typed' };
        await driver.typeSecret(s, { expect: { app: input.expect_app, secret: true } }); return { ok: true };
      }
      case 'press_key': await driver.key(input.key, { expect: { app: input.expect_app } }); return { ok: true };
      case 'hover': {
        if (!driver.move) return { ok: false, error: 'this pixel driver cannot move the pointer without clicking' };
        const [x, y] = el ? [el.frame[0] + el.frame[2] / 2, el.frame[1] + el.frame[3] / 2] : [input.x, input.y];
        if (x == null || y == null) return { ok: false, error: 'hover needs element, or x and y' };
        await driver.move(Math.round(x), Math.round(y)); return { ok: true, how: `pointer at ${Math.round(x)},${Math.round(y)}` };
      }
      default: return { ok: false, error: 'unknown-action' };
    }
  };
  let r;
  if (m) {
    let reads = 0;
    const read = async () => (reads++ === 0 ? m : { ...m, idle: 0, now: m.now + Math.ceil((Date.now() - tRead) / 1000) });
    const g = await U.gated(run, { idleMin, read, io, ours: m.ours ?? null });
    if (g.refused) return refuse(g.refused, `${host}: ${g.message}`);
    r = g.r;
  } else r = await run();
  if (r?.ok && onActed) onActed();
  await sleep(settleIn ?? settleMs);
  // look: false skips the read after (a batch step whose screen the next step reads anyway)
  const verifying = action === 'type_text' && r.ok;
  let after = look || verifying ? await pixelLook({ driver, ocr, host, gate, secrets }) : null;
  if (r?.refused) return { code: 2, view: after?.view ?? view, look: after, reply: { ok: false, refused: r.refused, action, message: r.error } };
  if (!r.ok) return { code: 1, view: after?.view ?? view, look: after, reply: { ok: false, failed: 'action-failed', action, message: r.error } };
  // kvmd answers a print before its keystrokes have all landed: read again until the text shows, within a budget
  // that grows with its length.
  let seen = verifying ? textSeen(input.text, after?.elements || []) : undefined;
  for (const t0 = Date.now(); verifying && seen !== true && Date.now() - t0 < verifyBudgetMs(input.text);) {
    await sleep(250);
    after = await pixelLook({ driver, ocr, host, gate, secrets });
    seen = textSeen(input.text, after.elements || []);
  }
  if (verifying && seen === false && input.verify === true) return { code: 1, view: after.view, look: after, reply: { ok: false, failed: 'action-failed', action, seen: false, message: `typed, but OCR doesn't see "${input.text}" on the screen afterwards (a wrong character, the wrong field, or text OCR can't read). Fix: look at the screen; select the field's text and type it again.` } };
  return { code: 0, view: after?.view ?? null, look: after, reply: { ok: true, action, on: el?.ref || null, how: r.how || null, ...(verifying ? { seen } : {}) } };
}

export const verifyBudgetMs = (text) => 1000 + 80 * String(text || '').length;

// Does the screen show this text? true; 'tail' when only its end is in sight; false. Compared the way OCR can read it:
// no whitespace (OCR drops spaces), and |, 1, l, I as one glyph and 0, O as another (OCR can't tell them apart).
// No dropped Shift makes one of those from another ({ -> [, ) -> 0, @ -> 2, | -> \, A -> a all still differ).
export const ocrNorm = (t) => String(t || '').replace(/\s+/g, '').replace(/[|lI1]/g, '1').replace(/[O0]/g, '0');
export function textSeen(text, elements) {
  const want = ocrNorm(text);
  if (!want) return true;
  const labels = elements.map((e) => ocrNorm(e.label));
  if (labels.some((l) => l.includes(want)) || labels.join('').includes(want)) return true;
  // A field narrower than the text scrolls its start out of sight: the whole visible line must be the text's end
  // (bar one or two glyphs clipped at the field's left edge), so a wrong character anywhere in sight still fails.
  for (const l of labels) for (let i = 0; i <= 2 && l.length < want.length; i++) { const v = l.slice(i); if (v.length >= 12 && want.endsWith(v)) return 'tail'; }
  return false;
}

// Steps on the pixel layer, as src/ax.mjs's batch does on the tree: each { action?, input?, until?, timeout_ms? }, an
// `until` checked against fresh screenshots (dotted paths or @<element>.<field>), stopping at the first refusal,
// failure or unmet until. Runs where the pixel driver is (the KVM's controller), one screenshot per step.
export async function pixelBatch(steps, opts) {
  const t0 = Date.now();
  const { driver, ocr, host, secrets = [] } = opts;
  const results = [];
  let lk = null, code = 0, reply = null, nextGate = null;
  const fresh = async () => {
    const m = await (opts.gateFor || (async () => null))();
    return pixelLook({ driver, ocr, host, gate: m ? { ...G.verdict(m, { idleMin: opts.idleMin ?? 90 }), idle: m.idle } : null, secrets });
  };
  for (const [n, st] of (steps || []).entries()) {
    const ts = Date.now();
    if (st.action) {
      const last = n === steps.length - 1;
      let r;
      const pre = nextGate;
      nextGate = null;
      // the next step's gate is read from the moment this step has acted, while it settles and is looked at
      const onActed = !last && opts.gateFor ? () => { nextGate = opts.gateFor().catch(() => null); } : null;
      try { r = await pixelDo(st.action, st.input || {}, { ...opts, before: lk, look: Boolean(last || st.until), onActed, ...(pre ? { gate: await pre } : {}) }); } catch (e) {
        // a screenshot or the KVM failing mid-batch: report the steps that ran, not only the error
        r = { code: 1, view: lk?.view ?? null, reply: { ok: false, failed: 'action-failed', action: st.action, message: e.message } };
      }
      lk = r.look || null;
      if (r.code) nextGate = null;
      results.push({ n, action: st.action, ok: r.code === 0, on: r.reply.on ?? null, ...(r.reply.seen != null ? { seen: r.reply.seen } : {}), ms: Date.now() - ts, ...(r.code ? { refused: r.reply.refused, failed: r.reply.failed, message: r.reply.message } : {}) });
      if (r.code) { code = r.code; reply = r.reply; lk = lk || { view: r.view }; break; }
    }
    if (st.until) {
      const end = Date.now() + (st.timeout_ms ?? 15000);
      lk = lk || (await fresh());
      const ok = (x) => U.uiHolds(st.until, { view: x.view, elements: x.elements }, holds);
      while (!ok(lk) && Date.now() < end) lk = await fresh();
      if (!ok(lk)) {
        code = 1;
        results.push({ n, until: st.until, ok: false, failed: 'until-not-met', ms: Date.now() - ts });
        reply = { ok: false, failed: 'until-not-met', step: n, until: st.until };
        break;
      }
      if (!st.action) results.push({ n, until: st.until, ok: true, ms: Date.now() - ts });
    }
  }
  if (!lk?.elements) { try { lk = await fresh(); } catch (e) { lk = { view: lk?.view ?? null }; if (!code) { code = 1; reply = { ok: false, failed: 'action-failed', message: e.message }; } } }
  return { code, view: lk.view, reply: { ok: code === 0, ...(reply || {}), steps: results, ms: Date.now() - t0 } };
}

// ---------- drivers ----------

export function engineOcr(E) {
  return (file) => E.req('ocr', { file }, 15000);
}

function screencapture(file) {
  return new Promise((resolve) => {
    const p = spawn('/usr/sbin/screencapture', ['-x', '-m', '-t', 'png', file], { stdio: 'ignore' });
    p.on('close', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

// A Mac's own screen, from the agent: needs Screen Recording (screenshot) and Accessibility (input).
export async function localDriver(E, { cache = U.CACHE } = {}) {
  const t = await E.req('trust');
  if (!t.ok || !t.screen_capture || !t.ax) return null;
  const scale = t.screens?.[0]?.scale || 1;
  const pt = (v) => v / scale;
  return {
    name: 'this Mac\'s screen',
    async screenshot() {
      fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
      const file = path.join(cache, `local-shot-${process.pid}.png`);
      if (!(await screencapture(file))) throw new Error('screencapture failed');
      return { file };
    },
    click: (x, y, { button = 'left', count = 1 } = {}) => E.req('click', { x: pt(x), y: pt(y), button, count }),
    type: (text) => E.req('type', { text }, 15000),
    key: (combo) => E.req('key', { combo }),
    scroll: (x, y, dy, dx) => E.req('scroll', { x: pt(x), y: pt(y), dy, dx }),
  };
}

// A KVM through housesitter (https://github.com/ourostack/housesitter): `open(name)` picks its transport. housesitter is
// optional; install it where you drive a Mac through its KVM. Its type() refuses anything that looks like a secret:
// a FileVault password is typed only by housesitter's own sitter.
export async function housesitterDriver(name, { load = async () => { try { return await import('@ouro.bot/housesitter'); } catch { return import('housesitter'); } } } = {}) {
  let H;
  try { H = await load(); } catch { throw Object.assign(new Error('housesitter isn\'t installed here. Fix: npm install -g github:ourostack/housesitter, then hackamore ls --kvm <name>'), { refused: 'permission-missing' }); }
  const k = await H.open(name);
  return {
    name: `${name}'s KVM (${k.via})`,
    // A KVM decodes a keyframe on demand and now and then can't; a read is safe to repeat.
    async screenshot() {
      let err;
      for (let n = 0; n < 3; n++) {
        try { const s = await k.screenshot(); return { image: s.image, width: s.width, height: s.height }; } catch (e) { err = e; await sleep(300); }
      }
      throw err;
    },
    click: (x, y, { button = 'left', count = 1 } = {}) => k.click(x, y, { button, double: count === 2 }),
    type: (t, o) => k.type(t, o),
    key: (c, o) => k.key(c, o),
    scroll: (x, y, dy, dx) => k.scroll(x, y, { direction: dy ? (dy > 0 ? 'up' : 'down') : (dx > 0 ? 'left' : 'right'), amount: Math.abs(dy || dx || 3) }),
    ...(typeof k.move === 'function' ? { move: (x, y) => k.move(x, y) } : {}),
  };
}

// The driven Mac's gate facts through the transport, or null when it can't answer (the pixel layer's usual case).
export function remoteGate(transport, host) {
  return async () => {
    try {
      const r = await transport({ cmd: 'gate', host }, { timeoutMs: 3000 });
      const j = r.stdout ? JSON.parse(String(r.stdout).trim().split('\n').pop()) : null;
      const g = j?.reply?.gate;
      return g && g.idle != null ? g : null;
    } catch { return null; }
  };
}
