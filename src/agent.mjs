// The Ouro Reins Agent: swift/ax-engine.swift as a small app that its own LaunchAgent keeps running, serving the engine
// on a Unix socket (~/Library/Caches/hackamore/agent.sock). hackamore talks to it (src/ax.mjs SocketEngine).
// Why an app of its own: macOS gives Accessibility to the process that launched a tool, so an engine started from a
// shell needs `node` itself granted, which would hand every node script on the Mac the whole screen. A named app
// signed with a Developer ID keeps one stable identity across rebuilds (the grant survives updates: macOS ties it to the
// designated requirement, not to one binary) and shows up in System Settings as "Ouro Reins Agent", so a person can see
// what they are allowing. An ad-hoc (unsigned) build keeps a grant only until the engine changes.
//   hackamore agent build [--developer-id|--ad-hoc] [--notarize]   compile, bundle, sign → dist/ouro-reins-agent.tgz
//   hackamore agent install [--from <dir>] [--force]   verify the signature, install ~/Applications/Ouro Reins Agent.app,
//                                        (re)load the LaunchAgent bot.ouro.reins.agent; no-op when already current.
//                                        Without --from: this checkout's dist/, else the latest GitHub release.
//   hackamore agent status               is it running, which version, does it hold Accessibility / Screen Recording
//   hackamore agent grant --person-here  raise macOS's own Accessibility dialog for it; only with a person at the Mac
//                                        (never a prompt on an empty screen). They flip the switch; agents never do.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SOCK, LEGACY_SOCK, CACHE, SocketEngine } from './ax.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const LABEL = 'bot.ouro.reins.agent';
export const APP_NAME = 'Ouro Reins Agent';
export const EXE = 'ouro-reins-agent';
export const TEAM = process.env.HACKAMORE_TEAM || '743GT2AJ24';
export const DIST = path.join(ROOT, 'dist');
export const TGZ_NAME = 'ouro-reins-agent.tgz';
export const MANIFEST_NAME = 'ouro-reins-agent.json';
export const RELEASE_URL = 'https://github.com/ourostack/hackamore/releases/latest/download';
export const APPS = path.join(os.homedir(), 'Applications');
export const APP = path.join(APPS, `${APP_NAME}.app`);
export const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
export const SOCK = AGENT_SOCK;

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 300000, ...o });
export const sourceVersion = (src = path.join(ROOT, 'swift', 'ax-engine.swift')) => createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);

export function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${EXE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHumanReadableCopyright</key><string>hackamore: lets agents read and drive app windows through Accessibility, only while nobody is using the Mac.</string>
</dict></plist>
`;
}

export function launchPlist(bin, sock = SOCK) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${bin}</string><string>--socket</string><string>${sock}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), 'Library/Logs/ouro-reins-agent.log')}</string>
</dict></plist>
`;
}

// The designated requirement macOS ties the Accessibility grant to: this identifier, signed by Apple's Developer ID
// chain for the team. It holds across every rebuild, so the grant does too.
export const REQUIREMENT = `designated => identifier "${LABEL}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM}"`;

// The Developer ID Application identity to sign with: HACKAMORE_SIGN_IDENTITY, else the first one the keychain search
// list (or HACKAMORE_SIGNING_KEYCHAIN) holds.
export function identity(keychain = process.env.HACKAMORE_SIGNING_KEYCHAIN || null, run = sh) {
  if (process.env.HACKAMORE_SIGN_IDENTITY) return process.env.HACKAMORE_SIGN_IDENTITY;
  const r = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])]);
  return (String(r.stdout).match(/"(Developer ID Application: [^"]+\((\w+)\))"/) || [])[1] || null;
}

// Apple's notary service, then the ticket stapled to the app. Credentials come from the environment, never a log:
// an App Store Connect API key (APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER) or an Apple ID
// (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID).
export function notaryAuth(env = process.env) {
  if (env.APPLE_API_KEY_PATH && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) return ['--key', env.APPLE_API_KEY_PATH, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return ['--apple-id', env.APPLE_ID, '--team-id', env.APPLE_TEAM_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD];
  return null;
}

export function notarize(app, { run = sh, env = process.env } = {}) {
  const auth = notaryAuth(env);
  if (!auth) throw new Error('notarization needs APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, in the environment');
  const zip = `${app}.zip`;
  const z = run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  if (z.status !== 0) throw new Error(`ditto: ${String(z.stderr).slice(0, 300)}`);
  const n = run('/usr/bin/xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--output-format', 'json'], { timeout: 1800000 });
  let j = {};
  try { j = JSON.parse(n.stdout); } catch { /* reported below */ }
  if (j.status !== 'Accepted') throw new Error(`notarization ${j.status || 'failed'}: ${String(n.stderr || n.stdout).slice(0, 400)}`);
  const s = run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  if (s.status !== 0) throw new Error(`stapler: ${String(s.stderr).slice(0, 300)}`);
  return { ok: true, id: j.id || null };
}

