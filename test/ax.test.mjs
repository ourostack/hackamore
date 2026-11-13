// Tests for hackamore's tree and pixel layers (src/ax.mjs, src/pixels.mjs). Hermetic: a fake engine, fake gate, fake
// pixel driver and fake transport; no accessibility calls, no screen, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An owner's config, as it would come from ~/.config/hackamore/config.json: one extra protected app, one tool whose
// prompts may be allowed, and one Keychain item type_secret may read.
process.env.HACKAMORE_CONFIG_JSON = JSON.stringify({
  protected: [{ match: '^com\\.example\\.vault', name: 'Example Vault', read: false, why: 'its owner asked agents to leave it alone' }],
  clients: ['example-tool'],
  prompt_decisions: [{ prompt: 'Example Sync would like to access files in your Documents folder', button: 'Allow', by: 'the owner' }],
});

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SWIFT = path.join(SRC, '..', 'swift');
const U = await import(path.join(SRC, 'ax.mjs'));
const P = await import(path.join(SRC, 'pixels.mjs'));
const R = await import(path.join(SRC, 'validate.mjs'));
const AG = await import(path.join(SRC, 'agent.mjs'));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hackamore-test-'));

// ---------- fixtures ----------

const FINDER = { pid: 101, name: 'Finder', bundle: 'com.apple.finder', active: true };
const VAULT = { pid: 202, name: 'Example Vault', bundle: 'com.example.vault', active: false };
const SETTINGS = { pid: 303, name: 'System Settings', bundle: 'com.apple.systempreferences', active: false };
const UNC = 404;

function finderWindow({ title = 'Downloads', search = '', extraRow = false, value = '' } = {}) {
  const rows = [
    { p: 'w0.2.0.0', role: 'AXRow', frame: [200, 100, 600, 20], children: [{ p: 'w0.2.0.0.0', role: 'AXCell', frame: [200, 100, 300, 20], children: [{ p: 'w0.2.0.0.0.0', role: 'AXTextField', value: 'report.pdf', frame: [220, 100, 200, 20] }] }] },
    { p: 'w0.2.0.1', role: 'AXRow', frame: [200, 120, 600, 20], children: [{ p: 'w0.2.0.1.0', role: 'AXCell', frame: [200, 120, 300, 20], children: [{ p: 'w0.2.0.1.0.0', role: 'AXTextField', value: 'notes.txt', frame: [220, 120, 200, 20] }] }] },
    // scrolled out of view: below the scroll area
    { p: 'w0.2.0.2', role: 'AXRow', frame: [200, 900, 600, 20], children: [{ p: 'w0.2.0.2.0', role: 'AXCell', frame: [200, 900, 300, 20], children: [{ p: 'w0.2.0.2.0.0', role: 'AXTextField', value: 'hidden.txt', frame: [220, 900, 200, 20] }] }] },
  ];
  if (extraRow) rows.unshift({ p: 'w0.2.0.9', role: 'AXRow', frame: [200, 80, 600, 20], children: [{ p: 'w0.2.0.9.0', role: 'AXCell', frame: [200, 80, 300, 20], children: [{ p: 'w0.2.0.9.0.0', role: 'AXTextField', value: 'new.txt', frame: [220, 80, 200, 20] }] }] });
  return [{
    p: 'w0', role: 'AXWindow', title, frame: [100, 50, 800, 600], children: [
      { p: 'w0.0', role: 'AXButton', subrole: 'AXCloseButton', frame: [108, 56, 14, 14], actions: ['AXPress'] },
      { p: 'w0.1', role: 'AXToolbar', frame: [100, 50, 800, 40], children: [
        { p: 'w0.1.0', role: 'AXButton', desc: 'Back', frame: [120, 60, 30, 20], actions: ['AXPress'], enabled: false },
        { p: 'w0.1.1', role: 'AXGroup', frame: [700, 60, 150, 22], children: [{ p: 'w0.1.1.0', role: 'AXTextField', subrole: 'AXSearchField', desc: 'Search', value: search || value, settable: true, frame: [700, 60, 150, 22], actions: ['AXConfirm'] }] },
        { p: 'w0.1.2', role: 'AXButton', desc: 'Share', frame: [650, 60, 30, 20], actions: ['AXPress', 'AXShowMenu'] },
      ] },
      { p: 'w0.2', role: 'AXScrollArea', frame: [200, 90, 700, 500], children: [{ p: 'w0.2.0', role: 'AXOutline', frame: [200, 90, 700, 500], children: rows }] },
      { p: 'w0.3', role: 'AXGroup', frame: [0, 0, 0, 0], children: [{ p: 'w0.3.0', role: 'AXButton', title: 'Ghost', actions: ['AXPress'], frame: [0, 0, 0, 0] }] },
      { p: 'w0.4', role: 'AXButton', title: 'OK', frame: [800, 600, 60, 20], actions: ['AXPress'] },
      { p: 'w0.5', role: 'AXButton', title: 'OK', frame: [700, 600, 60, 20], actions: ['AXPress'] },
      { p: 'w0.6', role: 'AXSecureTextField', secure: true, settable: true, desc: 'Password', frame: [300, 620, 200, 20] },
    ],
  }];
}

const uncWindow = (text, button = 'Allow') => [{ p: 'w0', role: 'AXWindow', subrole: 'AXSystemDialog', frame: [500, 300, 400, 200], children: [
  { p: 'w0.0', role: 'AXStaticText', value: text, frame: [520, 320, 360, 40] },
  { p: 'w0.1', role: 'AXButton', title: "Don't Allow", frame: [600, 450, 100, 24], actions: ['AXPress'] },
  { p: 'w0.2', role: 'AXButton', title: button, frame: [720, 450, 100, 24], actions: ['AXPress'] },
] }];

function fakeEngine({ ax = true, apps = [FINDER, VAULT, SETTINGS], front = FINDER, trees = {}, windows = [], menus = {}, fail = {} } = {}) {
  const calls = [];
  const state = { trees: { [FINDER.pid]: finderWindow(), ...trees } };
  const E = {
    calls, state,
    async req(op, a = {}) {
      calls.push([op, a]);
      if (fail[op]) return fail[op];
      switch (op) {
        case 'trust': return { ok: true, ax, screen_capture: true, screens: [{ scale: 2 }] };
        case 'apps': return { ok: true, apps, front };
        case 'front': return { ok: true, front };
        case 'windows': return { ok: true, windows };
        case 'tree': return { ok: true, windows: (typeof state.trees[a.pid] === 'function' ? state.trees[a.pid]() : state.trees[a.pid]) || [] };
        case 'menus': return { ok: true, menus: menus[a.pid] || [] };
        case 'idle': return { ok: true, idle: 300, locked: false, why: 'unlocked', now: 1000 };
        default: return { ok: true };
      }
    },
  };
  return E;
}

const MENUS = { [FINDER.pid]: [{ p: 'm0', title: 'Apple', items: [{ p: 'm0.0', title: 'About This Mac' }] }, { p: 'm1', title: 'File', items: [{ p: 'm1.0', title: 'New Finder Window' }, { p: 'm1.1', title: 'Open With', submenu: true }, { p: 'm1.2', title: 'Eject', enabled: false }] }] };

function world({ idle = 300, locked = false, gateStateInit = null, ...eo } = {}) {
  const E = fakeEngine({ menus: MENUS, ...eo });
  let gs = gateStateInit;
  const saved = [];
  const m = { idle, locked, why: locked ? 'screen locked' : 'unlocked', now: 10000 };
  return {
    E, saved, m,
    opts: {
      eng: E, host: 'testmac', me: 'testmac', cache: Object.assign(U.newCache(), { secrets: [] }),
      gateRead: () => m, gateState: () => gs, gateIO: { load: () => gs, save: (s) => { gs = s; saved.push(s); } },
      installed: () => new Map([['Finder', '/System/Library/CoreServices/Finder.app'], ['Example Vault', '/Applications/Example Vault.app'], ['TextEdit', '/System/Applications/TextEdit.app']]),
    },
  };
}

// ---------- pruning and addressing ----------

