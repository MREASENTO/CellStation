'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { AppUpdater, canonical, verifiedRelease } = require('./app-updater.cjs');
const { eligibleGitUpdate, validateAppManifest, fetchGitUpdate, safeAppPath } = require('./git-updates.cjs');
const base = path.resolve(__dirname, '../work/tests'); fs.mkdirSync(base, { recursive: true });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'v102-git-')), repository = path.join(root, 'repo'), install = path.join(root, 'install'), dataRoot = path.join(install, 'data');
  fs.mkdirSync(repository); fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.join(install, 'resources/app/runtime/git/cmd'), { recursive: true }); fs.writeFileSync(path.join(install, 'resources/app/runtime/git/cmd/git.exe'), 'mock bundled path');
  const runtime = 'a'.repeat(64), files = { 'resources/app/package.json': Buffer.from('{"version":"1.0.3"}'), 'PACKAGE_MANIFEST.json': Buffer.from(JSON.stringify({ version: '1.0.3', runtimeId: runtime, accountDataIncluded: false })) };
  const manifest = { product: 'CellStation', kind: 'app', version: '1.0.3', runtimeId: runtime, accountDataIncluded: false, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])) };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repository, name)), { recursive: true }); fs.writeFileSync(path.join(repository, name), content); }
  fs.writeFileSync(path.join(repository, 'APP_UPDATE_MANIFEST.json'), bytes); fs.writeFileSync(path.join(install, 'APP_UPDATE_MANIFEST.json'), JSON.stringify({ ...manifest, version: '1.0.2' }));
  const git = async args => execFile('git', ['-c', 'safe.directory=' + repository.replaceAll('\\', '/'), '-C', repository, ...args], { windowsHide: true });
  await git(['init', '-b', 'app-stable']); await git(['config', 'user.name', 'CellStation QA']); await git(['config', 'user.email', 'qa@example.invalid']); await git(['config', 'core.autocrlf', 'false']); await git(['add', '.']); await git(['commit', '-m', 'mock app payload']); await git(['tag', 'app-v1.0.3']);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim(), payload = Buffer.from('mock full package');
  const release = { version: '1.0.3', url: 'https://github.com/MREASENTO/CellStation/releases/download/v1.0.3/CellStation-v1.0.3-win64.zip', sha256: digest(payload), size: payload.length, gitRevision: revision, gitRef: 'app-v1.0.3', gitRuntimeId: runtime, gitManifestSha256: digest(bytes) };
  const pair = crypto.generateKeyPairSync('ed25519'), config = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), feeds: ['https://feed.invalid/latest.json'], downloadPrefixes: [''] };
  const sign = r => ({ release: r, signature: crypto.sign(null, Buffer.from(canonical(r)), pair.privateKey).toString('base64') });
  const runGit = (args, options) => execFile('git', ['-c', 'safe.directory=' + path.join(dataRoot, 'updates/git-cache.git').replaceAll('\\', '/'), ...args.map(a => a === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : /^https:\/\/(cnb.cool|github.com)\//.test(a) ? repository : a)], options);
  return { root, install, dataRoot, config, release, sign, bytes, payload, runGit };
}
test('signed Git metadata rejects missing fields, alternate refs and malformed commits', async () => {
  const f = await fixture(); assert.equal(verifiedRelease(f.sign(f.release), f.config).gitRef, 'app-v1.0.3');
  for (const patch of [{ gitRef: 'main' }, { gitRevision: 'evil' }, { gitManifestSha256: null }, { gitRuntimeId: undefined }]) assert.throws(() => verifiedRelease(f.sign({ ...f.release, ...patch }), f.config), /格式/);
  assert.equal(eligibleGitUpdate(f.release, f.install), true); assert.equal(eligibleGitUpdate({ ...f.release, gitRuntimeId: 'b'.repeat(64) }, f.install), false);
});
test('app inventory rejects traversal, runtime/data paths, case collisions and unsigned content', async () => {
  const f = await fixture(); assert.equal(validateAppManifest(f.bytes, f.release).version, '1.0.3');
  for (const name of ['data/password.json', 'resources/app/runtime/python/python.exe', 'resources/app/../data/config', 'resources/app/CON.txt', 'resources/app/file.']) assert.equal(safeAppPath(name), false, name);
  const bad = JSON.parse(f.bytes); bad.files['resources/app/PACKAGE.JSON'] = 'a'.repeat(64); const bytes = Buffer.from(JSON.stringify(bad));
  assert.throws(() => validateAppManifest(bytes, { ...f.release, gitManifestSha256: digest(bytes) }), /路径/);
  assert.throws(() => validateAppManifest(Buffer.from('{}'), f.release), /校验/);
});
test('real Git fetch pins the signed tag and commit, falls back from CNB, and reuses a bare cache', async () => {
  const f = await fixture(); let cnbs = 0, origins = 0;
  const runGit = (args, options) => { if (args.includes('fetch')) { if (args.includes('https://cnb.cool/mreasento/CellStation')) { cnbs++; throw new Error('mock CNB unavailable'); } origins++; } return f.runGit(args, options); };
  const artifact = await fetchGitUpdate({ ...f, runGit }); assert.equal(artifact.release.kind, 'app'); assert.equal(fs.readFileSync(artifact.file).subarray(0, 2).toString(), 'PK'); assert.equal(cnbs, 1); assert.equal(origins, 1);
  await fetchGitUpdate({ ...f, runGit }); assert.equal(origins, 2);
  await assert.rejects(fetchGitUpdate({ ...f, runGit, release: { ...f.release, gitRevision: 'b'.repeat(40) } }), /不可用/);
});
test('updater selects Git application update without downloading the full package', async () => {
  const f = await fixture(); let installed, requests = 0;
  const updater = new AppUpdater({ ...f, installRoot: f.install, version: '1.0.2', request: async () => { requests++; return new Response(JSON.stringify(f.sign(f.release))); }, gitFetch: options => fetchGitUpdate({ ...options, runGit: f.runGit }), onInstall: async (file, release) => { installed = { file, release }; } });
  await updater.check(); await updater.install(); assert.equal(requests, 1); assert.equal(installed.release.kind, 'app'); assert.match(installed.file, /app\.git\.zip$/); updater.close();
});
test('Git failure falls back to a hash verified full package and runtime changes skip Git', async () => {
  for (const compatible of [true, false]) {
    const f = await fixture(); let attempts = 0, installed;
    if (!compatible) fs.writeFileSync(path.join(f.install, 'APP_UPDATE_MANIFEST.json'), JSON.stringify({ runtimeId: 'b'.repeat(64) }));
    const updater = new AppUpdater({ ...f, installRoot: f.install, version: '1.0.2', request: async url => new Response(url.endsWith('.zip') ? f.payload : JSON.stringify(f.sign(f.release))), gitFetch: async () => { attempts++; throw new Error('offline'); }, onInstall: async (file, release) => { installed = release; } });
    await updater.check(); await updater.install(); assert.equal(attempts, compatible ? 1 : 0); assert.equal(installed.kind, undefined); assert.equal(updater.publicState().transport, 'full'); updater.close();
  }
});