// developerId: true (must), false (ad-hoc), or 'auto' (Developer ID when an identity is here, else ad-hoc).
export function build({ out = DIST, developerId = 'auto', notarizeIt = false } = {}) {
  const version = sourceVersion();
  const work = path.join(CACHE, `agent-build-${version}-${process.pid}`);
  const app = path.join(work, `${APP_NAME}.app`);
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), infoPlist(version));
  const c = sh('/usr/bin/swiftc', ['-O', path.join(ROOT, 'swift', 'ax-engine.swift'), '-o', path.join(app, 'Contents/MacOS', EXE)]);
  if (c.status !== 0) throw new Error(`swiftc: ${c.stderr.slice(0, 400)}`);
  const id = developerId ? identity() : null;
  if (!id && developerId === true) throw new Error('Developer ID signing unavailable: no "Developer ID Application" identity in the keychain (HACKAMORE_SIGN_IDENTITY names one)');
  const kc = process.env.HACKAMORE_SIGNING_KEYCHAIN;
  const s = sh('/usr/bin/codesign', ['--force', '--options', 'runtime', ...(id ? ['--timestamp', ...(kc ? ['--keychain', kc] : []), '--requirements', `=${REQUIREMENT}`] : []), '--identifier', LABEL, '-s', id || '-', app], { timeout: 120000 });
  if (s.status !== 0 || s.signal) throw new Error(`codesign: ${s.signal ? `timed out (${s.signal})` : String(s.stderr).slice(0, 400)}`);
  if (notarizeIt) { if (!id) throw new Error('only a Developer ID build can be notarized'); notarize(app); }
  const cdhash = (String(sh('/usr/bin/codesign', ['-dvvv', app]).stderr).match(/CDHash=(\w+)/) || [])[1] || null;
  fs.mkdirSync(out, { recursive: true });
  const tgz = path.join(out, TGZ_NAME);
  const t = sh('/usr/bin/tar', ['-czf', `${tgz}.new`, '-C', work, `${APP_NAME}.app`], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (t.status !== 0) throw new Error(`tar: ${t.stderr}`);
  fs.renameSync(`${tgz}.new`, tgz);
  const sha256 = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const m = { version, sha256, cdhash, signed: id ? 'developer-id' : 'ad-hoc', notarized: Boolean(id && notarizeIt), identity: id || null, team: id ? TEAM : null, built: new Date().toISOString(), bytes: fs.statSync(tgz).size };
  fs.writeFileSync(path.join(out, MANIFEST_NAME), JSON.stringify(m, null, 2) + '\n');
  return { ok: true, ...m };
}

function installedVersion() {
  const r = sh('/usr/bin/defaults', ['read', path.join(APP, 'Contents/Info'), 'CFBundleVersion']);
  return r.status === 0 ? r.stdout.trim() : null;
}

async function ping(timeoutMs = 3000, sock = SOCK) {
  const e = new SocketEngine(sock);
  const t = await e.req('trust', {}, timeoutMs);
  e.stop();
  return t;
}

