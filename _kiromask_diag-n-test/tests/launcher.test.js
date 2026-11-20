// Finding Kiro: the exe, its folder, shortcuts (.lnk) to either, and kiromask living next to / inside the Kiro folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLnk } from '../../_kiromask-src/launcher/shortcut.mjs';
import { locateKiro, findKiroExe } from '../../_kiromask-src/launcher/kiro.mjs';
import { Config } from '../../_kiromask-src/config/load.mjs';
import { parseYaml } from '../../_kiromask-src/config/yaml.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kmlnk-'));
const touch = (...p) => { const f = path.join(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };

/** Build a shell link per MS-SHLLINK: header, LinkInfo (ANSI and optionally Unicode paths), optional RELATIVE_PATH. */
function makeLnk(target, { unicode = false, relative = null, withInfo = true } = {}) {
  const head = Buffer.alloc(0x4c);
  head.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(head, 4);
  head.writeUInt32LE((withInfo ? 0x2 : 0) | (relative != null ? 0x8 : 0) | 0x80, 0x14); // 0x80: string data is UTF-16
  const parts = [head];
  if (withInfo) {
    const hdr = unicode ? 0x24 : 0x1c;
    const volume = Buffer.alloc(0x14); volume.writeUInt32LE(0x14, 0); volume.writeUInt32LE(0x10, 12);
    const baseOff = hdr + volume.length;
    const ansi = Buffer.from(`${target.replace(/[^\x00-\x7f]/g, '?')}\0`, 'latin1');
    const sufOff = baseOff + ansi.length;
    const suffix = Buffer.from('\0');
    const wBase = Buffer.from(`${target}\0`, 'utf16le');
    const wBaseOff = sufOff + suffix.length;
    const wSufOff = wBaseOff + wBase.length;
    const size = unicode ? wSufOff + 2 : sufOff + suffix.length;
    const info = Buffer.alloc(hdr);
    info.writeUInt32LE(size, 0); info.writeUInt32LE(hdr, 4); info.writeUInt32LE(1, 8); info.writeUInt32LE(hdr, 12);
    info.writeUInt32LE(baseOff, 16); info.writeUInt32LE(0, 20); info.writeUInt32LE(sufOff, 24);
    if (unicode) { info.writeUInt32LE(wBaseOff, 28); info.writeUInt32LE(wSufOff, 32); }
    parts.push(info, volume, ansi, suffix);
    if (unicode) parts.push(wBase, Buffer.from('\0\0', 'utf16le'));
  }
  if (relative != null) { const r = Buffer.from(relative, 'utf16le'); const n = Buffer.alloc(2); n.writeUInt16LE(relative.length); parts.push(n, r); }
  return Buffer.concat(parts);
}
const lnk = (dir, name, target, o) => { const f = path.join(dir, name); fs.writeFileSync(f, makeLnk(target, o)); return f; };
const W = (o) => ({ platform: 'win32', env: {}, home: tmp(), ...o });

test('parseLnk: ANSI path, Unicode path, relative-path fallback; garbage is rejected', () => {
  assert.equal(parseLnk(makeLnk('C:\\Users\\me\\Kiro\\Kiro.exe')).target, 'C:\\Users\\me\\Kiro\\Kiro.exe');
  assert.equal(parseLnk(makeLnk('C:\\Users\\Кирилл\\Kiro\\Kiro.exe', { unicode: true })).target, 'C:\\Users\\Кирилл\\Kiro\\Kiro.exe');
  const rel = parseLnk(makeLnk('', { withInfo: false, relative: '.\\Kiro\\Kiro.exe' }));
  assert.equal(rel.target, null);
  assert.equal(rel.relative, '.\\Kiro\\Kiro.exe');
  assert.equal(parseLnk(Buffer.from('not a shortcut at all, definitely')), null);
  assert.equal(parseLnk(makeLnk('C:\\x').subarray(0, 0x50)), null, 'truncated');
});

test('kiro lookup: a shortcut to Kiro.exe in the kiromask folder', () => {
  const root = tmp(); const kiro = touch(tmp(), 'Programs', 'Kiro', 'Kiro.exe');
  lnk(root, 'Kiro.lnk', kiro);
  const r = locateKiro(null, W({ root, cwd: root }));
  assert.equal(r.exe, kiro);
  assert.match(r.via, /shortcut Kiro\.lnk/);
});

test('kiro lookup: a shortcut to the FOLDER that contains Kiro.exe (any shortcut name)', () => {
  const root = tmp(); const dir = path.dirname(touch(tmp(), 'Apps', 'Kiro', 'Kiro.exe'));
  lnk(root, 'my editor.lnk', dir, { unicode: true });
  assert.equal(findKiroExe(null, W({ root, cwd: root })), path.join(dir, 'Kiro.exe'));
});

test('kiro lookup: shortcuts to something that is not Kiro, and corrupt shortcuts, are ignored', () => {
  const root = tmp(); const other = touch(tmp(), 'Code', 'Code.exe'); const kiro = touch(tmp(), 'Kiro', 'Kiro.exe');
  lnk(root, 'AAA code.lnk', other);
  fs.writeFileSync(path.join(root, 'AAB broken.lnk'), 'garbage');
  assert.equal(findKiroExe(null, W({ root, cwd: root })), null);
  lnk(root, 'ZZZ.lnk', kiro);
  assert.equal(findKiroExe(null, W({ root, cwd: root })), kiro, 'the real one is still found past the junk');
});

test('kiro lookup: kiromask copied INTO the Kiro folder, and kiromask in a subfolder of it', () => {
  const kiroDir = tmp(); const exe = touch(kiroDir, 'Kiro.exe');
  assert.equal(findKiroExe(null, W({ root: kiroDir, cwd: kiroDir })), exe, 'files directly in the Kiro folder');
  const nested = path.join(kiroDir, 'kiromask'); fs.mkdirSync(nested);
  const r = locateKiro(null, W({ root: nested, cwd: nested }));
  assert.equal(r.exe, exe, 'Kiro/kiromask');
  assert.match(r.via, /inside the Kiro folder/);
  const deep = path.join(nested, 'tools', 'x'); fs.mkdirSync(deep, { recursive: true });
  assert.equal(findKiroExe(null, W({ root: deep, cwd: deep })), exe, 'a few levels deeper still works');
  assert.equal(findKiroExe(null, W({ root: nested, cwd: nested, platform: 'win32' })), exe);
});

test('kiro lookup: a Kiro folder inside the kiromask folder; case does not matter; nothing found lists where it looked', () => {
  const root = tmp(); const exe = touch(root, 'Kiro', 'kiro.EXE');
  assert.equal(findKiroExe(null, W({ root, cwd: root })), exe);
  const empty = tmp();
  const none = locateKiro(null, W({ root: empty, cwd: empty }));
  assert.equal(none.exe, null);
  assert.ok(none.searched.includes(empty));
});

test('kiro lookup: kiro.exe_path may be the exe, its folder, or a shortcut to either; a missing path is null', () => {
  const home = tmp(); const dir = path.join(home, 'Kiro'); const exe = touch(dir, 'Kiro.exe');
  assert.equal(findKiroExe(exe, W({})), exe);
  assert.equal(findKiroExe(dir, W({})), exe);
  assert.equal(findKiroExe(lnk(home, 'a.lnk', exe), W({})), exe);
  assert.equal(findKiroExe(lnk(home, 'b.lnk', dir), W({})), exe);
  const lone = tmp();
  assert.equal(findKiroExe(path.join(home, 'nope.exe'), W({ root: lone, cwd: lone })), null, 'nothing configured works and nothing else exists');
  const custom = touch(home, 'my-kiro-build.exe');
  assert.equal(findKiroExe(custom, W({})), custom, 'an explicitly configured file is trusted whatever it is called');
});

test('kiro lookup: a configured path that does not exist falls through to the other methods (and says so); %VARS% are expanded', () => {
  const root = tmp(); const kiro = touch(tmp(), 'Kiro', 'Kiro.exe');
  lnk(root, 'Kiro.lnk', kiro);
  const r = locateKiro('/no/such/Kiro.exe', W({ root, cwd: root }));
  assert.equal(r.exe, kiro, 'the shortcut was used');
  assert.equal(r.skipped, path.resolve('/no/such/Kiro.exe'));
  assert.match(r.via, /shortcut/);
  const local = tmp(); const exe = touch(local, 'Programs', 'Kiro', 'Kiro.exe');
  const lone = tmp();
  assert.equal(findKiroExe('%LOCALAPPDATA%/Programs/Kiro/Kiro.exe', W({ root: lone, cwd: lone, env: { LocalAppData: local } })), exe, 'case-insensitive variable on Windows');
  assert.equal(findKiroExe('%NOPE%/x/Kiro.exe', W({ root: lone, cwd: lone })), null, 'unknown variables stay as written, so no match');
  assert.equal(locateKiro(exe, W({})).skipped, undefined, 'a valid configured path is not reported as skipped');
});

test('kiro lookup: a symlink to the exe or folder works too (macOS/Linux)', { skip: process.platform === 'win32' }, () => {
  const root = tmp(); const kiroDir = tmp(); const exe = touch(kiroDir, 'kiro');
  fs.symlinkSync(kiroDir, path.join(root, 'editor'));
  assert.equal(fs.realpathSync(findKiroExe(null, { platform: 'linux', env: {}, home: tmp(), root, cwd: root })), fs.realpathSync(exe));
});

test('config: intent_classifier is accepted as the old name of session_title; the example config is clean and complete', () => {
  const c = new Config({ intent_classifier: 'passthrough' }, { env: {} });
  assert.equal(c.get('session_title'), 'passthrough');
  assert.deepEqual(c.warnings, ['intent_classifier was renamed to session_title (the old name still works; please rename it)']);
  const example = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../kiromask.config.example.yaml'), 'utf8');
  const cfg = new Config(parseYaml(example), { env: { OPENROUTER_API_KEY: 'a', NVIDIA_API_KEY: 'b' } });
  assert.deepEqual(cfg.warnings, [], 'the example has no unknown settings and no invalid values');
  assert.deepEqual(cfg.customModels.map((m) => m.id), ['minimax/minimax-m2.5', 'minimax/minimax-m3.1']);
  assert.equal(cfg.get('session_title'), 'local');
  assert.equal(cfg.get('kiro.exe_path'), '%LOCALAPPDATA%\\Programs\\Kiro\\Kiro.exe', 'the standard per-user install path');
});
