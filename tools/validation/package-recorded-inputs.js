// Input preparation only: this command verifies tracked sealed payloads and
// regenerates their derived indexes. It never starts an oracle, executes a
// bundled binary, imports a test, or runs a server.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const realRoot = await realpath(root);
const bundle = 'tests/fixtures/recorded-native';
const planFile = 'tools/validation/recorded-input-sources.json';
const mapFile = 'tools/validation/recorded-inputs.json';
const allowedExtensions = new Set(['.cs', '.csproj', '.props', '.json', '.dll', '.exe', '.txt', '.js', '.ts']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceKey = filename => /^[A-Za-z]:[\\/]/u.test(filename) && !/[\r\n\0]/u.test(filename)
  ? path.win32.normalize(filename).replaceAll('\\', '/').toLowerCase() : null;

function repositoryFile(relative, label) {
  if (typeof relative !== 'string' || !relative
    || /[:\\\r\n\0]/u.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid ${label}: ${relative}`);
  }
  const filename = path.resolve(root, ...relative.split('/'));
  const suffix = path.relative(root, filename);
  if (!suffix || suffix === '..' || suffix.startsWith('..' + path.sep) || path.isAbsolute(suffix)) {
    throw new Error(`Invalid ${label}: ${relative}`);
  }
  return filename;
}

function isWithinRepository(filename) {
  const relative = path.relative(realRoot, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function checkedExistingFile(relative, label) {
  const filename = repositoryFile(relative, label);
  let current = root;
  let information;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    information = await lstat(current);
    if (information.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink or junction: ${relative}`);
  }
  if (!information.isFile()) throw new Error(`${label} must be an existing regular file: ${relative}`);
  const resolved = await realpath(filename);
  if (!isWithinRepository(resolved)) throw new Error(`${label} escapes the repository: ${relative}`);
  return resolved;
}

const readRepositoryFile = async (relative, label) => readFile(await checkedExistingFile(relative, label));
const json = async (relative, label) => JSON.parse((await readRepositoryFile(relative, label)).toString('utf8'));

const licenseInputs = [
  { path: 'D:/jellyfin/LICENSE', bytes: 18014,
    sha256: 'f371b80469fb235bc500ec29e0e85b682d4a6157a158567d828ff0be544d4f1d', required: true,
    target: `${bundle}/LICENSE-Jellyfin.txt` },
  { path: 'D:/mediamanager/.tools/dotnet/LICENSE.txt', bytes: 9519,
    sha256: '7f6839a61ce892b79c6549e2dc5a81fdbd240a0b260f8881216b45b7fda8b45d', required: true,
    target: `${bundle}/LICENSE-Dotnet.txt` },
  { path: 'D:/mediamanager/.tools/dotnet/ThirdPartyNotices.txt', bytes: 78887,
    sha256: 'deb4427a295e1ed474b0d81c5a0d972c1b550b9a715cda939cdfa9236b1b418f', required: true,
    target: `${bundle}/ThirdPartyNotices-Dotnet.txt` }
];
const licenseTargets = new Map(licenseInputs.map(value => [sourceKey(value.path) + '\0' + value.sha256, value.target]));
const licenseSources = new Set(licenseInputs.map(value => sourceKey(value.path)));

function descriptor(value, source = value?.path ?? value?.filename) {
  if (!sourceKey(source) || !Number.isSafeInteger(value?.bytes) || value.bytes < 0
    || !/^[a-f0-9]{64}$/u.test(value?.sha256)) {
    throw new Error('Malformed hash-bound provenance input: ' + source);
  }
  return { path: source, bytes: value.bytes, sha256: value.sha256, required: true };
}

