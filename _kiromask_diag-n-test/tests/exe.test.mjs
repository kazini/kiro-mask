import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandPath, resolveKiroExe, explainMissing, resolveCli } from '../lib/kiroinfo.mjs';
import { normalizeArgv, parseMatch, processRegex } from '../lib/argv.mjs';
import { parseArgs as captureArgs } from '../capture.mjs';
import { parseArgs as doctorArgs } from '../doctor.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kd-exe-'));
const touch = (f, mode = 0o755) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'.repeat(200_000), { mode }); return f; };

test('argv: --key=value is split at the first "=", values with "=" survive', () => {
  assert.deepEqual(normalizeArgv(['--exe=C:\\a b\\Kiro.exe', '--env=K=V=2', '--env', 'A=B', '-q', '--port=1']), ['--exe', 'C:\\a b\\Kiro.exe', '--env', 'K=V=2', '--env', 'A=B', '-q', '--port', '1']);
  assert.equal(captureArgs(['--exe=/opt/My Kiro/kiro', '--port=9000']).exe, '/opt/My Kiro/kiro');
  assert.equal(doctorArgs(['--exe=/opt/My Kiro/kiro']).exe, '/opt/My Kiro/kiro');
  assert.deepEqual(captureArgs(['--cli', 'x.js', '--no-cli', '--match', 'agent\\d']).match, 'agent\\d');
  assert.throws(() => captureArgs(['--match', '(']), /not a valid regular expression/);
  assert.equal(doctorArgs(['--no-cli']).noCli, true);
});

test('expandPath: quotes, stray trailing quote (Windows "C:\\dir\\"), ~, %VAR%, $VAR, relative', () => {
  const env = { LOCALAPPDATA: '/home/u/AppData/Local', MYDIR: '/opt/k' };
  assert.equal(expandPath('"/opt/Kiro App/kiro"', { env, cwd: '/' }), '/opt/Kiro App/kiro');
  assert.equal(expandPath('/opt/Kiro App"', { env, cwd: '/' }), '/opt/Kiro App', 'a lone trailing quote from a trailing backslash is dropped');
  assert.equal(expandPath('%LOCALAPPDATA%/Programs/Kiro', { env, cwd: '/' }), '/home/u/AppData/Local/Programs/Kiro');
  assert.equal(expandPath('%localappdata%/x', { env, cwd: '/' }), '/home/u/AppData/Local/x', 'case-insensitive %VAR%');
  assert.equal(expandPath('$MYDIR/kiro', { env, cwd: '/' }), '/opt/k/kiro'); assert.equal(expandPath('${MYDIR}/kiro', { env, cwd: '/' }), '/opt/k/kiro');
  assert.equal(expandPath('~/Kiro/kiro', { home: '/home/u', env, cwd: '/' }), '/home/u/Kiro/kiro');
  assert.equal(expandPath('rel/kiro', { env, cwd: '/work' }), '/work/rel/kiro');
});

test('resolveKiroExe: the file itself, its install folder, a parent folder, a differently named build, an .app bundle', async () => {
  const d = tmp();
  const exe = touch(path.join(d, 'My Kiro Build', 'kiro'));
  assert.equal((await resolveKiroExe(exe, { platform: 'linux' })).exe, exe);
  const byDir = await resolveKiroExe(path.dirname(exe), { platform: 'linux' }); assert.equal(byDir.exe, exe); assert.match(byDir.via, /folder/);
  const viaParent = await resolveKiroExe(d, { platform: 'linux' }); assert.equal(viaParent.exe, exe, 'a parent folder is searched two levels down');
  const win = touch(path.join(d, 'win', 'Kiro.exe')); fs.writeFileSync(path.join(d, 'win', 'unins000.exe'), 'x');
  assert.equal((await resolveKiroExe(path.join(d, 'win'), { platform: 'win32' })).exe, win);
  assert.equal((await resolveKiroExe(path.join(d, 'win', 'Kiro'), { platform: 'win32' })).exe, win, '.exe is appended when omitted');
  const custom = touch(path.join(d, 'custom', 'KiroDev-Portable.exe'));
  assert.equal((await resolveKiroExe(path.join(d, 'custom'), { platform: 'win32' })).exe, custom, 'any *kiro* program is found');
  const mac = touch(path.join(d, 'Kiro.app', 'Contents', 'MacOS', 'Electron'));
  assert.equal((await resolveKiroExe(path.join(d, 'Kiro.app'), { platform: 'darwin' })).exe, mac);
});

