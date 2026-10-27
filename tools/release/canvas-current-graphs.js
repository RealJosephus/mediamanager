import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';
import { readArchiveBytes, readZipDirectory, zipEntryDataRange } from '../../src/storage/zip-directory.js';
import { cargoString, json } from './materials.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const profiles = {
  'ubuntu-24.04': { target: 'x86_64-unknown-linux-gnu', host: { platform: 'linux', architecture: 'x64' } },
  'windows-2025': { target: 'x86_64-pc-windows-msvc', host: { platform: 'win32', architecture: 'x64' } },
  'macos-15': { target: 'aarch64-apple-darwin', host: { platform: 'darwin', architecture: 'arm64' } },
};

function archiveMembers(filename, size) {
  const fd = openSync(filename, 'r'), members = new Map(); let failed = false, primary;
  try {
    for (const entry of readZipDirectory(fd, size).entries) {
      if (entry.isDirectory) continue;
      if (members.has(entry.key) || entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 32 * 1024 * 1024) throw new Error('Original Canvas graph artifact member changed.');
      const range = zipEntryDataRange(fd, entry, size), compressed = readArchiveBytes(fd, range.start, entry.compressedSize, size);
      const bytes = entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: entry.size + 1 }) : compressed;
      if (bytes.length !== entry.size) throw new Error('Original Canvas graph artifact member is incomplete.');
      members.set(entry.key, bytes);
    }
  } catch (error) { failed = true; primary = error; }
  try { closeSync(fd); }
  catch (error) { if (failed) throw new AggregateError([primary, error], 'Canvas graph artifact read and close failed.', { cause: primary }); throw error; }
  if (failed) throw primary;
  return members;
}