const requiredManifestContracts = new Map([
  ['library-directory-monitor', {
    target: 'tests/library/fixtures/library-directory-monitor/required-inputs.json',
    provenance: 'tests/library/fixtures/library-directory-monitor/provenance.json',
    derive(provenance) {
      if (!Array.isArray(provenance.sourceFiles) || !Array.isArray(provenance.requiredInputs)
        || !Array.isArray(provenance.runtime?.sourceFiles)) throw new Error('Malformed directory-monitor provenance.');
      return [...provenance.sourceFiles, ...provenance.requiredInputs, ...provenance.runtime.sourceFiles].map(value => descriptor(value));
    }
  }],
  ['user-view-collage', {
    target: 'tests/images/fixtures/user-view-collage/required-inputs.json',
    provenance: 'tests/images/fixtures/user-view-collage/provenance.json',
    derive(provenance) {
      if (!Array.isArray(provenance.sources) || !Array.isArray(provenance.oracleSources)) {
        throw new Error('Malformed UserView-collage provenance.');
      }
      return [
        ...provenance.sources.map(value => descriptor(value, 'D:/jellyfin/' + value.path)),
        ...provenance.oracleSources.map(value => descriptor(value)),
        descriptor(provenance.oracleAssembly),
        descriptor(provenance.jellyfinDll),
        descriptor(provenance.dotnet),
        descriptor(provenance.executionRecord),
        descriptor(provenance.buildClosureReceipt)
      ];
    }
  }]
]);
const allowedDerivedTargets = new Set([mapFile, ...[...requiredManifestContracts.values()].map(value => value.target)]);

const plan = await json(planFile, 'recorded-input source plan');
if (plan.schemaVersion !== 1 || typeof plan.scope !== 'string' || !plan.scope
  || typeof plan.sourcesReviewed !== 'string' || !plan.sourcesReviewed
  || !Array.isArray(plan.entries) || !Array.isArray(plan.requiredInputManifests)) {
  throw new Error('Invalid recorded-input source plan.');
}

function validConsumer(consumer) {
  if (typeof consumer !== 'string' || !consumer) return false;
  if (consumer !== 'license') repositoryFile(consumer, 'recorded-input consumer');
  return true;
}

const identities = new Map();
const targets = new Map();
const consumerFiles = new Set();
for (const entry of plan.entries) {
  const normalizedSource = typeof entry?.source === 'string' ? sourceKey(entry.source) : null;
  const extension = normalizedSource && (path.win32.extname(entry.source).toLowerCase() || '.txt');
  if (!normalizedSource || !allowedExtensions.has(extension)
    || !/^[a-f0-9]{64}$/u.test(entry.sha256)
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
    || !Array.isArray(entry.consumers) || !entry.consumers.length
    || entry.consumers.some(consumer => !validConsumer(consumer))
    || new Set(entry.consumers).size !== entry.consumers.length
    || entry.acquisition?.kind !== 'tracked-sealed-payload'
    || entry.acquisition.path !== entry.target) {
    throw new Error('Malformed recorded-input source entry: ' + entry?.source);
  }
  repositoryFile(entry.target, 'recorded-input target');
  const identity = normalizedSource + '\0' + entry.sha256;
  const friendlyTarget = licenseTargets.get(identity);
  const expectedTarget = friendlyTarget ?? `${bundle}/objects/${entry.sha256}${extension}`;
  if (entry.target !== expectedTarget || identities.has(identity)
    || licenseSources.has(normalizedSource) !== Boolean(friendlyTarget)
    || (friendlyTarget && (entry.consumers.length !== 1 || entry.consumers[0] !== 'license'))
    || (!friendlyTarget && entry.consumers.includes('license'))) {
    throw new Error('Invalid or duplicate recorded-input identity: ' + entry.source);
  }
  const target = targets.get(entry.target);
  if (target && (target.sha256 !== entry.sha256 || target.bytes !== entry.bytes)) {
    throw new Error('Conflicting recorded-input target: ' + entry.target);
  }
  identities.set(identity, entry);
  targets.set(entry.target, entry);
  for (const consumer of entry.consumers) if (consumer !== 'license') consumerFiles.add(consumer);
}
for (const consumer of consumerFiles) await checkedExistingFile(consumer, 'recorded-input consumer');

// Audit the exact JSON payloads before using them. These records should contain
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

