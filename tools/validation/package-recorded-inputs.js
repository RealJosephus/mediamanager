// Input preparation only: this command copies sealed recording inputs. It never
// starts an oracle, executes a bundled binary, imports a test, or runs a server.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = 'tests/fixtures/recorded-native';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = filename => path.win32.normalize(filename).replaceAll('\\', '/').toLowerCase();
const json = async filename => JSON.parse(await readFile(path.resolve(root, filename), 'utf8'));
const monitorFile = 'tests/library/fixtures/library-directory-monitor/provenance.json';
const collageFile = 'tests/images/fixtures/user-view-collage/provenance.json';
const monitor = await json(monitorFile), collage = await json(collageFile);
const descriptor = value => ({ path: value.path ?? value.filename, bytes: value.bytes, sha256: value.sha256, required: true });
const groups = [
  { fixture: 'tests/library/fixtures/library-directory-monitor', provenance: monitorFile,
    inputs: [...monitor.sourceFiles, ...monitor.requiredInputs, ...monitor.runtime.sourceFiles].map(descriptor) },
  { fixture: 'tests/images/fixtures/user-view-collage', provenance: collageFile,
    inputs: [...collage.sources.map(value => ({ ...value, path: 'D:/jellyfin/' + value.path })),
      ...collage.oracleSources, collage.oracleAssembly, collage.jellyfinDll, collage.dotnet,
      collage.executionRecord, collage.buildClosureReceipt].map(descriptor) }
];
const licenseSources = [
  ['D:/jellyfin/LICENSE', 'LICENSE-Jellyfin.txt'],
  ['D:/mediamanager/.tools/dotnet/LICENSE.txt', 'LICENSE-Dotnet.txt'],
  ['D:/mediamanager/.tools/dotnet/ThirdPartyNotices.txt', 'ThirdPartyNotices-Dotnet.txt']
];
const sources = new Map(), licenses = [];
function add(value, consumer, target) {
  if (!/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error('Malformed sealed file descriptor: ' + value.path);
  }
  const identity = key(value.path) + '\0' + value.sha256, existing = sources.get(identity);
  if (existing && existing.bytes !== value.bytes) {
    throw new Error('Conflicting recording identities at ' + value.path);
  }
  const suffix = path.win32.extname(value.path).toLowerCase() || '.txt';
  if (!['.cs', '.csproj', '.props', '.json', '.dll', '.exe', '.txt'].includes(suffix)) {
    throw new Error('Unexpected evidence file type: ' + value.path);
  }
  const entry = existing ?? { source: value.path, target: target ?? `${bundle}/objects/${value.sha256}${suffix}`,
    bytes: value.bytes, sha256: value.sha256, consumers: [] };
  if (!entry.consumers.includes(consumer)) entry.consumers.push(consumer);
  sources.set(identity, entry);
}
for (const group of groups) for (const value of group.inputs) add(value, group.provenance);
for (const [source, name] of licenseSources) {
  const bytes = await readFile(source), value = { path: source, bytes: bytes.length, sha256: digest(bytes), required: true };
  add(value, 'license', `${bundle}/${name}`); licenses.push(value);
}

// Audit the exact JSON records before copying. These records should contain
// only synthetic fixture observations, source/build paths, hashes and commands.
// Report key names only if a secret-bearing field is encountered.
function inspectJson(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    if (/^(?:password|passwd|secret|token|accessToken|refreshToken|authorization|cookie|connectionString)$/iu.test(name)
      && child != null && child !== '') throw new Error('Review secret-bearing JSON field before packaging: ' + location + '.' + name);
    if (typeof child === 'string' && /(?:https?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@/iu.test(child)) {
      throw new Error('Review credential-bearing URL before packaging: ' + location + '.' + name);
    }
    inspectJson(child, location + '.' + name);
  }
}
const prepared = [];
for (const entry of sources.values()) {
  const bytes = await readFile(entry.source);
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('Recorded input changed: ' + entry.source);
  if (entry.source.endsWith('.json')) inspectJson(JSON.parse(bytes));
  prepared.push({ entry, bytes });
}
async function seal(relative, bytes) {
  const filename = path.resolve(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  try { await writeFile(filename, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(filename)).equals(Buffer.from(bytes))) throw new Error('Refusing to replace different packaged bytes: ' + relative);
  }
}
for (const { entry, bytes } of prepared) await seal(entry.target, bytes);
for (const group of groups) await seal(group.fixture + '/required-inputs.json', JSON.stringify({
  schemaVersion: 1,
  scope: 'Recorded regression evidence only. Original manifests and native outputs remain unchanged. Bundled executables are hash inputs, never runtime executables.',
  provenanceSha256: digest(await readFile(path.resolve(root, group.provenance))),
  requiredInputs: [...group.inputs, ...licenses]
}, null, 2) + '\n');
await seal('tools/validation/recorded-inputs.json', JSON.stringify({
  schemaVersion: 1,
  scope: 'Exact original-path-and-SHA-256 relocation of sealed monitor and collage recording inputs; no prefix, basename or runtime-executable fallback.',
  sourcesReviewed: 'Only designated source files, controlled fixture helpers, synthetic recordings, execution/build receipts and pinned binary identities; no instance database, configuration, environment dump, key or user media is included.',
  entries: [...sources.values()].sort((left, right) => key(left.source).localeCompare(key(right.source)) || left.sha256.localeCompare(right.sha256))
}, null, 2) + '\n');
console.log(JSON.stringify({ preparedFiles: prepared.length, bytes: prepared.reduce((sum, value) => sum + value.bytes.length, 0),
  manifest: 'tools/validation/recorded-inputs.json', executedOracles: false, executedTests: false }));