test('resolveKiroExe: quoted input, KIRO_EXE environment variable, .lnk shortcuts, auto-detect', async () => {
  const d = tmp(); const exe = touch(path.join(d, 'Program Files', 'Kiro', 'kiro'));
  assert.equal((await resolveKiroExe(`"${exe}"`, { platform: 'linux' })).exe, exe);
  const viaEnv = await resolveKiroExe(undefined, { platform: 'linux', env: { KIRO_EXE: exe } }); assert.equal(viaEnv.exe, exe); assert.equal(viaEnv.via, 'KIRO_EXE');
  assert.equal((await resolveKiroExe('--ignored', { platform: 'linux', env: { KIRO_EXE: '/nope' } })).via, '--exe', 'the flag beats the environment');
  const lnk = path.join(d, 'Kiro.lnk'); fs.writeFileSync(lnk, 'shortcut');
  assert.equal((await resolveKiroExe(lnk, { platform: 'win32', lnkResolver: async () => exe })).exe, exe);
  const bad = await resolveKiroExe(lnk, { platform: 'win32', lnkResolver: async () => null }); assert.equal(bad.exe, null); assert.match(bad.hint, /shortcut/);
  const auto = await resolveKiroExe(undefined, { platform: 'linux', env: {}, cwd: path.join(d, 'nowhere'), home: d }); assert.equal(auto.exe, null); assert.match(auto.hint, /--exe/);
  const found = await resolveKiroExe(undefined, { platform: 'linux', env: {}, cwd: path.join(d, 'Program Files'), home: d }); assert.equal(found.exe, exe, 'auto-detect finds ./Kiro/kiro under the working directory'); assert.equal(found.via, 'auto-detected');
});

test('resolveKiroExe: failures say what was resolved, what exists nearby, and how to fix the quoting', async () => {
  const d = tmp(); touch(path.join(d, 'Kiro', 'kiro-beta')); fs.mkdirSync(path.join(d, 'empty'));
  const typo = await resolveKiroExe(path.join(d, 'Kiro', 'kiro-bata'), { platform: 'linux' });
  assert.equal(typo.exe, null); assert.match(typo.hint, /did you mean: kiro-beta/);
  const noParent = await resolveKiroExe(path.join(d, 'gone', 'kiro'), { platform: 'linux' }); assert.match(noParent.hint, /Neither the file nor its folder exists/);
  const emptyDir = await resolveKiroExe(path.join(d, 'empty'), { platform: 'linux' }); assert.match(emptyDir.hint, /no Kiro executable was found in it/);
  const msg = explainMissing(typo);
  assert.match(msg, /Could not use --exe/); assert.match(msg, /did you mean/); assert.match(msg, /double quotes/); assert.match(msg, /--exe=PATH/); assert.match(msg, /install folder/);
});

test('resolveCli: standard location, explicit override, --no-cli, and a bad override is an error', () => {
  const d = tmp(); const exe = touch(path.join(d, 'kiro')); const std = path.join(d, 'resources', 'app', 'out', 'cli.js'); touch(std, 0o644);
  assert.deepEqual(resolveCli(exe), { cli: std, via: 'standard location' });
  const mine = touch(path.join(d, 'my-cli.js'), 0o644);
  assert.deepEqual(resolveCli(exe, { cliOverride: `"${mine}"` }), { cli: mine, via: '--cli' });
  assert.deepEqual(resolveCli(exe, { noCli: true }), { cli: null, via: '--no-cli' });
  assert.match(resolveCli(exe, { cliOverride: path.join(d, 'nope.js') }).error, /--cli file not found/);
  assert.equal(resolveCli(touch(path.join(tmp(), 'kiro'))).cli, null);
});

test('processRegex: matches "kiro", the executable\'s own name, and the user\'s pattern (escaped properly)', () => {
  const re = processRegex('C:\\My Tools\\Editor (custom).exe', 'agent\\d+');
  assert.ok(re.test('Kiro.exe') && re.test('Editor (custom)') && re.test('agent42') && !re.test('chrome.exe'));
  assert.ok(processRegex(null, null).test('KIRO-helper'));
  assert.ok(!processRegex('a.b.exe', null).test('aXb'), 'regex metacharacters in the name are escaped');
  assert.throws(() => parseMatch('('), /valid regular expression/);
});
