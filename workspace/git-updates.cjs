'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const REPOSITORIES = ['https://cnb.cool/mreasento/CellStation', 'https://github.com/MREASENTO/CellStation'];
function safeAppPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.includes('\0')) return false;
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return false;
  return ['README.txt', 'PACKAGE_MANIFEST.json'].includes(name) || (name.startsWith('resources/app/') && parts[2].toLowerCase() !== 'runtime');
}
function validateAppManifest(bytes, release) {
  if (bytes.length > 2 * 1024 ** 2 || sha256(bytes) !== release.gitManifestSha256) throw new Error('应用更新清单校验失败');
  const manifest = JSON.parse(bytes);
  if (manifest.product !== 'CellStation' || manifest.kind !== 'app' || manifest.version !== release.version || manifest.runtimeId !== release.gitRuntimeId || manifest.accountDataIncluded !== false || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw new Error('应用更新清单格式错误');
  const names = Object.keys(manifest.files), seen = new Set();
  if (!names.length || names.length > 20000 || !names.includes('resources/app/package.json') || !names.includes('PACKAGE_MANIFEST.json')) throw new Error('应用更新文件不完整');
  for (const name of names) {
    if (!safeAppPath(name) || seen.has(name.toLowerCase()) || !/^[a-f0-9]{64}$/.test(manifest.files[name])) throw new Error('应用更新文件路径或校验值无效');
    seen.add(name.toLowerCase());
  }
  return manifest;
}
function eligibleGitUpdate(release, install) {
  if (!install || !release.gitRevision) return false;
  try {
    const current = JSON.parse(fs.readFileSync(path.join(install, 'APP_UPDATE_MANIFEST.json'), 'utf8'));
    return current.runtimeId === release.gitRuntimeId && fs.existsSync(path.join(install, 'resources/app/runtime/git/cmd/git.exe'));
  } catch { return false; }
}
function noLinkedParents(directory) {
  let current = path.resolve(directory);
  for (;;) { if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('更新目录不能为链接'); const parent = path.dirname(current); if (parent === current) break; current = parent; }
}
async function fetchGitUpdate({ release, config, install, dataRoot, progress = () => {}, runGit }) {
  const executable = path.join(install, 'resources/app/runtime/git/cmd/git.exe');
  const root = path.join(dataRoot, 'updates'), cache = path.join(root, 'git-cache.git'), hooks = path.join(root, 'empty-hooks'), temp = path.join(root, 'temp');
  noLinkedParents(root); noLinkedParents(cache);
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(hooks, { recursive: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ASKPASS: '', SSH_ASKPASS: '', TEMP: temp, TMP: temp };
  for (const key of Object.keys(env)) if (/^GIT_(?:CONFIG_(?:COUNT|KEY_|VALUE_)|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$)/.test(key)) delete env[key];
  const execute = runGit || ((args, options) => execFile(executable, args, options));
  const git = async args => (await execute(['-c', 'credential.helper=', '-c', 'http.sslVerify=true', ...(process.platform==='win32'?['-c','http.sslBackend=schannel']:[]), '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', `core.hooksPath=${hooks}`, '--git-dir=' + cache, ...args], { env, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 ** 2 })).stdout;
  if (!fs.existsSync(cache)) await git(['init', '--bare', cache]);
  if ((await git(['rev-parse', '--is-bare-repository'])).trim() !== 'true') throw new Error('应用更新缓存无效');
  const sources = (config.gitRepositories || REPOSITORIES).filter(url => REPOSITORIES.includes(url));
  for (const repository of sources) {
    try {
      progress({ message: repository.includes('cnb.cool') ? '正在从 CNB 拉取应用增量更新…' : '正在从 GitHub 拉取应用增量更新…', transport: 'git', source: repository.includes('cnb.cool') ? 'CNB' : 'GitHub' });
      await git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', repository, `refs/tags/${release.gitRef}`]);
      const revision = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
      if (revision !== release.gitRevision) throw new Error('Git更新提交与签名清单不一致');
      const bytes = Buffer.from(await git(['show', revision + ':APP_UPDATE_MANIFEST.json']), 'utf8');
      validateAppManifest(bytes, release);
      const directory = path.join(root, release.version); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'app.git.zip');
      await git(['archive', '--format=zip', '--prefix=CellStation-win32-x64/', '--output=' + file, revision]);
      const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return { file, release: { ...release, sha256: hash.digest('hex'), kind: 'app' }, source: repository, bytes: fs.statSync(file).size };
    } catch { /* Another verified source or the complete release remains available. */ }
  }
  throw new Error('Git应用更新源不可用');
}
module.exports = { safeAppPath, validateAppManifest, eligibleGitUpdate, fetchGitUpdate, REPOSITORIES };