test('prune: drops hidden, zero-size and scrolled-out nodes; labels rows by their text; refs are short and unique', () => {
  const { elements } = U.prune(finderWindow(), { pid: 101 });
  const refs = elements.map((e) => e.ref);
  assert.ok(refs.includes('button[close]'), 'window controls are labelled by subrole');
  assert.ok(refs.includes('button[Back]'));
  assert.ok(refs.includes('searchfield[Search]'), 'the search field is a searchfield, not a group');
  assert.ok(refs.includes('row[report.pdf]'), 'a row is labelled by its first text');
  assert.ok(!refs.some((r) => /hidden\.txt/.test(r)), 'a row scrolled out of its scroll area is dropped');
  assert.ok(!refs.some((r) => /Ghost/.test(r)), 'zero-size subtrees are dropped');
  assert.ok(!refs.some((r) => /^group/.test(r)), 'unlabelled groups are not elements');
  assert.deepEqual(refs.filter((r) => r.startsWith('button[OK]')), ['button[OK]', 'button[OK]#2'], 'duplicates get an occurrence number');
  const back = elements.find((e) => e.ref === 'button[Back]');
  assert.equal(back.enabled, false);
  assert.deepEqual(back.at, { pid: 101, p: 'w0.1.0' }, 'the hidden address is the raw path');
  assert.ok(elements.every((e, i) => e.i === i));
  const pw = elements.find((e) => e.role === 'securetextfield');
  assert.ok(pw.can.includes('type_secret') && !pw.can.includes('set_value') && !pw.can.includes('type_text'), 'a password field takes only type_secret');
  assert.equal(pw.value, undefined, 'a password field never carries a value');
});

test('prune: a ref grows a parent segment only when the last segment is ambiguous', () => {
  const w = [{ p: 'w0', role: 'AXWindow', title: 'W', frame: [0, 0, 500, 500], children: [
    { p: 'w0.0', role: 'AXToolbar', frame: [0, 0, 500, 40], children: [{ p: 'w0.0.0', role: 'AXButton', desc: 'Add', actions: ['AXPress'], frame: [0, 0, 20, 20] }] },
    { p: 'w0.1', role: 'AXGroup', desc: 'Sidebar', frame: [0, 40, 100, 400], children: [{ p: 'w0.1.0', role: 'AXButton', desc: 'Add', actions: ['AXPress'], frame: [0, 50, 20, 20] }] },
  ] }];
  const refs = U.prune(w).elements.map((e) => e.ref);
  assert.deepEqual(refs, ['toolbar > button[Add]', 'group[Sidebar] > button[Add]']);
});

