// The UI gate: may an agent touch this Mac's screen right now?
//   hackamore gate check            one look: idle seconds, locked or not, verdict (exit 0 = open)
//   hackamore gate wait [--max-min 30] [--idle 90]   poll every 15 s until open (exit 0) or the time runs out (exit 1)
//   hackamore gate init|pre|post|show   the per-action protocol other computer-use helpers can follow
//   add --json for machines; HACKAMORE_GATE_STATE names the state file
// Why: never drive a UI a person may be using. Anything that moves, focuses, opens or types on their screen
// interrupts them and can make them act on the wrong thing. So: screen unlocked, no human input for >= 90 s,
// and after every action of ours, mark it, so input that is not ours (a person came back) stops the run at once.
// Lock comes from IOConsoleUsers' CGSSessionScreenIsLocked (the same dictionary CGSessionCopyCurrentDictionary
// returns), idle from IOHIDSystem's HIDIdleTime. Both are plain ioreg reads: no permission, no prompt, no UI.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IDLE_MIN = 90;
export const SLACK = 15; // our own synthetic input may land up to this long after a passed pre
export const STATE = process.env.HACKAMORE_GATE_STATE || path.join(os.homedir(), 'Library/Caches/hackamore/gate.json');

// ---------- reading the machine ----------

export function parseIdle(ioregText) {
  const m = String(ioregText).match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m ? Math.floor(Number(m[1]) / 1e9) : null;
}

// ioreg -n Root -d1 prints IOConsoleUsers as one line of dictionaries; the console session is the one with
// kCGSSessionOnConsoleKey=Yes. No console user (login window, FileVault) counts as locked.
export function parseLock(ioregText) {
  const line = String(ioregText).split('\n').find((l) => l.includes('"IOConsoleUsers"'));
  if (!line) return { locked: true, why: 'no console session (login window or FileVault)' };
  const sessions = line.split(/\}\s*,\s*\{/);
  const onConsole = sessions.find((s) => /"kCGSSessionOnConsoleKey"\s*=\s*Yes/.test(s));
  if (!onConsole) return { locked: true, why: 'no session on the console' };
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(onConsole)) return { locked: true, why: 'screen locked' };
  if (!/"kCGSessionLoginDoneKey"\s*=\s*Yes/.test(onConsole)) return { locked: true, why: 'login not finished' };
  const user = (onConsole.match(/"kCGSSessionUserNameKey"\s*=\s*"([^"]+)"/) || [])[1] || null;
  return { locked: false, user, why: 'unlocked' };
}

// A person on a call is using the Mac without touching it: HIDIdleTime grows while they talk, and a full-screen meeting
// is in front (an authentication sheet was once opened behind a live call the gate called idle). Calling
// apps hold a power assertion named for the call; any such assertion closes the gate. Plain `pmset -g assertions`.
export const CALL_ASSERTION = /call in progress|in a call|meeting in progress|zoom meeting|facetime|webex meeting|"Call"/i;
export function parseCall(pmsetText) {
  const line = String(pmsetText).split('\n').find((l) => /pid \d+\(/.test(l) && /named: "/.test(l) && CALL_ASSERTION.test(l.slice(l.indexOf('named:'))));
  if (!line) return null;
  const m = line.match(/pid (\d+)\(([^)]+)\).*named: "([^"]*)"/);
  return m ? { pid: Number(m[1]), app: m[2], name: m[3] } : { app: null, name: line.trim() };
}

export function readMachine(run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 }).stdout || '') {
  const idle = parseIdle(run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r']));
  const lock = parseLock(run('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1']));
  const call = parseCall(run('/usr/bin/pmset', ['-g', 'assertions']));
  return { idle, ...lock, call, now: Math.floor(Date.now() / 1000) };
}

// ---------- the decision ----------

export function verdict(m, { idleMin = IDLE_MIN } = {}) {
  if (m.idle == null) return { open: false, why: 'could not read HIDIdleTime' };
  if (m.locked) return { open: false, why: m.why || 'locked' };
  if (m.idle < idleMin) return { open: false, why: `someone used this Mac ${m.idle} s ago (need ${idleMin} s idle)` };
  if (m.call) return { open: false, why: `a call is in progress (${m.call.app || '?'}: "${m.call.name}"); someone is using this Mac` };
  return { open: true, why: `unlocked, idle ${m.idle} s` };
}

// Open, or closed only because of input that a gated run of ours made and marked (init/pre/post) in the last
// maxAgeSec. A computer-use click resets HIDIdleTime, and the scripted step that follows it (osascript to Edge)
// must not wait 90 s for nothing; but any input later than our last mark is a person, so that closes it.
export function ownedVerdict(m, state, { idleMin = IDLE_MIN, slack = SLACK, maxAgeSec = 900 } = {}) {
  const v = verdict(m, { idleMin });
  if (v.open || m.locked || m.idle == null || m.call) return v;
  if (!state || state.stop || state.mark == null || m.now - state.mark > maxAgeSec) return v;
  let ours = state.mark;
  if (state.pre > 0 && state.pre + slack > ours) ours = state.pre + slack;
  if (ours > m.now) ours = m.now;
  const since = m.now - ours;
  if (m.idle + 3 < since) return { open: false, why: `input ${m.idle} s ago that isn't ours (our last was ${since} s ago)` };
  return { open: true, why: `unlocked; the input ${m.idle} s ago is our own gated run's` };
}

