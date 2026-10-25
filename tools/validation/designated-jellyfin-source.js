import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const designatedJellyfinHead = '208c278b75abd897aefa1e1175126eac5e4dbfaa';
export const designatedJellyfinContentDigest = 'e28a983db179b720c3b16d7416ee4112894a3115c4be6fe43c61c52e0d9a8313';
export const designatedJellyfinSourceFiles = 2620;
export const designatedJellyfinDirtyFiles = 20;
export const designatedJellyfinRepository = 'RealJosephus/mediamanager';

const packageFilename = fileURLToPath(new URL('../../tests/fixtures/recorded-native/jellyfin-source-package.json', import.meta.url));
const ordering = 'JavaScript UTF-16 code-unit order; forward-slash paths; LF records';
const descriptorPaths = {
  archive: 'jellyfin-source-208c278b75ab.zip',
  sourceManifest: 'jellyfin-source-manifest.json',
  localModifications: 'jellyfin-local-modifications.json',
  license: 'LICENSE-Jellyfin.txt',
};
const descriptorPins = {
  archive: { bytes: 3867186, sha256: '92edc03192499dcdd98439072a6ece32ab839bb1f5bb0c9abbda03284ec9f161' },
  sourceManifest: { bytes: 513264, sha256: '2012abc83017dfd2a107a49b701531a0dad08c763bc721dc75726342002c8f5c' },
  localModifications: { bytes: 11636, sha256: '83671401df5455b4085fee49b4a4a437974981250f74bf345ca730814938fdc2' },
  license: { sha256: 'f371b80469fb235bc500ec29e0e85b682d4a6157a158567d828ff0be544d4f1d' },
};
const sourceOfferNames = ['archive', 'sourceManifest', 'localModifications', 'license'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function memberPath(value, label = 'designated Jellyfin source member') {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[:\\\r\n\0]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid ${label} path.`);
  }
  return value;
}

function packageDescriptor(sourcePackage, name) {
  const descriptor = sourcePackage?.[name], pinned = descriptorPins[name];
  if (!descriptor || descriptor.required !== true || descriptor.path !== descriptorPaths[name]
    || !digest(descriptor.sha256) || descriptor.sha256 !== pinned.sha256
    || descriptor.bytes !== pinned.bytes) {
    throw new Error(`Invalid designated Jellyfin ${name} descriptor.`);
  }
  memberPath(descriptor.path);
  return descriptor;
}

function validatePackage(sourcePackage) {
  if (sourcePackage?.schemaVersion !== 1 || sourcePackage.prefix !== 'jellyfin-source/'
    || sourcePackage.head !== designatedJellyfinHead
    || sourcePackage.sourceContentDigest !== designatedJellyfinContentDigest
    || sourcePackage.sourceFiles !== designatedJellyfinSourceFiles
    || sourcePackage.localModificationFiles !== designatedJellyfinDirtyFiles
    || !Number.isSafeInteger(sourcePackage.sourceBytes) || sourcePackage.sourceBytes < 0
    || !Array.isArray(sourcePackage.excludedSourceFiles) || sourcePackage.excludedSourceFiles.length !== 0
    || sourcePackage.audit?.manifestDigestsMatched !== true
    || sourcePackage.audit?.allLocalModificationsRetained !== true
    || sourcePackage.audit?.noInstanceOrBuildOutputInputs !== true
    || sourcePackage.audit?.sourcePathAndCredentialMarkerReview !== true
    || sourcePackage.audit?.archiveMemberDigestsMatched !== true) {
    throw new Error('The designated Jellyfin source package identity or audit declaration changed.');
  }
  for (const name of Object.keys(descriptorPaths)) packageDescriptor(sourcePackage, name);
}

function statusEntries(value) {
  if (typeof value !== 'string' || !value.endsWith('\0')) throw new Error('Invalid designated Jellyfin Git status capture.');
  const records = value.slice(0, -1).split('\0');
  if (records.some(record => record.length < 4 || record[2] !== ' ')) throw new Error('Invalid designated Jellyfin Git status record.');
  return records.map(record => {
    const status = record.slice(0, 2), sourcePath = memberPath(record.slice(3), 'designated Jellyfin dirty source');
    if (status !== ' M' && status !== '??') throw new Error('Unexpected designated Jellyfin Git status.');
    return { status, path: sourcePath };
  });
}

/** Validate the semantic links between the pinned package, manifest and local-modification ledger. */
export function validateDesignatedJellyfinSourceDocuments({ sourcePackage, manifest, modifications }) {
  validatePackage(sourcePackage);
  if (manifest?.source !== 'D:\\jellyfin' || manifest.head !== designatedJellyfinHead
    || manifest.ordering !== ordering || manifest.contentDigest !== designatedJellyfinContentDigest
    || !Array.isArray(manifest.files) || manifest.files.length !== designatedJellyfinSourceFiles) {
    throw new Error('The designated Jellyfin source manifest identity changed.');
  }
  const sourcePaths = [], sourceByPath = new Map();
  const aggregate = createHash('sha256');
  let sourceBytes = 0;
  for (const file of manifest.files) {
    const sourcePath = memberPath(file?.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !digest(file.sha256) || sourceByPath.has(sourcePath)) {
      throw new Error('Invalid or duplicate designated Jellyfin source descriptor.');
    }
    sourcePaths.push(sourcePath); sourceByPath.set(sourcePath, file); sourceBytes += file.size;
    aggregate.update(`${sourcePath}\t${file.sha256}\n`);
  }
  if (JSON.stringify(sourcePaths) !== JSON.stringify([...sourcePaths].sort())) {
    throw new Error('The designated Jellyfin source manifest is not in its declared order.');
  }
  if (aggregate.digest('hex') !== designatedJellyfinContentDigest || sourceBytes !== sourcePackage.sourceBytes) {
    throw new Error('The designated Jellyfin aggregate source identity changed.');
  }
  const dirty = statusEntries(manifest.status);
  if (dirty.length !== designatedJellyfinDirtyFiles || new Set(dirty.map(entry => entry.path)).size !== dirty.length
    || dirty.filter(entry => entry.status === ' M').length !== 19 || dirty.filter(entry => entry.status === '??').length !== 1) {
    throw new Error('The designated Jellyfin dirty-source status is incomplete.');
  }
  if (modifications?.head !== designatedJellyfinHead
    || modifications.sourceContentDigest !== designatedJellyfinContentDigest
    || modifications.original !== manifest.source || modifications.status !== manifest.status
    || typeof modifications.copy !== 'string' || !modifications.copy
    || !Array.isArray(modifications.entries) || modifications.entries.length !== designatedJellyfinDirtyFiles) {
    throw new Error('The designated Jellyfin local-modification ledger identity changed.');
  }
  const dirtyByPath = new Map(dirty.map(entry => [entry.path, entry.status])), modificationPaths = new Set();
  for (const entry of modifications.entries) {
    const sourcePath = memberPath(entry?.path, 'designated Jellyfin local modification');
    const pinned = sourceByPath.get(sourcePath), descriptor = entry.sourceDescriptor;
    if (modificationPaths.has(sourcePath) || dirtyByPath.get(sourcePath) !== entry.status || descriptor?.path !== sourcePath
      || descriptor.size !== pinned?.size || descriptor.sha256 !== pinned?.sha256) {
      throw new Error('A designated Jellyfin local modification is not bound to its source descriptor.');
    }
    modificationPaths.add(sourcePath);
  }
  if (modificationPaths.size !== dirtyByPath.size || [...dirtyByPath.keys()].some(sourcePath => !modificationPaths.has(sourcePath))) {
    throw new Error('The designated Jellyfin dirty-source ledger is not bidirectionally complete.');
  }
  const license = sourceByPath.get('LICENSE');
  if (!license || license.sha256 !== sourcePackage.license.sha256) {
    throw new Error('The designated Jellyfin license is not bound to the source manifest.');
  }
  return { sourceByPath, dirtyByPath, sourceBytes };
}

async function ordinary(root, relative) {
  memberPath(relative);
  let filename = root;
  for (const part of ['', ...relative.split('/')]) {
    if (part) filename = path.join(filename, part);
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('A designated Jellyfin source input traverses a symbolic link.');
  }
  if (!(await lstat(filename)).isFile()) throw new Error('A designated Jellyfin source input is not an ordinary file.');
  return filename;
}

async function expected(root, descriptor) {
  const filename = await ordinary(root, descriptor.path), bytes = await readFile(filename);
  if ((descriptor.bytes != null && bytes.length !== descriptor.bytes) || hash(bytes) !== descriptor.sha256) {
    throw new Error(`Designated Jellyfin source input changed: ${descriptor.path}`);
  }
  return { filename, bytes, descriptor: { path: descriptor.path, bytes: bytes.length, sha256: descriptor.sha256 } };
}

/** Read and byte-verify the complete designated Jellyfin source package and current source offer. */
export async function verifyDesignatedJellyfinSourcePackage(filename = packageFilename) {
  const root = path.dirname(path.resolve(filename));
  const resolvedPackage = await ordinary(root, path.basename(filename)), packageBytes = await readFile(resolvedPackage);
  const sourcePackage = JSON.parse(packageBytes);
  validatePackage(sourcePackage);
  const attachments = {};
  for (const name of Object.keys(descriptorPaths)) attachments[name] = await expected(root, packageDescriptor(sourcePackage, name));
  const manifest = JSON.parse(attachments.sourceManifest.bytes);
  const modifications = JSON.parse(attachments.localModifications.bytes);
  const semantic = validateDesignatedJellyfinSourceDocuments({ sourcePackage, manifest, modifications });
  if (attachments.license.descriptor.bytes !== semantic.sourceByPath.get('LICENSE').size) {
    throw new Error('The designated Jellyfin license size is not bound to the source manifest.');
  }
  const packageSha256 = hash(packageBytes);
  const inputs = [{ filename: resolvedPackage, bytes: packageBytes.length, sha256: packageSha256 },
    ...Object.values(attachments).map(value => ({ filename: value.filename, bytes: value.descriptor.bytes, sha256: value.descriptor.sha256 }))];
  const sourceOffer = sourceOfferNames.map(name => attachments[name].descriptor);
  return { package: sourcePackage, manifest, modifications, attachments, inputs, sourceOffer,
    packageFilename: resolvedPackage, packageSha256 };
}