test('findElement: #index, exact ref, unique suffix for replays, and a clear error when ambiguous', () => {
  const { elements } = U.prune(finderWindow(), { pid: 101 });
  assert.equal(U.findElement(elements, '#0').e.i, 0);
  assert.equal(U.findElement(elements, 'button[Back]').e.ref, 'button[Back]');
  const fz = U.findElement(elements, 'toolbar > button[Back]');
  assert.equal(fz.e.ref, 'button[Back]');
  assert.equal(fz.fuzzy, true, 'a longer recorded path still finds the element');
  assert.match(U.findElement(elements, '#999').error, /isn't on this screen/);
  assert.match(U.findElement(elements, 'button[Nope]').error, /isn't on this screen/);
  assert.equal(U.findElement(elements, 'button[OK]#2').e.frame[0], 700);
});

test('ls: Reins shape, actions narrowed to what is on screen, menus as exact items', async () => {
  const w = world();
  const L = await U.look({ ...w.opts });
  const v = L.view;
  assert.deepEqual(Object.keys(v).sort(), ['actions', 'context', 'focus', 'path', 'rev', 'state']);
  assert.equal(v.state.layer, 'ax');
  assert.equal(v.focus, 'Downloads');
  assert.deepEqual(v.path, ['mac', 'testmac', 'Finder', 'Downloads']);
  assert.equal(v.state.app.name, 'Finder');
  assert.equal(v.context.person.active, false);
  const by = Object.fromEntries(v.actions.map((a) => [a.name, a]));
  assert.ok(by.click.input.properties.element.enum.includes('button[Back]'));
  assert.ok(by.click.input.properties.element.enum.includes('#0'));
  assert.deepEqual(by.set_value.input.properties.element.enum.filter((x) => !x.startsWith('#')), ['searchfield[Search]']);
  assert.deepEqual(by.menu.input.properties.item.enum, ['File > New Finder Window'], 'only enabled leaf items, never the Apple menu');
  assert.ok(!by.open_app.input.properties.app.enum.includes('Example Vault'), 'the protected app is never offered');
  assert.deepEqual(by.activate.input.properties.app.enum, ['System Settings'], 'activate: running apps, minus the front one and protected ones');
  assert.ok(!by.type_secret, 'type_secret only exists when the config names Keychain items');
  assert.match(by.press_key.input.properties.key.pattern, /cmd/);
  assert.equal(v.rev, U.revOf(v));
});

test('ls: an app the owner config protects is never read', async () => {
  const w = world({ front: VAULT });
  const L = await U.look({ ...w.opts });
  assert.ok(!w.E.calls.some(([op, a]) => op === 'tree' && a.pid === VAULT.pid), 'no tree read of the protected app');
  assert.equal(L.view.state.elements.length, 0);
  assert.equal(L.view.state.protected.read, false);
  assert.match(L.view.state.note, /asked agents to leave it alone/);
  assert.ok(!L.view.actions.some((a) => ['click', 'type_text', 'press_key'].includes(a.name)), 'nothing that would land in it');
  assert.ok(L.view.actions.some((a) => a.name === 'activate'), 'switching away is still offered');
});

test('ls: no Accessibility permission says so, with the person step, and offers nothing that needs it', async () => {
  const w = world({ ax: false });
  const L = await U.look({ ...w.opts });
  assert.equal(L.view.state.layer, 'none');
  assert.equal(L.view.state.ax.trusted, false);
  assert.match(L.view.state.ax.fix, /Accessibility/);
  assert.ok(!L.view.actions.some((a) => a.name === 'click'));
  const r = await U.act('click', { element: '#0' }, w.opts);
  assert.equal(r.code, 2);
  assert.equal(r.reply.refused, 'permission-missing');
});

test('ls: a waiting alert from our own tool is shown on top, with its buttons as elements', async () => {
  const w = world({ windows: [{ owner: 'UserNotificationCenter', layer: 8, pid: UNC, frame: [500, 300, 400, 200] }], trees: { [UNC]: uncWindow('"node" wants access to control "Example Browser".') } });
  const L = await U.look({ ...w.opts });
  assert.equal(L.view.state.alerts.length, 1);
  assert.match(L.view.state.alerts[0].text, /node/);
  assert.ok(L.view.state.elements.some((e) => e.ref === 'alert > button[Allow]'));
});

test('do: action-unavailable names what is available; input-invalid names the path', async () => {
  const w = world();
  let r = await U.act('drag', {}, w.opts);
  assert.equal(r.code, 2);
  assert.equal(r.reply.refused, 'action-unavailable');
  assert.ok(r.reply.available.includes('click'));
  r = await U.act('press_key', { key: 'cmd+banana' }, w.opts);
  assert.equal(r.reply.refused, 'input-invalid');
  assert.equal(r.reply.path, '$.key');
  r = await U.act('click', { element: 'button[Nope]' }, w.opts);
  assert.equal(r.reply.path, '$.element');
  r = await U.act('set_value', { element: 'button[Back]', value: 'x' }, w.opts);
  assert.equal(r.reply.refused, 'input-invalid', 'an element that cannot take the action is refused');
  r = await U.act('type_text', { element: 'securetextfield[Password]', text: 'hunter2' }, w.opts);
  assert.equal(r.reply.refused, 'input-invalid', 'text never goes into a password field');
  assert.ok(!w.E.calls.some(([op]) => op === 'type'), 'nothing was typed');
});

test('do: person-active when someone used the Mac recently; nothing is touched', async () => {
  const w = world({ idle: 4 });
  const r = await U.act('click', { element: 'button[Share]' }, w.opts);
  assert.equal(r.code, 2);
  assert.equal(r.reply.refused, 'person-active');
  assert.ok(!w.E.calls.some(([op]) => ['perform', 'click', 'key', 'type'].includes(op)));
});

test('do: app-protected for a configured app, a consent we did not raise, and System Settings security panes', async () => {
  let w = world({ front: VAULT });
  let r = await U.act('press_key', { key: 'cmd+w' }, w.opts);
  assert.equal(r.reply.refused, 'app-protected');
  assert.match(r.reply.message, /asked agents to leave it alone/);
  r = await U.act('open_app', { app: 'Example Vault' }, world().opts);
  assert.equal(r.reply.refused, 'app-protected');

  w = world({ windows: [{ owner: 'UserNotificationCenter', layer: 8, pid: UNC }], trees: { [UNC]: uncWindow('"Zoom" wants access to your camera.') } });
  r = await U.act('click', { element: 'alert > button[Allow]' }, w.opts);
  assert.equal(r.reply.refused, 'app-protected', 'a prompt that does not name our tool is not answered');
  w = world({ windows: [{ owner: 'UserNotificationCenter', layer: 8, pid: UNC }], trees: { [UNC]: uncWindow('"node" wants access to control "Example Browser".') } });
  r = await U.act('click', { element: "alert > button[Don't Allow]" }, w.opts);
  assert.equal(r.reply.refused, 'app-protected', 'only Allow/OK answers our own prompt');
  r = await U.act('click', { element: 'alert > button[Allow]' }, w.opts);
  assert.equal(r.code, 0, 'a known tool\'s prompt may be allowed');
  assert.ok(w.E.calls.some(([op, a]) => op === 'click' && a.x === 770), 'a real click at the button, not an AX press');

  w = world({ front: SETTINGS, trees: { [SETTINGS.pid]: [{ p: 'w0', role: 'AXWindow', title: 'Privacy & Security', frame: [0, 0, 600, 400], children: [{ p: 'w0.0', role: 'AXCheckBox', desc: 'Accessibility', settable: true, frame: [10, 10, 20, 20], actions: ['AXPress'] }] }] } });
  r = await U.act('click', { element: '#0' }, w.opts);
  assert.equal(r.reply.refused, 'app-protected');
  assert.match(r.reply.message, /security/);
});

test('do: click presses through AX at the resolved path, runs the gate protocol, and returns the settled screen', async () => {
  const w = world();
  let n = 0;
  w.E.state.trees[FINDER.pid] = () => (n++ > 0 ? finderWindow({ title: 'Documents' }) : finderWindow());
  await U.look({ ...w.opts });
  const r = await U.act('click', { element: 'button[Share]' }, w.opts);
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.equal(r.reply.how, 'AXPress');
  assert.ok(w.E.calls.some(([op, a]) => op === 'perform' && a.path === 'w0.1.2' && a.action === 'AXPress' && a.pid === FINDER.pid));
  assert.equal(r.L.view.focus, 'Documents', 'the reply carries the new screen');
  assert.ok(w.saved.length >= 2, 'gate pre and post were recorded');
  assert.ok(w.saved.at(-1).mark != null, 'post marks our input so the next action is not mistaken for a person');
});

test('do: set_value, menu, type_text into an element, press_key and open_app', async () => {
  const w = world();
  assert.equal((await U.act('set_value', { element: 'searchfield[Search]', value: 'pdf' }, w.opts)).code, 0);
  assert.ok(w.E.calls.some(([op, a]) => op === 'set' && a.path === 'w0.1.1.0' && a.value === 'pdf'));
  assert.equal((await U.act('menu', { item: 'File > New Finder Window' }, w.opts)).code, 0);
  assert.ok(w.E.calls.some(([op, a]) => op === 'perform' && a.path === 'm1.0'));
  assert.equal((await U.act('type_text', { element: 'searchfield[Search]', text: 'abc' }, w.opts)).code, 0);
  assert.ok(w.E.calls.some(([op, a]) => op === 'focus' && a.path === 'w0.1.1.0'));
  assert.ok(w.E.calls.some(([op, a]) => op === 'type' && a.text === 'abc'));
  assert.equal((await U.act('press_key', { key: 'cmd+w' }, w.opts)).code, 0);
  assert.ok(w.E.calls.some(([op, a]) => op === 'key' && a.combo === 'cmd+w'));
  const before = w.E.calls.length;
  const r = await U.act('open_app', { app: 'TextEdit' }, { ...w.opts });
  assert.equal(r.code, 0);
  assert.ok(w.E.calls.slice(before).some(([op, a]) => op === 'open' && a.path === '/System/Applications/TextEdit.app'));
});

test('do: a failed AX call is action-failed (exit 1) with the screen after it', async () => {
  const w = world({ fail: { set: { ok: false, error: 'ax--25200', message: 'setting AXValue failed' } } });
  const r = await U.act('set_value', { element: 'searchfield[Search]', value: 'x' }, w.opts);
  assert.equal(r.code, 1);
  assert.equal(r.reply.failed, 'action-failed');
  assert.ok(r.L.view);
});

test('do: a cached screen is reused (no second tree read before acting), and refreshed if its path went stale', async () => {
  const w = world();
  await U.look({ ...w.opts });
  const trees = () => w.E.calls.filter(([op]) => op === 'tree').length;
  const t0 = trees();
  await U.act('click', { element: 'button[Share]' }, { ...w.opts, settleMode: 'none' });
  assert.equal(trees() - t0, 1, 'only the read after the action');
  const t1 = trees();
  w.E.state.trees[FINDER.pid] = finderWindow({ extraRow: true });
  const r = await U.act('click', { element: 'row[new.txt]' }, { ...w.opts, settleMode: 'none' });
  assert.equal(r.code, 0, 'a ref missing from the cached screen triggers one fresh read');
  assert.equal(trees() - t1, 2);
});

test('type_secret reads the Keychain item on the Mac that types, only when the config allows the item', async () => {
  const w = world();
  w.opts.cache.secrets = ['mini-setup-filevault'];
  const asked = [];
  const r = await U.act('type_secret', { keychain_item: 'mini-setup-filevault', element: 'securetextfield[Password]' }, { ...w.opts, secret: async (k) => { asked.push(k); return 's3cret'; } });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.deepEqual(asked, ['mini-setup-filevault']);
  assert.ok(!JSON.stringify(r.reply).includes('s3cret'), 'the secret is never in a reply');
  const bad = await U.act('type_secret', { keychain_item: 'something-else' }, w.opts);
  assert.equal(bad.reply.refused, 'input-invalid');
});

test('settle: one read when nothing changed after the quiet time, a confirming read when it did', async () => {
  let t = 0;
  const seq = ['a', 'b', 'b'];
  let i = 0;
  const lookFn = async () => ({ view: { rev: seq[Math.min(i++, seq.length - 1)] } });
  const r = await U.settle(lookFn, 'a', { quietMs: 100, sleepFn: async (ms) => { t += ms; }, now: () => t });
  assert.equal(r.view.rev, 'b');
  i = 0;
  const same = async () => { i++; return { view: { rev: 'a' } }; };
  t = 0;
  await U.settle(same, 'a', { quietMs: 100, sleepFn: async (ms) => { t += ms; }, now: () => t });
  assert.ok(i >= 2 && i <= 6, `polled ${i} times`);
});

test('batch: a form fill is one call; until is checked on the Mac; it stops at the first refusal', async () => {
  const w = world();
  let value = '';
  w.E.state.trees[FINDER.pid] = () => finderWindow({ value });
  const orig = w.E.req;
  w.E.req = async (op, a) => { if (op === 'set') value = a.value; return orig(op, a); };
  const r = await U.batch([
    { action: 'set_value', input: { element: 'searchfield[Search]', value: 'pdf' } },
    { action: 'click', input: { element: 'button[Share]' } },
    { until: { 'state.window.title': 'Downloads' } },
  ], w.opts);
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.equal(r.reply.steps.length, 3);
  assert.equal(r.L.view.state.elements.find((e) => e.role === 'searchfield').value, 'pdf');
  const bad = await U.batch([
    { action: 'click', input: { element: 'button[Share]' } },
    { action: 'click', input: { element: 'button[Nope]' } },
    { action: 'click', input: { element: 'button[Share]' } },
  ], w.opts);
  assert.equal(bad.code, 2);
  assert.equal(bad.reply.steps.length, 2, 'stopped at the refusal');
  assert.equal(bad.reply.refused, 'input-invalid');
  const unmet = await U.batch([{ until: { focus: 'Elsewhere' }, timeout_ms: 120 }], w.opts);
  assert.equal(unmet.code, 1);
  assert.equal(unmet.reply.failed, 'until-not-met');
});

test('wire: enums travel as {$from} and are rebuilt; a diff carries only what changed and rebuilds the same screen', async () => {
  const w = world();
  const a = (await U.look({ ...w.opts })).view;
  const pa = U.pack(a);
  assert.ok(JSON.stringify(pa).length < JSON.stringify(a).length);
  assert.deepEqual(U.unpack(pa).actions, a.actions, 'unpack(pack(v)) restores every enum');
  w.E.state.trees[FINDER.pid] = finderWindow({ extraRow: true, search: 'x' });
  w.opts.cache.last = null;
  const b = (await U.look({ ...w.opts })).view;
  const pb = U.pack(b);
  const d = U.diffView(pa, pb);
  assert.ok(d.put.some((e) => e.ref === 'row[new.txt]'), 'the new row');
  assert.ok(d.put.some((e) => e.ref === 'searchfield[Search]' && e.value === 'x'), 'the changed value');
  assert.ok(!d.put.some((e) => e.ref === 'button[Back]'), 'an element that only moved index is not resent');
  assert.ok(JSON.stringify(d).length < JSON.stringify(pb).length / 2, 'a diff is much smaller than the screen');
  const rebuilt = U.applyDiff(pa, d);
  assert.deepEqual(U.unpack(rebuilt).state, b.state);
  assert.deepEqual(U.unpack(rebuilt).actions, b.actions);
  assert.throws(() => U.applyDiff({ rev: 'other' }, d), /diff is against/);
});

test('wire: busHandler-style screens: full first, then a diff or "same" against the rev the caller holds', async () => {
  const cache = U.newCache();
  const w = world();
  const v1 = (await U.look({ ...w.opts })).view;
  const s1 = U.wireScreen(v1, null, cache);
  assert.ok(s1.view);
  const s2 = U.wireScreen(v1, s1.rev, cache);
  assert.equal(s2.same, true);
  w.E.state.trees[FINDER.pid] = finderWindow({ title: 'Documents' });
  const v2 = (await U.look({ ...w.opts })).view;
  const s3 = U.wireScreen(v2, s1.rev, cache);
  assert.ok(s3.diff);
  const held = s1.view;
  assert.equal(U.expand(s3, held).focus, 'Documents');
  assert.equal(U.expand(s3, { rev: 'nope' }), null, 'a diff against another rev is not applied');
});

test('client: callUi sends the held rev, applies the diff, and falls back to a full screen if the Mac forgot it', async () => {
  const dir = scratch();
  const w = world();
  const cache = U.newCache();
  const sent = [];
  const transport = async (args) => {
    sent.push(args.since || null);
    const L = await U.look({ ...w.opts });
    const forget = sent.length === 3;
    return { ok: true, via: 'bus', stdout: JSON.stringify({ code: 0, reply: { ok: true }, screen: U.wireScreen(L.view, forget ? 'unknown' : args.since, cache), ms: 5 }) + '\n' };
  };
  const a = await U.callUi('testmac', { cmd: 'ls' }, { transport, dir });
  assert.equal(a.view.focus, 'Downloads');
  w.E.state.trees[FINDER.pid] = finderWindow({ title: 'Documents' });
  const b = await U.callUi('testmac', { cmd: 'ls' }, { transport, dir });
  assert.ok(b.wire.diff, 'the second call got a diff');
  assert.equal(b.view.focus, 'Documents');
  assert.deepEqual(sent.slice(0, 2), [null, a.wire.rev]);
  fs.writeFileSync(U.screenFile('testmac', dir), JSON.stringify({ rev: 'stale', state: {}, actions: [] }));
  const c = await U.callUi('testmac', { cmd: 'ls' }, { transport, dir });
  assert.equal(c.view.focus, 'Documents');
});

// ---------- the pixel layer ----------

function fakeDriver() {
  const calls = [];
  return { calls, name: 'fake KVM', screenshot: async () => ({ image: Buffer.from('png'), width: 1920, height: 1080 }), click: async (x, y, o) => calls.push(['click', x, y, o]), type: async (t) => calls.push(['type', t]), key: async (k) => calls.push(['key', k]) };
}
const LINES = [
  { text: 'Cancel', conf: 0.9, box: [900, 600, 80, 20] },
  { text: 'Finder', conf: 0.95, box: [40, 2, 60, 18] },
  { text: 'OK', conf: 0.9, box: [1000, 600, 40, 20] },
  { text: 'OK', conf: 0.9, box: [1000, 700, 40, 20] },
  { text: 'noise', conf: 0.1, box: [5, 5, 5, 5] },
];
const memIO = () => { let st = null; return { load: () => st, save: (x) => { st = x; } }; };
const fakeOcr = (lines = LINES) => async () => ({ ok: true, width: 1920, height: 1080, lines });

test('pixels: OCR text becomes elements in reading order, same Reins shape, layer "pixels"', async () => {
  const els = P.pixelElements(LINES);
  assert.deepEqual(els.map((e) => e.ref), ['text[Finder]', 'text[Cancel]', 'text[OK]', 'text[OK]#2']);
  const v = (await P.pixelLook({ driver: fakeDriver(), ocr: fakeOcr(), host: 'testmac', gate: { idle: 300, locked: false, why: 'unlocked' } })).view;
  assert.equal(v.state.layer, 'pixels');
  assert.equal(v.state.screen.width, 1920);
  const click = v.actions.find((a) => a.name === 'click');
  assert.ok(click.input.properties.element.enum.includes('text[Cancel]'));
  assert.equal(click.input.properties.x.maximum, 1920);
  assert.ok(!v.actions.some((a) => a.name === 'open_app'), 'no Spotlight typing on the pixel layer');
  assert.deepEqual(v.actions.find((a) => a.name === 'press_key').input.required, ['key', 'expect_app']);
  assert.equal(v.context.person.active, false);
});

test('pixels: click goes to the centre of the text box through the driver; type, keys and Spotlight open', async () => {
  const d = fakeDriver();
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  let r = await P.pixelDo('click', { element: 'text[OK]#2' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, settleMs: 0 });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.deepEqual(d.calls[0], ['click', 1020, 710, { button: 'left', count: 1 }]);
  r = await P.pixelDo('click', { x: 5, y: 6 }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, settleMs: 0 });
  assert.deepEqual(d.calls[1].slice(0, 3), ['click', 5, 6]);
  const focusFor = async () => FOCUS_TEXTEDIT;
  await P.pixelDo('press_key', { key: 'cmd+q', expect_app: 'TextEdit' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, focusFor, settleMs: 0 });
  r = await P.pixelDo('open_app', { app: 'TextEdit', settle_ms: 0 }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, settleMs: 0 });
  assert.equal(r.reply.refused, 'action-unavailable', 'open_app typed into Spotlight blind; gone from the pixel layer');
  assert.deepEqual(d.calls.slice(2).map((c) => c[0] + ':' + c[1]), ['key:cmd+q']);
});

