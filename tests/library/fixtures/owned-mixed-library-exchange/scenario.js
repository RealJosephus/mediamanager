import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { databaseFilename, ownedPath, sha, stoppedDatabase } from '../../../helpers/library-exchange-state.js';

export const inputBytes = await readFile(new URL('./input.json', import.meta.url));
export const input = JSON.parse(inputBytes);
// Literal source URLs also bind every unchanged original to the ordinary
// validation inventory. This fixture never invokes an encoder or container writer.
export const assets = {
  video: await readFile(new URL('../../../playback/fixtures/vobsub-delivery/source.mkv', import.meta.url)),
  audio: await readFile(new URL('../../../playback/fixtures/flac-copy-current/assets/upstream/subset/60 - mono audio.flac', import.meta.url)),
  book: await readFile(new URL('../../../metadata/fixtures/book-opf-current/assets/main/epub/rich-both-separators.epub', import.meta.url)),
  photo: await readFile(new URL('../../../metadata/fixtures/photo-provider/assets/plain.jpg', import.meta.url)),
};
for (const [kind, bytes] of Object.entries(assets)) {
  assert.equal(bytes.length, input.assets[kind].bytes);
  assert.equal(sha(bytes), input.assets[kind].sha256);
}

export function declaredMedia(root) {
  const mediaRoot = ownedPath(root, path.join(root, 'media'));
  const resolve = (relative, sourceOnly = false) => ownedPath(sourceOnly ? root : mediaRoot,
    path.resolve(mediaRoot, ...relative.split('/')));
  const files = input.files.map(file => {
    const bytes = file.asset ? assets[file.asset] : Buffer.from(file.text, 'utf8');
    return { ...file, filename: resolve(file.path, file.sourceOnly),
      phase: file.phase ?? 'initial', bytes,
      expected: { bytes: bytes.length, sha256: sha(bytes) },
      contentType: file.contentType ?? input.assets[file.asset].contentType };
  });
  assert.equal(new Set(files.map(file => file.filename)).size, files.length, 'Each declared media path has one source.');
  const sidecars = input.sidecars.map(file => ({ ...file, filename: resolve(file.path),
    phase: file.phase ?? 'initial', bytes: Buffer.from(file.text, 'utf8') }));
  return { root, mediaRoot, files, sidecars,
    libraries: input.libraries.map(library => ({ ...library, filename: resolve(library.directory) })),
    directories: input.directories.map(directory => ({ ...directory, filename: resolve(directory.path) })) };
}

export async function materializePhase(media, phase) {
  for (const file of [...media.files, ...media.sidecars].filter(file => file.phase === phase)) {
    await mkdir(path.dirname(file.filename), { recursive: true });
    await writeFile(file.filename, file.bytes, { flag: 'wx' });
  }
}

// Run the baseline at the same physical instance/media paths as Node will use.
// After it stops, retain its complete owned tree and restore the saved empty
// instance. No metadata, database or cache written by the baseline seeds Node.
export async function saveEmptyInstance(root, instanceRoot) {
  ownedPath(root, instanceRoot);
  const saved = ownedPath(root, path.join(root, 'saved-empty-instance'));
  await stoppedDatabase(databaseFilename(instanceRoot));
  await cp(instanceRoot, saved, { recursive: true, force: false, errorOnExist: true });
  await stoppedDatabase(databaseFilename(saved));
  return saved;
}

export async function restoreEmptyInstance(root, instanceRoot, saved) {
  const target = ownedPath(root, instanceRoot), source = ownedPath(root, saved);
  const retained = ownedPath(root, path.join(root, 'native-baseline-instance'));
  await stoppedDatabase(databaseFilename(target)); await stoppedDatabase(databaseFilename(source));
  await rename(target, retained);
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  await stoppedDatabase(databaseFilename(target));
  return { saved, retained, restored: target };
}

export async function observeSourceFiles(media) {
  const observations = [];
  for (const file of media.files) {
    let info;
    try { info = await lstat(file.filename); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      observations.push({ key: file.key, absent: true }); continue;
    }
    assert.ok(info.isFile() && !info.isSymbolicLink(), file.key);
    const bytes = await readFile(file.filename);
    assert.deepEqual(bytes, file.bytes, file.key + ' retains the unchanged original media bytes.');
    observations.push({ key: file.key, filename: file.filename, bytes: bytes.length, sha256: sha(bytes) });
  }
  return observations;
}

export async function sourceFiles(media, present) {
  const expected = new Set(present), observations = await observeSourceFiles(media);
  for (const file of observations) {
    assert.equal(!file.absent, expected.has(file.key), file.key + ' actual source presence');
  }
  return observations;
}

export async function sidecarFiles(media) {
  const observations = [];
  for (const file of media.sidecars) {
    let bytes;
    try { bytes = await readFile(file.filename); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (file.path.endsWith('.keep')) throw error;
      observations.push({ path: file.path, absent: true }); continue;
    }
    if (file.path.endsWith('.keep')) assert.deepEqual(bytes, file.bytes, 'An unrelated sibling survives item deletion.');
    observations.push({ path: file.path, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });
  }
  return observations;
}

export function libraryOptions(library) {
  return { ...input.libraryOptions,
    PathInfos: [{ Path: library.filename }],
    TypeOptions: input.disabledRemoteTypes.map(Type => ({ Type,
      MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [],
      ImageOptions: [], SimilarItemProviders: [], SimilarItemProviderOrder: [] })) };
}

export async function configureStorage(root) {
  const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
  const ancestors = ownedPath(root, path.join(root, 'empty-ignore-ancestors')); await mkdir(ancestors);
  const mountContract = { mounts: [{ mountId: 'owned-library-exchange', identityRoot: root,
    accessRoot: '/owned-library-exchange', pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
  const filename = ownedPath(root, path.join(root, 'storage.json'));
  await writeFile(filename, JSON.stringify({
    instances: [{ id: 'owned-library-exchange', type: 'local', config: { root, writable: true } },
      { id: 'empty-ancestors', type: 'local', config: { root: ancestors, writable: false } }],
    mounts: [{ path: '/owned-library-exchange', instanceId: 'owned-library-exchange', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
    { path: '/empty-ignore-ancestors', instanceId: 'empty-ancestors', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/owned-library-exchange', style, caseSensitive,
      returnAccess: 'The same owned library and instance paths are retained through actual Native continuation.' }],
    ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ignore-ancestors', style, caseSensitive,
      returnAccess: 'Only declared empty ancestors belong to this isolated exchange.' }],
  }, null, 2) + '\n', { flag: 'wx' });
  return { filename, mountContract };
}