const prepared = new Map();
for (const entry of plan.entries) {
  let bytes = prepared.get(entry.acquisition.path);
  if (!bytes) {
    bytes = await readRepositoryFile(entry.acquisition.path, 'tracked sealed payload');
    prepared.set(entry.acquisition.path, bytes);
  }
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
    throw new Error('Tracked sealed payload changed: ' + entry.acquisition.path);
  }
  if (path.win32.extname(entry.source).toLowerCase() === '.json') {
    inspectJson(JSON.parse(bytes.toString('utf8')));
  }
}

function expectedReference(input, consumer) {
  return { source: input.path, bytes: input.bytes, sha256: input.sha256, consumer };
}

function sameReference(actual, expected) {
  return actual && Object.keys(actual).length === 4
    && actual.source === expected.source && actual.bytes === expected.bytes
    && actual.sha256 === expected.sha256 && actual.consumer === expected.consumer;
}

const derivedManifests = [];
const seenManifestKinds = new Set();
for (const manifest of plan.requiredInputManifests) {
  const contract = requiredManifestContracts.get(manifest?.kind);
  if (!contract || seenManifestKinds.has(manifest.kind)
    || manifest.target !== contract.target || manifest.provenance?.path !== contract.provenance
    || typeof manifest.scope !== 'string' || !manifest.scope
    || !/^[a-f0-9]{64}$/u.test(manifest.provenance?.sha256)
    || !Array.isArray(manifest.sourceIdentities)) {
    throw new Error('Malformed or unexpected required-input manifest plan: ' + manifest?.target);
  }
  seenManifestKinds.add(manifest.kind);
  const provenanceBytes = await readRepositoryFile(contract.provenance, 'required-input provenance');
  if (digest(provenanceBytes) !== manifest.provenance.sha256) {
    throw new Error('Required-input provenance changed: ' + contract.provenance);
  }
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  const provenanceInputs = contract.derive(provenance);
  const requiredInputs = [...provenanceInputs, ...licenseInputs.map(({ target: _target, ...input }) => input)];
  const expectedReferences = [
    ...provenanceInputs.map(input => expectedReference(input, contract.provenance)),
    ...licenseInputs.map(input => expectedReference(input, 'license'))
  ];
  if (manifest.sourceIdentities.length !== expectedReferences.length
    || manifest.sourceIdentities.some((reference, index) => !sameReference(reference, expectedReferences[index]))) {
    throw new Error('Required-input source identities do not match hash-bound provenance: ' + manifest.kind);
  }
  for (const reference of expectedReferences) {
    const entry = identities.get(sourceKey(reference.source) + '\0' + reference.sha256);
    if (!entry || entry.source !== reference.source || entry.bytes !== reference.bytes
      || !entry.consumers.includes(reference.consumer)) {
      throw new Error('Required-input identity is absent from its declared consumer: ' + reference.source);
    }
  }
  const filename = await checkedExistingFile(contract.target, 'derived required-input manifest');
  derivedManifests.push({ target: contract.target, filename, value: {
    schemaVersion: 1,
    scope: manifest.scope,
    provenanceSha256: manifest.provenance.sha256,
    requiredInputs
  } });
}
if (seenManifestKinds.size !== requiredManifestContracts.size) {
  throw new Error('The required-input manifest plan is incomplete.');
}

const derivedMap = {
  schemaVersion: 1,
  scope: plan.scope,
  sourcesReviewed: plan.sourcesReviewed,
  entries: plan.entries.map(({ acquisition: _acquisition, ...entry }) => entry)
};
const mapFilename = await checkedExistingFile(mapFile, 'derived recorded-input map');

async function writeDerived(target, filename, value) {
  if (!allowedDerivedTargets.has(target)) throw new Error('Refusing to write an unexpected derived file: ' + target);
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n');
}

// All payloads, provenance documents, source identities and output files have
// been validated before the first derived byte is replaced.
for (const derived of derivedManifests) await writeDerived(derived.target, derived.filename, derived.value);
await writeDerived(mapFile, mapFilename, derivedMap);

console.log(JSON.stringify({ preparedFiles: prepared.size,
  bytes: [...prepared.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  plan: planFile, manifest: mapFile, derivedFiles: derivedManifests.length + 1,
  executedOracles: false, executedTests: false }));