const FOCUS_TEXTEDIT = { front: { name: 'TextEdit', bundle: 'com.apple.TextEdit' }, focused_role: 'AXTextArea' };

test('pixels: keystrokes go only where a fresh read shows the intended app in front with a text field focused', async () => {
  // A path and two Returns meant for a file picker once landed in a chat window.
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  const cases = [
    [{ text: 'x', expect_app: 'TextEdit' }, null, /could not be read/],
    [{ text: 'x', expect_app: 'TextEdit' }, { front: { name: 'Example Vault', bundle: 'com.github.githubapp' }, focused_role: 'AXTextArea' }, /Example Vault is in front, not TextEdit/],
    [{ text: 'x', expect_app: 'TextEdit' }, { front: FOCUS_TEXTEDIT.front, focused_role: 'AXButton' }, /AXButton, not a text field/],
    [{ text: 'x', expect_app: 'TextEdit' }, { front: FOCUS_TEXTEDIT.front }, /nothing, not a text field/],
  ];
  for (const [input, focus, why] of cases) {
    const d = fakeDriver();
    const r = await P.pixelDo('type_text', input, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, focusFor: async () => focus, settleMs: 0 });
    assert.equal(r.reply.refused, 'focus-unverified', JSON.stringify(r.reply));
    assert.match(r.reply.message, why);
    assert.deepEqual(d.calls, [], 'nothing reached the keyboard');
  }
  const d = fakeDriver();
  let r = await P.pixelDo('press_key', { key: 'return' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, focusFor: async () => FOCUS_TEXTEDIT, settleMs: 0 });
  assert.equal(r.reply.refused, 'input-invalid', 'a key names the app it is for');
  r = await P.pixelDo('press_key', { key: 'return', expect_app: 'com.apple.TextEdit' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, settleMs: 0 });
  assert.equal(r.reply.refused, 'focus-unverified', 'no focus reader: fail closed');
  let reads = 0;
  r = await P.pixelDo('type_text', { text: 'hello', expect_app: 'com.apple.TextEdit' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, focusFor: async () => { reads++; return FOCUS_TEXTEDIT; }, settleMs: 0 });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.equal(reads, 1, 'focus read just before the keystrokes');
  assert.deepEqual(d.calls, [['type', 'hello']]);
  assert.equal(P.keyboardGuard('click', {}, null), null, 'clicks are not keystrokes');
  assert.match(P.keyboardGuard('type_secret', { keychain_item: 'x', expect_app: 'System Settings' }, { front: { name: 'System Settings' }, focused_role: 'AXTextField', focused_subrole: null }), /not a password field/, 'a secret goes only into a password field');
  const sheet = { front: { name: 'System Settings' }, focused_role: 'AXSheet', sheet_secure: [[786, 877, 228, 24]] };
  const pw = { keychain_item: 'x', expect_app: 'System Settings' };
  // A click on a sheet's field did not move the focus; a chat box still had it.
  assert.match(P.keyboardGuard('type_secret', pw, { ...sheet, system_focus: { app: 'Example Vault', role: 'AXTextArea', pid: 834 } }), /AXTextArea in Example Vault, not a password field/);
  assert.match(P.keyboardGuard('type_secret', pw, { ...sheet, system_focus: { app: 'System Settings', role: 'AXSheet', pid: 1 } }), /not a password field/, 'the sheet itself is not its field');
  assert.equal(P.keyboardGuard('type_secret', pw, { ...sheet, system_focus: { role: 'AXTextField', subrole: 'AXSecureTextField', pid: 1 } }), null);
});