export async function canvasCurrentGraphMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) throw new Error('Current Canvas graph material is missing or changed: ' + pin.path);
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.canvasCurrentGraphs)), native = JSON.parse(await read(offer.nativePackages)), supplied = JSON.parse(await read(offer.canvasCargoSources));
  const run = JSON.parse(await read(catalog.runReceipt)), jobs = JSON.parse(await read(catalog.jobsReceipt)), artifacts = JSON.parse(await read(catalog.artifactsReceipt));
  if (run.id !== catalog.runId || run.repository.full_name !== 'RealJosephus/mediamanager' || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Current Canvas graphs lack their actual successful CI source.');
  const trees = new Map();
  for (const tree of catalog.producerTrees) {
    const raw = await read(tree.object), members = new Map(); let offset = 0;
    if (gitIdentity('tree', raw) !== tree.gitTree) throw new Error('Original Canvas graph producer Git tree changed.');
    while (offset < raw.length) {
      const zero = raw.indexOf(0, offset), record = raw.subarray(offset, zero).toString('utf8'), space = record.indexOf(' ');
      if (zero < offset || zero + 21 > raw.length || space < 1) throw new Error('Original Canvas graph producer Git tree is incomplete.');
      members.set(record.slice(space + 1), { mode: record.slice(0, space), sha: raw.subarray(zero + 1, zero + 21).toString('hex') }); offset = zero + 21;
    }
    trees.set(tree.prefix, { sha: tree.gitTree, members });
  }
  if (trees.get('')?.sha !== run.head_commit.tree_id) throw new Error('Original Canvas graph producer differs from its actual candidate tree.');
  for (const [prefix, tree] of trees) {
    if (!prefix) continue;
    const parent = path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix), entry = trees.get(parent)?.members.get(path.posix.basename(prefix));
    if (entry?.mode !== '40000' || entry.sha !== tree.sha) throw new Error('Original Canvas graph producer subtree differs from its actual parent.');
  }
  for (const file of catalog.producer) {
    const raw = await read(file), member = trees.get(path.posix.dirname(file.upstreamPath))?.members.get(path.posix.basename(file.upstreamPath));
    if (member?.sha !== file.gitBlob || gitIdentity('blob', raw) !== file.gitBlob) throw new Error('Original Canvas graph producer Git blob changed.');
  }
  const bindings = new Map();
  for (const binding of catalog.inputBindings) {
    const bytes = await read(binding.supplied);
    if (bytes.length !== binding.original.bytes || sha256(bytes) !== binding.original.sha256 || bindings.has(binding.original.path)) throw new Error('Original Canvas graph captured input changed.');
    bindings.set(binding.original.path, bytes);
  }
  const originalNative = JSON.parse(bindings.get('native-packages.json').toString('utf8'));
  const originalSupplied = JSON.parse(bindings.get('canvas-cargo-sources.json').toString('utf8'));
  if (originalNative.canvas.candidate.commit !== native.canvas.candidate.commit || originalSupplied.canvasCommit !== native.canvas.candidate.commit) throw new Error('Current Canvas graphs identify another Canvas source commit.');
  const lockFile = originalNative.canvas.files.find(file => file.upstreamPath === 'Cargo.lock'), lock = bindings.get(lockFile.path);
  if (!lock || lock.length !== lockFile.bytes || sha256(lock) !== lockFile.sha256
    || !lock.equals(await read(native.canvas.files.find(file => file.upstreamPath === 'Cargo.lock')))) throw new Error('Current Canvas graphs lack their actual original source lock.');
  const packages = new Map(lock.toString('utf8').split(/^\[\[package\]\]\r?$/mu).slice(1).map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
  const seen = new Set(), selectedUnion = new Set(), usedInputs = new Set();
  for (const graph of catalog.graphs) {
    const profile = profiles[graph.runner], job = jobs.jobs.find(job => job.id === graph.jobId), artifact = artifacts.artifacts.find(artifact => artifact.id === graph.artifactId);
    if (!profile || seen.has(graph.runner) || graph.target !== profile.target || !isDeepStrictEqual(graph.host, profile.host)
      || job?.run_id !== run.id || job.head_sha !== run.head_sha || job.status !== 'completed' || job.conclusion !== 'success'
      || job.name !== 'Resolve declared Canvas source graph / ' + graph.runner || artifact?.workflow_run.id !== run.id
      || artifact.workflow_run.head_sha !== run.head_sha || artifact.name !== graph.artifactName || graph.artifactName !== `canvas-source-graph-${graph.runner}-${run.head_sha}`) {
      throw new Error('Current Canvas graph actual host/target/job association changed.');
    }
    seen.add(graph.runner);
    const zip = await read(graph.archive);
    if (artifact.digest !== 'sha256:' + sha256(zip) || artifact.size_in_bytes !== zip.length) throw new Error('Original Canvas graph ZIP differs from its original API digest.');
    const members = archiveMembers(path.join(root, directory, graph.archive.path), zip.length);
    if (!isDeepStrictEqual([...members.keys()].toSorted(), graph.members.map(file => file.member).toSorted())) throw new Error('Original Canvas graph artifact member set is incomplete.');
    for (const file of graph.members) {
      const bytes = members.get(file.member);
      if (!bytes.equals(await read(file)) || crc32(bytes).toString(16).padStart(8, '0') !== file.crc32) throw new Error('Original Canvas graph artifact member bytes changed.');
    }
    const capture = JSON.parse(members.get('receipt.json').toString('utf8'));
    if (capture.completed !== true || capture.suppliedSelectionCovered !== true || capture.newSources.length || capture.candidate.commit !== run.head_sha
      || capture.candidate.tree !== run.head_commit.tree_id || capture.canvasCommit !== native.canvas.candidate.commit || capture.target !== graph.target
      || !isDeepStrictEqual(capture.host, graph.host) || capture.package !== 'canvas' || !isDeepStrictEqual(capture.features, [])
      || !members.get('Cargo.lock').equals(lock) || capture.originalLock.bytes !== lock.length || capture.originalLock.sha256 !== sha256(lock)
      || capture.cargo !== members.get('logs/cargo-version.stdout').toString('utf8') || capture.rustc !== members.get('logs/rustc-version.stdout').toString('utf8')
      || !capture.rustc.split(/\r?\n/u).includes('host: ' + graph.target)) throw new Error('Current Canvas graph actual source/default selection changed.');
    for (const input of capture.inputs) {
      const bytes = bindings.get(input.path);
      if (!bytes || bytes.length !== input.bytes || sha256(bytes) !== input.sha256) throw new Error('Current Canvas graph captured input is missing or changed.');
      usedInputs.add(input.path);
    }
    for (const file of originalNative.canvas.files) if (!capture.inputs.some(input => input.path === file.path && input.bytes === file.bytes && input.sha256 === file.sha256)) throw new Error('Current Canvas graph omits an original Canvas source input.');
    const selected = new Map();
    for (const line of members.get('logs/library-tree.stdout').toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([A-Za-z0-9_-]+) v([^\s|]+)/u.exec(line), block = match && packages.get(match[1] + '@' + match[2]);
      if (!block) throw new Error('Current Canvas raw Cargo tree is outside its original lock.');
      selected.set(match[1] + '@' + match[2], { name: match[1], version: match[2], source: cargoString(block, 'source') ?? null, checksum: cargoString(block, 'checksum') ?? null });
    }
    const byPackage = (left, right) => left.name + '@' + left.version < right.name + '@' + right.version ? -1
      : left.name + '@' + left.version > right.name + '@' + right.version ? 1 : 0;
    if (!isDeepStrictEqual([...selected.values()].toSorted(byPackage), capture.selected.map(({ name, version, source, checksum }) => ({ name, version, source, checksum })).toSorted(byPackage))) throw new Error('Current Canvas graph selection differs from its original raw Cargo output.');
    for (const [key, selectedSource] of selected) {
      if (!selectedSource.source) continue;
      const source = supplied.crates.find(source => source.name === selectedSource.name && source.version === selectedSource.version);
      const original = originalSupplied.crates.find(source => source.name === selectedSource.name && source.version === selectedSource.version);
      const captured = capture.selected.find(source => source.name === selectedSource.name && source.version === selectedSource.version);
      if (!source || !original || source.archive.sha256 !== selectedSource.checksum || original.archive.sha256 !== selectedSource.checksum
        || source.source !== selectedSource.source || captured.supplied !== original.archive.path
        || !capture.inputs.some(input => input.path === original.archive.path && input.bytes === original.archive.bytes && input.sha256 === selectedSource.checksum)) {
        throw new Error('Current Canvas graph selected source is absent from the actual supplied container set.');
      }
      const bytes = await read(source.archive);
      if (sha256(bytes) !== selectedSource.checksum) throw new Error('Current Canvas selected container differs from its original source lock.');
      selectedUnion.add(key);
    }
  }
  if (!isDeepStrictEqual([...seen].toSorted(), Object.keys(profiles).toSorted()) || usedInputs.size !== bindings.size) throw new Error('Current Canvas graph actual profile/input group is incomplete.');
  await read(catalog.instructions);
  return { path: path.posix.join(directory, offer.canvasCurrentGraphs.path), selectedRegistrySources: selectedUnion.size,
    profiles: [...seen], limitations: catalog.limitations };
}