// The per-action protocol, same rules as the original cua-gate: state is { mark, pre } epochs, or { stop: true }.
// mark = our last marked input (post, or the last real input at init); pre = the last passed pre.
export function step(cmd, m, state, { idleMin = IDLE_MIN, slack = SLACK } = {}) {
  const v = verdict(m, { idleMin });
  switch (cmd) {
    case 'init':
      if (!v.open) return { ok: false, state, msg: `NOT IDLE: ${v.why}` };
      return { ok: true, state: { mark: m.now - m.idle, pre: 0 }, msg: `OK init idle=${m.idle}` };
    case 'pre': {
      if (state?.stop) return { ok: false, state, msg: 'STOP latched: a person was detected earlier. Do nothing more.' };
      if (!state || state.mark == null) return { ok: false, state, msg: 'STOP: gate not initialised (run init first)' };
      if (m.locked) return { ok: false, state, msg: `STOP: ${m.why || 'screen is locked'}` };
      if (m.call) return { ok: false, state: { stop: true, at: m.now }, msg: `STOP: a call is in progress (${m.call.app || '?'}: "${m.call.name}")` };
      let ours = state.mark;
      if (state.pre > 0 && state.pre + slack > ours) ours = state.pre + slack;
      if (ours > m.now) ours = m.now;
      const since = m.now - ours;
      if (m.idle + 3 < since) return { ok: false, state: { stop: true, at: m.now }, msg: `STOP: PERSON DETECTED idle=${m.idle}s but our last input was ${since}s ago` };
      return { ok: true, state: { mark: state.mark, pre: m.now }, msg: `OK idle=${m.idle}s (our last input >=${since}s ago)` };
    }
    case 'post':
      if (state?.stop) return { ok: false, state, msg: 'STOP latched' };
      return { ok: true, state: { mark: m.now, pre: state?.pre || 0 }, msg: `marked idle=${m.idle}s` };
    case 'show':
      return { ok: true, state, msg: `idle=${m.idle} locked=${m.locked} (${m.why}) state=${JSON.stringify(state)} now=${m.now}` };
    case 'check':
      return { ok: v.open, state, msg: `${v.open ? 'OPEN' : 'CLOSED'}: ${v.why}` };
    default:
      throw new Error(`usage: hackamore gate check|wait|init|pre|post|show (not "${cmd}")`);
  }
}

export function loadState(file = STATE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Our last input on a Mac as one epoch (the Mac's clock), so a second driver of the same screen can count it as
// ours: the accessibility layer keeps its marks on the Mac, the KVM's pixel layer on its controller, and without
// this each sees the other's clicks as a person. A latched stop shares nothing.
export function oursOf(state, { slack = SLACK } = {}) {
  if (!state || state.stop || state.mark == null) return null;
  return state.pre > 0 && state.pre + slack > state.mark ? state.pre + slack : state.mark;
}
// The other driver's mark folded into this one's state: only ever later, never past now, never over a stop.
// Input after the newest mark is still a person and still stops both.
export function mergeOurs(state, ours, now = Math.floor(Date.now() / 1000)) {
  if (!(Number(ours) > 0) || state?.stop) return state;
  const o = Math.min(Number(ours), now);
  if (state && state.mark != null && state.mark >= o) return state;
  return { ...(state || {}), mark: o, pre: state?.pre || 0 };
}
export function saveState(s, file = STATE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.new', JSON.stringify(s) + '\n');
  fs.renameSync(file + '.new', file);
}

// Wait until open; returns { open, polls, last }.
export async function waitOpen({ maxMs = 30 * 60000, everyMs = 15000, idleMin = IDLE_MIN, read = readMachine, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, say = () => {} } = {}) {
  const end = now() + maxMs;
  let polls = 0, last;
  for (;;) {
    polls++;
    last = verdict(read(), { idleMin });
    if (last.open) return { open: true, polls, last };
    say(`gate closed: ${last.why}`);
    if (now() + everyMs > end) return { open: false, polls, last };
    await sleep(everyMs);
  }
}

// ---------- CLI (runs on the Mac being gated) ----------

export async function main(argv) {
  const [cmd = 'check', ...rest] = argv;
  const json = rest.includes('--json');
  const num = (f, d) => { const i = rest.indexOf(f); return i >= 0 ? Number(rest[i + 1]) : d; };
  const idleMin = num('--idle', IDLE_MIN);
  const say = (o) => console.log(json ? JSON.stringify(o) : o.msg);
  if (cmd === 'wait') {
    const r = await waitOpen({ maxMs: num('--max-min', 30) * 60000, idleMin, say: json ? () => {} : (t) => console.error(t) });
    say({ ok: r.open, msg: `${r.open ? 'OPEN' : 'CLOSED'}: ${r.last.why}`, polls: r.polls });
    return r.open ? 0 : 1;
  }
  const m = readMachine();
  const r = step(cmd, m, loadState(), { idleMin });
  if (['init', 'pre', 'post'].includes(cmd) && r.state !== undefined) saveState(r.state);
  say({ ok: r.ok, msg: r.msg, idle: m.idle, locked: m.locked, why: m.why });
  return r.ok ? 0 : 1;
}