test('pixels: refusals — person-active, unreadable gate without unattended, bad input, password screens', async () => {
  const d = fakeDriver();
  let r = await P.pixelDo('click', { element: 'text[OK]' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor: async () => ({ idle: 3, locked: false, why: 'unlocked', now: 10 }), settleMs: 0 });
  assert.equal(r.reply.refused, 'person-active');
  r = await P.pixelDo('click', { element: 'text[OK]' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', settleMs: 0 });
  assert.equal(r.reply.refused, 'person-active');
  assert.match(r.reply.message, /unattended/);
  r = await P.pixelDo('click', { element: 'text[OK]', unattended: true }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', settleMs: 0 });
  assert.equal(r.code, 0, 'a Mac provably not in use (FileVault) may be driven when the caller says so');
  r = await P.pixelDo('click', { element: 'text[Nope]', unattended: true }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', settleMs: 0 });
  assert.equal(r.reply.refused, 'input-invalid');
  r = await P.pixelDo('menu', {}, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', settleMs: 0 });
  assert.equal(r.reply.refused, 'action-unavailable');
  r = await P.pixelDo('type_text', { text: 'hunter2', unattended: true }, { gateIO: memIO(), driver: d, ocr: fakeOcr([{ text: 'Enter Password', conf: 0.9, box: [10, 10, 100, 20] }]), host: 'm', settleMs: 0 });
  assert.equal(r.reply.refused, 'input-invalid', 'never type text at a password prompt');
  assert.ok(!d.calls.some((c) => c[0] === 'type' && c[1] === 'hunter2'));
});

test('rules: the UI modules use no LAN address, mDNS name or SSH, and never pass a secret on a command line', () => {
  for (const f of ['ax.mjs', 'pixels.mjs', 'ax-engine.swift']) {
    const s = fs.readFileSync(path.join(f === 'ax-engine.swift' ? SWIFT : SRC, f), 'utf8');
    assert.ok(!/192\.168\.|10\.\d+\.\d+\.\d+/.test(s), `${f} has a LAN address`);
    assert.ok(!/['"`@][\w-]+\.local['"`\s:]/.test(s), `${f} has an mDNS name`);
    assert.ok(!/spawn\w*\(\s*['"]ssh/.test(s), `${f} runs ssh itself; a transport command is the owner's`);
    if (f !== 'ax-engine.swift') assert.ok(!/AXIsProcessTrustedWithOptions|request-trust/.test(s), `${f} could raise the Accessibility prompt`);
  }
  // The engine raises the Accessibility dialog only in request-trust, which only `grant --person-here` sends.
  const eng = fs.readFileSync(path.join(SWIFT, 'ax-engine.swift'), 'utf8');
  assert.equal((eng.match(/AXIsProcessTrustedWithOptions/g) || []).length, 1);
  assert.ok(eng.indexOf('AXIsProcessTrustedWithOptions') > eng.indexOf('case "request-trust"') && eng.indexOf('AXIsProcessTrustedWithOptions') < eng.indexOf('case "trust"'));
  const agent = fs.readFileSync(path.join(SRC, 'agent.mjs'), 'utf8');
  assert.match(agent, /if \(!personHere\) return \{ ok: false, state: 'needs-person'/);
  const ui = fs.readFileSync(path.join(SRC, 'ax.mjs'), 'utf8');
  assert.match(ui, /'find-generic-password', '-s', item, '-w'/, 'secrets come from the Keychain by item name');
});

test('agent: grant needs a person; plists name the signed app, its socket and its stable identifier', async () => {
  const g = await AG.grant({ personHere: false });
  assert.equal(g.ok, false);
  assert.equal(g.state, 'needs-person');
  const ip = AG.infoPlist('abc123');
  assert.match(ip, /<string>bot\.ouro\.reins\.agent<\/string>/);
  assert.match(ip, /<key>LSUIElement<\/key><true\/>/);
  assert.match(ip, /<key>CFBundleVersion<\/key><string>abc123<\/string>/);
  const lp = AG.launchPlist('/x/ouro-reins-agent', '/s.sock');
  assert.match(lp, /<string>\/x\/ouro-reins-agent<\/string><string>--socket<\/string><string>\/s\.sock<\/string>/);
  assert.match(lp, /<key>KeepAlive<\/key><true\/>/);
});

test('agent socket: a missing agent is a reply (agent-down), never an unhandled error', async () => {
  const e = new U.SocketEngine(path.join(scratch(), 'none.sock'));
  const r = await e.req('trust', {}, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'agent-down');
});

test('labels: an editable field is never named by its value, and AppKit identifiers (_NS:…) name nothing', () => {
  assert.equal(U.labelOf({ role: 'AXTextField', subrole: 'AXSearchField', ident: '_NS:122', value: 'alpha' }), null);
  assert.equal(U.labelOf({ role: 'AXTextField', placeholder: 'Name', value: 'Ann' }), 'Name');
  assert.equal(U.labelOf({ role: 'AXStaticText', value: 'Hello' }), 'Hello', 'plain text is still named by what it says');
  assert.equal(U.labelOf({ role: 'AXButton', ident: 'saveButton' }), 'saveButton');
});

test('settle: a content-only change (a value) ends at the first read; an identity change is confirmed once', async () => {
  let t = 0;
  const sleepFn = async (ms) => { t += ms; };
  let reads = 0;
  const changed = async () => { reads++; return { sig: 's1', view: { rev: 'r2' } }; };
  await U.settle(changed, { sig: 's1', view: { rev: 'r1' } }, { sleepFn, now: () => t });
  assert.equal(reads, 1);
  reads = 0;
  const moved = async () => { reads++; return { sig: 's2', view: { rev: `r${reads}` } }; };
  const r = await U.settle(moved, { sig: 's1', view: { rev: 'r0' } }, { sleepFn, now: () => t });
  assert.equal(reads, 2);
  assert.equal(r.view.rev, 'r2', 'the reply has the latest read');
});

test('wire: replies use Reins\' shape — error is an Ouro AX problem {code, exit, thing, problem, fix, message}; actions are {name, title, input, from}', async () => {
  const w = world();
  const r = await U.act('drag', {}, w.opts);
  const out = U.wireReply(r.reply, 'drag');
  assert.equal(out.ok, false);
  assert.deepEqual(Object.keys(out.error).slice(0, 6), ['code', 'exit', 'thing', 'problem', 'fix', 'message']);
  assert.equal(out.error.code, 'action-unavailable');
  assert.equal(out.error.exit, 2);
  assert.equal(out.error.thing, 'do drag');
  assert.match(out.error.fix, /^use one of: click/);
  assert.match(out.error.message, /^do drag: drag isn't available on Downloads\. Fix: use one of: click/);
  assert.ok(out.error.available.includes('click'));
  assert.ok(!('refused' in out) && !('message' in out));
  const bad = U.wireReply((await U.act('press_key', { key: 'nope+x' }, w.opts)).reply, 'press_key');
  assert.equal(bad.error.path, '$.key');
  assert.equal(U.wireReply({ ok: false, failed: 'action-failed', message: 'setting AXValue failed' }, 'set_value').error.exit, 1);
  const L = await U.look({ ...w.opts });
  for (const a of L.view.actions) assert.deepEqual(Object.keys(a), ['name', 'title', 'input', 'from']);
  assert.equal(L.view.actions.find((a) => a.name === 'click').from, 'Downloads');
  assert.equal(L.view.actions.find((a) => a.name === 'menu').from, 'Finder');
  assert.equal(L.view.actions.find((a) => a.name === 'open_app').from, 'mac');
});

test('settle: with a window-server probe, a changed identity is confirmed by the probe, not a second full read', async () => {
  let t = 0;
  const sleepFn = async (ms) => { t += ms; };
  let reads = 0, probes = 0;
  const moved = async () => { reads++; return { sig: 's2', view: { rev: `r${reads}` } }; };
  const still = async () => { probes++; return 'p'; };
  const r = await U.settle(moved, { sig: 's1', view: { rev: 'r0' } }, { sleepFn, now: () => t, probeFn: still });
  assert.equal(reads, 1, 'one full read');
  assert.equal(probes, 2);
  assert.equal(r.view.rev, 'r1');
  reads = 0;
  let p = 0;
  const moving = async () => `p${p++}`;
  await U.settle(moved, { sig: 's1', view: { rev: 'r0' } }, { sleepFn, now: () => t, probeFn: moving, maxMs: 1000 });
  assert.ok(reads >= 2, 'windows still moving: read again');
});

test('labels: an identifier loses the state an app appends to it; a display named apart from what it shows keeps its value', () => {
  assert.equal(U.labelOf({ role: 'AXScrollArea', ident: 'StandardInputView;value:0.1' }), 'StandardInputView');
  const { elements } = U.prune([{ role: 'AXWindow', p: 'w0', frame: [0, 0, 300, 400], children: [
    { role: 'AXStaticText', desc: 'Edit field', value: '42', p: 'w0.0', frame: [10, 10, 100, 30] },
    { role: 'AXStaticText', value: 'Hello', p: 'w0.1', frame: [10, 50, 100, 30] },
  ] }], { pid: 1 });
  assert.deepEqual(elements.map((e) => [e.ref, e.value]), [['statictext[Edit field]', '42'], ['statictext[Hello]', undefined]]);
});

test('batch until: @<element>.<field> names an element as `element` does, so it holds when indexes move', () => {
  const L = { view: { focus: 'Calculator', state: {} }, elements: [{ i: 0, ref: 'button[7]', full: 'button[7]', role: 'button', label: '7' }, { i: 1, ref: 'statictext[Edit field]', full: 'statictext[Edit field]', role: 'statictext', label: 'Edit field', value: '42' }] };
  const R = { holds: (u, v) => Object.entries(u).every(([k, w]) => v[k] === w) };
  assert.equal(U.uiHolds({ '@statictext[Edit field].value': '42' }, L, R.holds), true);
  assert.equal(U.uiHolds({ '@Edit field.value': '42', focus: 'Calculator' }, L, R.holds), true, 'by label, mixed with a dotted path');
  assert.equal(U.uiHolds({ '@statictext[Edit field].value': '41' }, L, R.holds), false);
  assert.equal(U.uiHolds({ '@button[7]': true, '@button[8]': false }, L, R.holds), true, 'presence');
  assert.equal(U.uiHolds({ '@button[7].enabled': true }, L, R.holds), true);
});

test('do: an element that moved between the read and the act (no-element) is read again and acted on once more', async () => {
  const w = world();
  await U.look({ ...w.opts });
  let sets = 0;
  const orig = w.E.req.bind(w.E);
  w.E.req = async (op, a = {}) => {
    if (op === 'set') { sets++; if (sets === 1) return { ok: false, error: 'no-element' }; }
    return orig(op, a);
  };
  const r = await U.act('set_value', { element: 'searchfield[Search]', value: 'bravo' }, { ...w.opts, settleMode: 'none' });
  assert.equal(r.code, 0);
  assert.equal(sets, 2);
});

test('pixels: the menu bar names the front app; with a protected app in front nothing is offered, and keys and clicks are app-protected', async () => {
  const lines = [{ text: 'Example Vault File Edit', conf: 0.9, box: [52, 6, 189, 19] }, { text: 'View', conf: 0.9, box: [249, 7, 40, 14] }, { text: 'Dismiss', conf: 0.9, box: [1596, 952, 59, 14] }];
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  const d = fakeDriver();
  const v = (await P.pixelLook({ driver: d, ocr: fakeOcr(lines), host: 'm', gate: { idle: 300, locked: false, why: 'unlocked' } })).view;
  assert.equal(v.state.front.menu_bar, 'Example Vault File Edit');
  assert.equal(v.state.protected.app, 'Example Vault');
  assert.deepEqual(v.actions.map((a) => a.name), []);
  for (const [a, i] of [['press_key', { key: 'cmd+q', expect_app: 'Example Vault' }], ['click', { element: 'text[Dismiss]' }], ['type_text', { text: 'x', expect_app: 'Example Vault' }]]) {
    const r = await P.pixelDo(a, i, { gateIO: memIO(), driver: d, ocr: fakeOcr(lines), host: 'm', gateFor, settleMs: 0 });
    assert.equal(r.reply.refused, 'app-protected', a);
  }
  assert.deepEqual(d.calls, [], 'nothing reached the protected app');
  const finder = (await P.pixelLook({ driver: fakeDriver(), ocr: fakeOcr(), host: 'm', gate: { idle: 300, locked: false, why: 'unlocked' } })).view;
  assert.equal(finder.state.front.menu_bar, 'Finder');
  assert.equal(finder.state.protected, undefined);
});

test('pixels: hover moves the pointer without clicking (a notification shows its close button), where the driver can', async () => {
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  const d = fakeDriver();
  d.move = async (x, y) => d.calls.push(['move', x, y]);
  const r = await P.pixelDo('hover', { element: 'text[Cancel]' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, settleMs: 0 });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.deepEqual(d.calls, [['move', 940, 610]]);
  const n = fakeDriver();
  const r2 = await P.pixelDo('hover', { x: 1, y: 2 }, { gateIO: memIO(), driver: n, ocr: fakeOcr(), host: 'm', gateFor, settleMs: 0 });
  assert.equal(r2.reply.failed, 'action-failed');
});

const FOCUS_FINDER = async () => ({ front: { name: 'Finder', bundle: 'com.apple.finder' }, focused_role: 'AXTextField' });
const FOCUS_SHEET = async () => ({ front: { name: 'SecurityAgent', bundle: 'com.apple.SecurityAgent' }, focused_role: 'AXTextField', focused_subrole: 'AXSecureTextField', system_focus: { app: 'SecurityAgent', bundle: 'com.apple.SecurityAgent', role: 'AXTextField', subrole: 'AXSecureTextField', pid: 9 } });

test('pixels: batch chains steps on the pixel layer, one screenshot per step, and checks until by element against fresh screenshots', async () => {
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  const d = fakeDriver();
  let shots = 0;
  const ocr = async () => { shots++; const done = d.calls.some((c) => c[0] === 'key' && c[1] === 'return'); return { ok: true, width: 1920, height: 1080, lines: done ? [{ text: 'Finder', conf: 0.9, box: [40, 2, 60, 18] }, { text: 'Saved', conf: 0.9, box: [500, 500, 60, 20] }] : LINES }; };
  const steps = [{ action: 'click', input: { element: 'text[OK]#2' } }, { action: 'press_key', input: { key: 'return', expect_app: 'Finder' }, until: { '@text[Saved]': true } }];
  const r = await P.pixelBatch(steps, { driver: d, ocr, host: 'm', gateFor, focusFor: FOCUS_FINDER, gateIO: memIO(), settleMs: 0 });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.deepEqual(r.reply.steps.map((x) => [x.n, x.ok]), [[0, true], [1, true]]);
  assert.equal(shots, 3, 'a read before each step and one after the last');
  const bad = await P.pixelBatch([{ action: 'press_key', input: { key: 'tab', expect_app: 'Finder' }, until: { '@text[Nope]': true }, timeout_ms: 0 }], { driver: fakeDriver(), ocr: fakeOcr(), host: 'm', gateFor, focusFor: FOCUS_FINDER, gateIO: memIO(), settleMs: 0 });
  assert.equal(bad.reply.failed, 'until-not-met');
});

test('pixels: a screenshot failing mid-batch reports the steps that ran', async () => {
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  let n = 0;
  const ocr = async () => { if (++n === 2) throw new Error('kvm: could not decode a frame'); return { ok: true, width: 1920, height: 1080, lines: LINES }; };
  const r = await P.pixelBatch([{ action: 'press_key', input: { key: 'tab', expect_app: 'Finder' } }, { action: 'press_key', input: { key: 'tab', expect_app: 'Finder' } }, { action: 'press_key', input: { key: 'tab', expect_app: 'Finder' } }], { driver: fakeDriver(), ocr, host: 'm', gateFor, focusFor: FOCUS_FINDER, gateIO: memIO(), settleMs: 0 });
  assert.equal(r.code, 1);
  assert.deepEqual(r.reply.steps.map((s) => [s.n, s.ok]), [[0, true], [1, false]]);
  assert.match(r.reply.message, /could not decode/);
});

test('pixels: type_secret reads the allowed Keychain item on the controller and types it through the KVM\'s secret path, only where a password is asked', async () => {
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  const sheet = [{ text: 'Privacy & Security is trying to modify your system settings.', conf: 0.9, box: [800, 400, 400, 20] }, { text: 'Password', conf: 0.9, box: [800, 480, 80, 20] }];
  const d = fakeDriver();
  d.typeSecret = async (v) => d.calls.push(['typeSecret', v.length]);
  const secret = async (item) => (item === 'mini-pw' ? 's3cret-value' : null);
  let r = await P.pixelDo('type_secret', { keychain_item: 'mini-pw', expect_app: 'SecurityAgent' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(sheet), host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0, secrets: ['mini-pw'], secret, focusFor: FOCUS_SHEET });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.deepEqual(d.calls, [['typeSecret', 12]], 'typed through the secret path, never type()');
  r = await P.pixelDo('type_secret', { keychain_item: 'other', expect_app: 'SecurityAgent' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(sheet), host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0, secrets: ['mini-pw'], secret, focusFor: FOCUS_SHEET });
  assert.equal(r.reply.refused, 'input-invalid', 'only the items the config allows are offered');
  r = await P.pixelDo('type_secret', { keychain_item: 'mini-pw', expect_app: 'SecurityAgent' }, { gateIO: memIO(), driver: d, ocr: fakeOcr(), host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0, secrets: ['mini-pw'], secret, focusFor: FOCUS_SHEET });
  assert.equal(r.code, 1, 'no password field on the screen: nothing typed');
  assert.equal(d.calls.length, 1);
});

test('pixels: one gate read a step (the post mark needs none), and a batch reads the next step\'s gate while this one settles', async () => {
  let reads = 0;
  const gateFor = async () => { reads++; return { idle: 300, locked: false, why: 'unlocked', now: 10 }; };
  const io = memIO();
  const r = await P.pixelDo('press_key', { key: 'tab', expect_app: 'Finder' }, { gateIO: io, driver: fakeDriver(), ocr: fakeOcr(), host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0 });
  assert.equal(r.code, 0);
  assert.equal(reads, 1, 'a single bus read for one do');
  assert.ok(io.load().mark >= 10, 'our input is still marked');
  reads = 0;
  const steps = [1, 2, 3, 4].map(() => ({ action: 'press_key', input: { key: 'tab', expect_app: 'Finder' } }));
  const b = await P.pixelBatch(steps, { driver: fakeDriver(), ocr: fakeOcr(), host: 'm', gateFor, focusFor: FOCUS_FINDER, gateIO: memIO(), settleMs: 0 });
  assert.equal(b.code, 0);
  assert.equal(reads, 4, 'one read per step, each started as the step before acted');
});

test('the two drivers of one screen share their marks: neither takes the other\'s clicks for a person', async () => {
  const G = await import(path.join(SRC, 'gate.mjs'));
  assert.equal(G.oursOf(null), null);
  assert.equal(G.oursOf({ stop: true, at: 5 }), null);
  assert.equal(G.oursOf({ mark: 100, pre: 0 }), 100);
  assert.equal(G.oursOf({ mark: 100, pre: 98 }), 98 + G.SLACK);
  assert.deepEqual(G.mergeOurs(null, 500, 1000), { mark: 500, pre: 0 });
  assert.deepEqual(G.mergeOurs({ mark: 600, pre: 0 }, 500, 1000), { mark: 600, pre: 0 }, 'only ever later');
  assert.deepEqual(G.mergeOurs({ mark: 400, pre: 7 }, 2000, 1000), { mark: 1000, pre: 7 }, 'never past now');
  assert.deepEqual(G.mergeOurs({ stop: true, at: 1 }, 900, 1000), { stop: true, at: 1 }, 'a latched stop stays');
  // The pixel layer clicked 20 s ago (marked on the controller); the Mac's own state knows nothing of it.
  const io = () => { let s = null; return { load: () => s, save: (x) => { s = x; } }; };
  const m = { idle: 20, locked: false, now: 1000, why: 'unlocked' };
  let ran = 0;
  const alone = await U.gated(async () => { ran++; return { ok: true }; }, { idleMin: 90, read: async () => m, io: io() });
  assert.equal(alone.refused, 'person-active', 'without the hint, 20 s of idle is a person');
  const shared = await U.gated(async () => { ran++; return { ok: true }; }, { idleMin: 90, read: async () => m, io: io(), ours: 980 });
  assert.equal(shared.refused, undefined);
  assert.equal(ran, 1);
  // Someone touched it after our last mark (idle 5 s, ours 20 s ago): still a person, hint or not.
  const person = await U.gated(async () => { ran++; return { ok: true }; }, { idleMin: 90, read: async () => ({ ...m, idle: 5 }), io: io(), ours: 980 });
  assert.equal(person.refused, 'person-active');
  assert.equal(ran, 1);
});

test('pixels type_text: OCR checks the text afterwards (seen); verify: true makes a miss a failure', async () => {
  const gateFor = async () => ({ idle: 300, locked: false, why: 'unlocked', now: 10 });
  // The screen shows what the driver typed, optionally corrupted the way a dropped Shift corrupts it.
  const typing = (corrupt = (t) => t) => {
    const d = fakeDriver();
    const ocr = async () => ({ ok: true, width: 1920, height: 1080, lines: [...LINES, ...d.calls.filter((c) => c[0] === 'type').map((c) => ({ text: `Name: ${corrupt(c[1])}`, conf: 0.9, box: [200, 300, 400, 20] }))] });
    return { d, ocr };
  };
  let w = typing();
  let r = await P.pixelDo('type_text', { text: 'Ann (Example)', expect_app: 'Finder' }, { gateIO: memIO(), driver: w.d, ocr: w.ocr, host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0, look: false });
  assert.equal(r.code, 0);
  assert.equal(r.reply.seen, true, 'checked even when the step would skip its look');
  w = typing((t) => t.replace(')', '0'));
  r = await P.pixelDo('type_text', { text: 'Ann (Example)', expect_app: 'Finder' }, { gateIO: memIO(), driver: w.d, ocr: w.ocr, host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0 });
  assert.equal(r.code, 0, 'without verify a miss is reported, not failed (OCR can misread)');
  assert.equal(r.reply.seen, false);
  r = await P.pixelDo('type_text', { text: 'Ann (Example)', verify: true, expect_app: 'Finder' }, { gateIO: memIO(), driver: w.d, ocr: w.ocr, host: 'm', gateFor, focusFor: FOCUS_FINDER, settleMs: 0 });
  assert.equal(r.code, 1);
  assert.equal(r.reply.failed, 'action-failed');
  assert.match(r.reply.message, /doesn't see/);
  assert.equal(P.textSeen('a  b', [{ label: 'x a b y' }]), true);
  assert.equal(P.textSeen('Hello World', [{ label: 'Hello' }, { label: 'World' }]), true, 'across OCR line boxes');
  assert.equal(P.textSeen('A', [{ label: 'a' }]), false, 'case counts');
});

test('until $contains: the screen shows this text, on either layer', () => {
  const L = { view: { state: {} }, elements: [{ label: 'Name', value: 'Ann (Example)' }, { label: 'Save' }] };
  const holds = () => true;
  assert.equal(U.uiHolds({ $contains: 'Ann (Example)' }, L, holds), true);
  assert.equal(U.uiHolds({ $contains: 'Ann (Exampl0' }, L, holds), false);
  assert.equal(U.uiHolds({ $contains: 'Save' }, L, holds), true);
});

test('pixels textSeen: a field that scrolled its start away is "tail", never a pass for a wrong ending', () => {
  const T = 'THE QUICK BROWN FOX: {jumps} [over] the_lazy ~dog~';
  assert.equal(P.textSeen(T, [{ label: 'X: {jumps} [over] the_lazy ~dog~' }]), 'tail');
  assert.equal(P.textSeen(T, [{ label: 'X: {jumps} [over] the_lazy ~dog`' }]), false, 'a changed last character fails');
  assert.equal(P.textSeen('short (x)', [{ label: '(x)' }]), false, 'a short text must be seen whole');
});

test('pixels textSeen: a wrong character inside the visible tail fails', () => {
  const T = 'THE QUICK BROWN FOX: {jumps} [over] the_lazy ~dog~';
  assert.equal(P.textSeen(T, [{ label: 'X: {jumps} [over] the_lazy ~dog~' }]), 'tail');
  assert.equal(P.textSeen(T, [{ label: 'X: {jumps] [over] the_lazy ~dog~' }]), false);
});

test('pixels textSeen: compared as OCR reads (no spaces; | 1 l I and 0 O alike), every dropped Shift still caught', () => {
  const T = 'THE QUICK BROWN FOX: {jumps} [over] the_lazy ~dog~ @ #9 $8 ^7 *6 +5 |4';
  assert.equal(P.textSeen(T, [{ label: '#9 $8 ^7*6 +514' }]), 'tail', 'what OCR read live in a narrow field');
  for (const [from, to] of [['{', '['], [')', '0'], ['@', '2'], ['|', '\\'], ['~', '`'], ['+', '='], ['T', 't']]) {
    const s = 'Typed {x} (0) @a |b ~c +d';
    assert.equal(P.textSeen(s, [{ label: s.replace(from, to) }]), false, `${from} -> ${to}`);
  }
});

test('alerts: a prompt that isn\'t for our own tools is answered only as the config recorded it, one button, never a password', () => {
  const text = 'alert · Allow “Example Browser” to find devices on local networks? · This will allow you to select … · Don’t Allow · Allow';
  const decisions = [{ prompt: 'Allow "Example Browser" to find devices on local networks?', button: 'Allow', by: 'the owner' }];
  const base = { alertText: text, owner: 'UserNotificationCenter' };
  assert.equal(U.alertClickAllowed({ ...base, button: 'Allow' }).ok, false, 'no decision: refused');
  const yes = U.alertClickAllowed({ ...base, button: 'Allow', decisions });
  assert.equal(yes.ok, true);
  assert.match(yes.who, /recorded decision/);
  const other = U.alertClickAllowed({ ...base, button: 'Don’t Allow', decisions });
  assert.equal(other.ok, false, 'only the button decided');
  assert.match(other.why, /recorded decision is "Allow"/);
  assert.equal(U.alertClickAllowed({ ...base, alertText: 'Allow “Example Browser” to access your contacts?', button: 'Allow', decisions }).ok, false, 'another prompt from the same app: not covered');
  assert.equal(U.alertClickAllowed({ ...base, button: 'Allow', hasSecureField: true, decisions }).ok, false, 'never with a password field');
  const real = U.promptDecisionsFor();
  assert.ok(real.some((d) => d.button === 'Allow' && /Example Sync/.test(d.prompt) && d.by), 'the owner\'s config carries each decision with who made it');
});

test('do: the background class runs while a person is active: an AXPress in an app that isn\'t in front, no pointer, no marks', async () => {
  const w = world({ idle: 4, front: SETTINGS, trees: { [SETTINGS.pid]: [] } });
  const r = await U.act('click', { element: 'button[Share]' }, { ...w.opts, app: 'Finder' });
  assert.equal(r.code, 0, JSON.stringify(r.reply));
  assert.equal(r.reply.how, 'AXPress');
  assert.equal(r.reply.background, true);
  assert.ok(!w.E.calls.some(([op]) => ['click', 'key', 'type', 'raise', 'focus'].includes(op)), 'no pointer, keys or focus');
  assert.equal(w.saved.length, 0, 'no gate marks: it made no input event');
  const p = await U.act('set_value', { element: 'Search', value: 'q' }, { ...w.opts, app: 'Finder' });
  assert.equal(p.code, 0, JSON.stringify(p.reply));
  assert.equal(p.reply.background, true);
});

test('do: the background class doesn\'t cover the front app, typing, keys or a press that would fall back to the pointer', async () => {
  let w = world({ idle: 4 });
  assert.equal((await U.act('click', { element: 'button[Share]' }, w.opts)).reply.refused, 'person-active', 'front app');
  w = world({ idle: 4, front: SETTINGS, trees: { [SETTINGS.pid]: [] } });
  assert.equal((await U.act('press_key', { key: 'cmd+w' }, { ...w.opts, app: 'Finder' })).reply.refused, 'person-active');
  assert.equal((await U.act('type_text', { element: 'Search', text: 'x' }, { ...w.opts, app: 'Finder' })).reply.refused, 'person-active');
  w = world({ idle: 4, front: SETTINGS, trees: { [SETTINGS.pid]: [] }, fail: { perform: { ok: false, error: 'ax--25200' } } });
  const r = await U.act('click', { element: 'button[Share]' }, { ...w.opts, app: 'Finder' });
  assert.equal(r.code, 1, 'a failed press fails; it does not move the pointer');
  assert.ok(!w.E.calls.some(([op]) => op === 'click'));
});

test('do: never the pointer for an app that isn\'t in front, even with nobody at the Mac: double-click, right-click, a failed press, scroll', async () => {
  const opts = (w) => ({ ...w.opts, app: 'Finder' });
  const none = (w) => assert.ok(!w.E.calls.some(([op]) => ['click', 'scroll'].includes(op)), 'the pointer never moved');
  for (const idle of [300, 4]) {
    let w = world({ idle, front: SETTINGS, trees: { [SETTINGS.pid]: [] } });
    let r = await U.act('click', { element: 'button[Share]', count: 2 }, opts(w));
    assert.notEqual(r.code, 0, `double-click without AXOpen (idle ${idle})`); none(w);
    w = world({ idle, front: SETTINGS, trees: { [SETTINGS.pid]: [] } });
    r = await U.act('click', { element: 'button[Share]', button: 'right' }, opts(w));
    assert.notEqual(r.code, 0, `right-click (idle ${idle})`); none(w);
    w = world({ idle, front: SETTINGS, trees: { [SETTINGS.pid]: [] }, fail: { perform: { ok: false, error: 'ax--25204' } } });
    r = await U.act('click', { element: 'button[Share]' }, opts(w));
    assert.equal(r.code, 1, `a failed press fails (idle ${idle})`); none(w);
  }
  const w = world({ idle: 300, front: SETTINGS, trees: { [SETTINGS.pid]: [] } });
  const r = await U.act('click', { element: 'button[Share]', count: 2 }, opts(w));
  assert.match(r.reply.message, /isn't in front/);
  // In front with nobody there, the pointer is still the fallback for a double-click.
  const f = world({ idle: 300 });
  assert.equal((await U.act('click', { element: 'button[Share]', count: 2 }, f.opts)).code, 0);
  assert.ok(f.E.calls.some(([op, a]) => op === 'click' && a.count === 2));
});