// The build to install: a directory (--from, or this checkout's dist/), else the latest GitHub release.
export async function fetchBuild({ from = null, fetchFn = fetch } = {}) {
  const dir = from || (fs.existsSync(path.join(DIST, MANIFEST_NAME)) ? DIST : null);
  if (dir) return { dir, source: dir };
  const dest = path.join(CACHE, 'download');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const name of [MANIFEST_NAME, TGZ_NAME]) {
    const r = await fetchFn(`${RELEASE_URL}/${name}`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${RELEASE_URL}/${name}: HTTP ${r.status}`);
    fs.writeFileSync(path.join(dest, name), Buffer.from(await r.arrayBuffer()));
  }
  return { dir: dest, source: `${RELEASE_URL}` };
}

export async function install({ force = false, from = null, fetchFn = fetch } = {}) {
  let b;
  try { b = await fetchBuild({ from, fetchFn }); } catch (e) { return { ok: false, state: 'no-build', why: `${e.message}. Fix: hackamore agent build, or install from a release: https://github.com/ourostack/hackamore/releases` }; }
  const tgz = path.join(b.dir, TGZ_NAME);
  const m = JSON.parse(fs.readFileSync(path.join(b.dir, MANIFEST_NAME), 'utf8'));
  const have = installedVersion();
  if (!force && have === m.version) {
    const t = await ping();
    if (t.ok) return { ok: true, state: 'current', version: have, ax: t.ax, screen_capture: t.screen_capture };
  }
  const sum = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  if (sum !== m.sha256) return { ok: false, state: 'bad-download', why: `the archive's sha256 ${sum.slice(0, 12)} isn't the manifest's ${m.sha256.slice(0, 12)}` };
  const work = path.join(CACHE, `agent-install-${m.version}-${process.pid}`);
  fs.mkdirSync(work, { recursive: true });
  const x = sh('/usr/bin/tar', ['-xzf', tgz, '-C', work]);
  if (x.status !== 0) return { ok: false, state: 'unpack', why: x.stderr };
  const fresh = path.join(work, `${APP_NAME}.app`);
  // The signature is the identity macOS ties the grant to: only our own Developer ID team is installed.
  const v = sh('/usr/bin/codesign', ['--verify', '--strict', '--deep', fresh]);
  const d = sh('/usr/bin/codesign', ['-dv', fresh]);
  const team = (String(d.stderr).match(/TeamIdentifier=(\w+)/) || [])[1];
  const cd = (String(sh('/usr/bin/codesign', ['-dvvv', fresh]).stderr).match(/CDHash=(\w+)/) || [])[1];
  const trusted = m.signed === 'developer-id' ? team === TEAM : cd && cd === m.cdhash;
  if (v.status !== 0 || !trusted) return { ok: false, state: 'bad-signature', why: `codesign: ${(v.stderr || '').trim().slice(0, 200)} team=${team} cdhash=${cd}` };
  const uid = process.getuid();
  sh('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
  fs.mkdirSync(APPS, { recursive: true });
  if (fs.existsSync(APP)) fs.renameSync(APP, path.join(os.homedir(), '.Trash', `${APP_NAME}-${have || 'old'}-${Date.now()}.app`));
  fs.renameSync(fresh, APP);
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PLIST, launchPlist(path.join(APP, 'Contents/MacOS', EXE)));
  // launchd may still be tearing the old one down ("Bootstrap failed: 5: Input/output error"): retry briefly.
  let bs;
  for (let i = 0; i < 6; i++) {
    bs = sh('/bin/launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
    if (bs.status === 0) break;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  if (bs.status !== 0) return { ok: false, state: 'launchd', why: bs.stderr.trim() };
  let t = { ok: false };
  for (let i = 0; i < 20 && !t.ok; i++) { await new Promise((r) => setTimeout(r, 250)); t = await ping(1000); }
  return { ok: t.ok, state: t.ok ? 'installed' : 'not-answering', version: m.version, signed: m.signed, ax: t.ax ?? null, screen_capture: t.screen_capture ?? null, ...(t.ax ? {} : { next: 'a person turns on "Ouro Reins Agent" in System Settings > Privacy & Security > Accessibility: hackamore agent grant --person-here' }) };
}

export async function status() {
  let t = await ping();
  if (!t.ok && fs.existsSync(LEGACY_SOCK)) t = await ping(3000, LEGACY_SOCK);
  let m = null; try { m = JSON.parse(fs.readFileSync(path.join(DIST, MANIFEST_NAME), 'utf8')); } catch { /* none */ }
  return { ok: Boolean(t.ok), running: Boolean(t.ok), installed: installedVersion(), dist: m?.version || null, source: sourceVersion(), ax: t.ax ?? null, screen_capture: t.screen_capture ?? null, pid: t.pid ?? null };
}

export async function grant({ personHere = false, screen = true } = {}) {
  if (!personHere) return { ok: false, state: 'needs-person', why: 'grant raises a macOS dialog on the screen: only with --person-here, when someone is at the Mac to answer it' };
  const e = new SocketEngine(SOCK);
  const r = await e.req('request-trust', { screen }, 5000);
  e.stop();
  return { ok: Boolean(r.ok), ax: r.ax ?? null, screen_capture: r.screen_capture ?? null, next: r.ax ? null : 'macOS showed its dialog: Open System Settings, turn on "Ouro Reins Agent", enter the Mac\'s password there' };
}

export async function main(argv) {
  const [sub = 'status', ...rest] = argv;
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : null; };
  let r;
  if (sub === 'build') r = build({ developerId: rest.includes('--developer-id') ? true : rest.includes('--ad-hoc') ? false : 'auto', notarizeIt: rest.includes('--notarize') });
  else if (sub === 'install') r = await install({ force: rest.includes('--force'), from: val('--from') });
  else if (sub === 'status') r = await status();
  else if (sub === 'grant') r = await grant({ personHere: rest.includes('--person-here') });
  else throw new Error('usage: hackamore agent build [--developer-id|--ad-hoc] [--notarize] | install [--from <dir>] [--force] | status | grant --person-here');
  console.log(JSON.stringify({ machine: os.hostname(), sub, ...r }));
  return r.ok ? 0 : 1;
}
