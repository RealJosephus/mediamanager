import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';
import { readArchiveBytes, readZipDirectory, zipEntryDataRange } from '../../src/storage/zip-directory.js';
import { cargoString, json, sourceArchiveMembers } from './materials.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const gitSha = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const profiles = {
  'linux-x64': { runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu', host: { platform: 'linux', architecture: 'x64' } },
  'darwin-arm64v8': { runner: 'macos-15', target: 'aarch64-apple-darwin', host: { platform: 'darwin', architecture: 'arm64' } },
};
const packageKey = value => value.name + '@' + value.version;
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
const filePin = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });

function originalZip(filename, size) {
  const fd = openSync(filename, 'r'), members = new Map(); let failure;
  try {
    for (const entry of readZipDirectory(fd, size).entries) {
      if (entry.isDirectory) continue;
      if (members.has(entry.key) || entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 32 * 1024 * 1024) throw new Error('Original POSIX graph ZIP member changed.');
      const range = zipEntryDataRange(fd, entry, size), compressed = readArchiveBytes(fd, range.start, entry.compressedSize, size);
      const bytes = entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: entry.size + 1 }) : compressed;
      if (bytes.length !== entry.size) throw new Error('Original POSIX graph ZIP member is incomplete.');
      members.set(entry.key, bytes);
    }
  } catch (error) { failure = error; }
  try { closeSync(fd); } catch (error) { if (failure) throw new AggregateError([failure, error], 'POSIX graph ZIP read and close failed.', { cause: failure }); throw error; }
  if (failure) throw failure;
  return members;
}

export async function rsvgPosixSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(entry => [entry.path, entry]));
  const read = async pin => {
    const file = pin && entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) throw new Error('POSIX librsvg material is missing or changed: ' + pin?.path);
    const bytes = await readFile(path.join(root, directory, pin.path));
    if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw new Error('POSIX librsvg material bytes changed: ' + pin.path);
    return bytes;
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.rsvgPosixSources));
  const run = JSON.parse(await read(catalog.runReceipt)), jobs = JSON.parse(await read(catalog.jobsReceipt)), artifacts = JSON.parse(await read(catalog.artifactsReceipt));
  if (run.id !== catalog.runId || run.repository.full_name !== 'RealJosephus/mediamanager' || run.status !== 'completed' || run.conclusion !== 'success'
    || jobs.total_count !== jobs.jobs.length || artifacts.total_count !== artifacts.artifacts.length) throw new Error('POSIX graphs lack their actual complete successful CI source.');
  const commit = await read(catalog.producerCommit.object);
  if (catalog.producerCommit.gitCommit !== run.head_sha || gitSha('commit', commit) !== run.head_sha
    || !commit.toString('utf8').startsWith('tree ' + run.head_commit.tree_id + '\n')) throw new Error('POSIX graph original producer commit changed.');
  const trees = new Map();
  for (const record of catalog.producerTrees) {
    const raw = await read(record.object), children = new Map(); let offset = 0;
    if (gitSha('tree', raw) !== record.gitTree || trees.has(record.prefix)) throw new Error('POSIX graph original producer Git tree changed.');
    while (offset < raw.length) {
      const zero = raw.indexOf(0, offset), row = raw.subarray(offset, zero).toString('utf8'), space = row.indexOf(' ');
      if (zero < offset || zero + 21 > raw.length || space < 1) throw new Error('POSIX graph original producer Git tree is incomplete.');
      children.set(row.slice(space + 1), { mode: row.slice(0, space), sha: raw.subarray(zero + 1, zero + 21).toString('hex') }); offset = zero + 21;
    }
    trees.set(record.prefix, { sha: record.gitTree, children });
  }
  if (trees.get('')?.sha !== run.head_commit.tree_id) throw new Error('POSIX graph producer tree differs from its actual candidate.');
  for (const [prefix, record] of trees) {
    if (!prefix) continue;
    const parent = path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix), child = trees.get(parent)?.children.get(path.posix.basename(prefix));
    if (child?.mode !== '40000' || child.sha !== record.sha) throw new Error('POSIX producer subtree differs from its original parent.');
  }
  const producers = new Map();
  for (const file of catalog.producer) {
    const bytes = await read(file), original = trees.get(path.posix.dirname(file.upstreamPath))?.children.get(path.posix.basename(file.upstreamPath));
    if (original?.sha !== file.gitBlob || gitSha('blob', bytes) !== file.gitBlob || producers.has(file.upstreamPath)) throw new Error('POSIX graph producer original Git blob changed.');
    producers.set(file.upstreamPath, bytes);
  }
  const expectedProducers = ['.github/workflows/native-source-graph.yml', 'tools/release/capture-rsvg-posix-sources.js', 'tools/release/materials.js', 'tools/release/license-texts.js'];
  if (!isDeepStrictEqual([...producers.keys()].sort(), expectedProducers.sort())) throw new Error('POSIX graph original producer set is incomplete.');
  const supplied = new Map();
  for (const pin of [offer.rsvgCargoSources, offer.rsvgWindowsSources, offer.canvasCargoSources]) supplied.set(pin.path, JSON.parse(await read(pin)));
  const currentLibrary = JSON.parse(await read(offer.nativeFullSources)).sources.find(entry => entry.name === 'rsvg');
  await read(currentLibrary.archive);
  const originalMembers = JSON.parse(await read(currentLibrary.members));
  for (const notice of currentLibrary.notices) await read(notice);
  const selectedUnion = new Map(), seen = new Set();
  for (const graph of catalog.graphs) {
    const profile = profiles[graph.platform], job = jobs.jobs.find(entry => entry.id === graph.jobId), artifact = artifacts.artifacts.find(entry => entry.id === graph.artifactId);
    if (!profile || seen.has(graph.platform) || graph.runner !== profile.runner || graph.target !== profile.target || !isDeepStrictEqual(graph.host, profile.host)
      || job?.run_id !== run.id || job.head_sha !== run.head_sha || job.status !== 'completed' || job.conclusion !== 'success'
      || job.name !== 'Resolve current post-edit POSIX librsvg source graph / ' + graph.platform || !job.labels.includes(graph.runner)
      || artifact?.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha || artifact.name !== graph.artifactName
      || graph.artifactName !== `posix-rsvg-source-graph-${graph.platform}-${run.head_sha}`) throw new Error('POSIX graph actual host/target/job association changed.');
    seen.add(graph.platform);
    const zip = await read(graph.archive);
    if (artifact.digest !== 'sha256:' + sha(zip) || artifact.size_in_bytes !== zip.length) throw new Error('Original POSIX graph ZIP differs from its original API digest.');
    const members = originalZip(path.join(root, directory, graph.archive.path), zip.length);
    if (!isDeepStrictEqual([...members.keys()].sort(), graph.members.map(entry => entry.member).sort())) throw new Error('Original POSIX graph ZIP member set is incomplete.');
    for (const record of graph.members) {
      const bytes = members.get(record.member);
      if (bytes.length !== record.bytes || sha(bytes) !== record.sha256 || crc32(bytes).toString(16).padStart(8, '0') !== record.crc32) throw new Error('Original POSIX graph ZIP member bytes/CRC changed.');
    }
    const capture = JSON.parse(members.get('receipt.json').toString('utf8'));
    if (!capture.completed || !capture.suppliedSelectionCovered || capture.newSources.length || capture.candidate.commit !== run.head_sha
      || capture.candidate.tree !== run.head_commit.tree_id || capture.candidate.statusBefore || capture.candidate.statusAfter
      || !isDeepStrictEqual(capture.profile, { platform: graph.platform, target: graph.target, compilerHost: graph.target, package: 'librsvg-c',
        edges: ['normal', 'build'], defaultFeatures: true, extraFeatures: [], rustChannel: 'nightly', mesonExecuted: false })
      || capture.host.platform !== profile.host.platform || capture.host.architecture !== profile.host.architecture
      || capture.cargo !== members.get('logs/cargo-version.stdout').toString('utf8') || capture.rustc !== members.get('logs/rustc-version.stdout').toString('utf8')
      || !capture.rustc.split(/\r?\n/u).includes('host: ' + graph.target)) throw new Error('POSIX graph actual current source/default profile changed.');
    for (const command of capture.commands) {
      if (!command.completed || command.code !== 0 || command.signal || command.timedOut || !command.completeOutput
        || !isDeepStrictEqual(JSON.parse(members.get('logs/' + command.name + '.process.json').toString('utf8')), command)) throw new Error('POSIX graph command receipt is incomplete or changed.');
      for (const stream of ['stdout', 'stderr']) if (!isDeepStrictEqual(filePin(members.get(command[stream].path)), { bytes: command[stream].bytes, sha256: command[stream].sha256 })) throw new Error('POSIX graph original command output changed.');
    }
    const treeCommand = capture.commands.find(entry => entry.name === 'library-tree'), updateCommand = capture.commands.find(entry => entry.name === 'update-workspace');
    if (!isDeepStrictEqual(treeCommand?.args, ['tree', '--locked', '--target', graph.target, '--package', 'librsvg-c', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p} | {f}', '--color', 'never'])
      || !isDeepStrictEqual(updateCommand?.args, ['update', '--workspace']) || treeCommand.program !== 'cargo' || updateCommand.program !== 'cargo') throw new Error('POSIX graph original resolution commands changed.');
    for (const metadata of capture.toolchain.metadata) if (!isDeepStrictEqual(filePin(members.get('toolchain/' + path.posix.basename(metadata.path))), { bytes: metadata.bytes, sha256: metadata.sha256 })) throw new Error('POSIX graph actual SDK metadata changed.');
    for (const binary of capture.toolchain.binaries) if (!/^[a-f0-9]{64}$/u.test(binary.sha256) || members.get('logs/' + binary.program + '-which.stdout').toString('utf8').trim() !== binary.path) throw new Error('POSIX graph actual tool identity changed.');
    const inputs = new Map();
    for (const binding of graph.inputBindings) {
      let bytes;
      if (binding.source.kind === 'artifact') bytes = members.get(binding.source.member);
      else if (binding.source.kind === 'producer') {
        if (binding.original.path !== binding.source.upstreamPath) throw new Error('POSIX graph original producer input role changed.');
        bytes = producers.get(binding.source.upstreamPath);
      }
      else if (binding.source.kind === 'material') {
        if (binding.original.path !== directory + '/' + binding.source.pin.path) throw new Error('POSIX graph original material input role changed.');
        bytes = await read(binding.source.pin);
      } else throw new Error('Unknown POSIX graph original input binding.');
      const input = capture.inputs.find(entry => entry.path === binding.original.path);
      if (!input || !bytes || inputs.has(input.path) || !isDeepStrictEqual(input, binding.original)
        || !isDeepStrictEqual(filePin(bytes), { bytes: input.bytes, sha256: input.sha256 })) throw new Error('POSIX graph original captured input is incomplete or changed.');
      inputs.set(input.path, bytes);
    }
    if (inputs.size !== capture.inputs.length) throw new Error('POSIX graph original input set is incomplete.');
    const get = relative => inputs.get(directory + '/' + relative);
    const originalOffer = JSON.parse(get('source-offer.json').toString('utf8'));
    for (const pin of [originalOffer.nativeFullSources, originalOffer.recipeFragments, originalOffer.rsvgCargoSources, originalOffer.rsvgWindowsSources, originalOffer.canvasCargoSources]) {
      if (!isDeepStrictEqual(filePin(get(pin.path)), { bytes: pin.bytes, sha256: pin.sha256 })) throw new Error('POSIX graph original source offer association changed.');
    }
    const originalCatalogs = new Map([originalOffer.rsvgCargoSources, originalOffer.rsvgWindowsSources, originalOffer.canvasCargoSources]
      .map(pin => [pin.path, JSON.parse(get(pin.path).toString('utf8'))]));
    const library = JSON.parse(get(originalOffer.nativeFullSources.path).toString('utf8')).sources.find(entry => entry.name === 'rsvg');
    if (!isDeepStrictEqual(library, currentLibrary)) throw new Error('POSIX graph identifies another complete librsvg source.');
    const recipes = JSON.parse(get(originalOffer.recipeFragments.path).toString('utf8')), recipe = recipes.sources.find(entry => entry.id === library.modifications.posix.sourceId);
    const region = library.modifications.posix.originalRegion, originalRecipe = recipe.files.find(entry => entry.upstreamPath === library.modifications.posix.upstreamPath);
    if (!get(originalRecipe.path).toString('utf8').includes(region) || !members.get('inputs/librsvg-original-region.sh').equals(Buffer.from(region))) throw new Error('POSIX graph original inline edit region changed.');
    const editLines = region.split('\n'), start = editLines.findIndex(line => line.startsWith("sed -i'.bak' ")), end = editLines.indexOf('cargo update --workspace');
    if (!members.get('inputs/apply-posix-inline-edits.sh').equals(Buffer.from('#!/usr/bin/env bash\nset -eu\n' + editLines.slice(start, end).join('\n') + '\n'))) throw new Error('POSIX graph executed inline edit script differs from its actual original recipe.');
    const inventories = Object.fromEntries(['pristine', 'post-edit', 'effective', 'after-tree'].map(name => [name, JSON.parse(members.get('source-trees/' + name + '.json').toString('utf8'))]));
    const pristine = originalMembers.filter(entry => entry.kind === 'file' || entry.kind === 'symlink').map(entry => entry.kind === 'file'
      ? { path: entry.path.slice(library.root.length), bytes: entry.bytes, sha256: entry.sha256 }
      : { path: entry.path.slice(library.root.length), kind: 'link', target: path.posix.relative(path.posix.dirname(entry.path),
        path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target))) });
    if (!isDeepStrictEqual(inventories.pristine.toSorted(byPath), pristine.toSorted(byPath))) throw new Error('POSIX pristine source differs from its complete original archive member set.');
    const expected = new Map(pristine.map(entry => [entry.path, entry]));
    const replaceLines = (text, predicate, from) => text.split('\n').map(line => predicate(line) ? line.replace(from, '') : line).join('\n');
    const originalRsvg = members.get('pristine/rsvg/Cargo.toml').toString('utf8'), originalC = members.get('pristine/librsvg-c/Cargo.toml').toString('utf8');
    const imageEdit = replaceLines(originalRsvg, line => line.includes('image = '), ', "gif", "webp"');
    const transformed = { 'rsvg/Cargo.toml': replaceLines(imageEdit, line => line.includes('cairo-rs = '), ', "pdf", "ps"'),
      'librsvg-c/Cargo.toml': replaceLines(originalC, line => line.includes('cairo-rs = '), ', "pdf", "ps"'),
      'meson.build': replaceLines(members.get('pristine/meson.build').toString('utf8'), line => line.startsWith("if host_system in ['windows'"), ", 'linux'"),
      'rsvg/Cargo.toml.bak': imageEdit, 'librsvg-c/Cargo.toml.bak': originalC, 'meson.build.bak': members.get('pristine/meson.build').toString('utf8') };
    for (const [name, text] of Object.entries(transformed)) expected.set(name, { path: name, ...filePin(Buffer.from(text)) });
    if (!isDeepStrictEqual(inventories['post-edit'].toSorted(byPath), [...expected.values()].toSorted(byPath))) throw new Error('POSIX post-edit source differs from its original inline transformations.');
    const lock = members.get('effective/Cargo.lock'); expected.set('Cargo.lock', { path: 'Cargo.lock', ...filePin(lock) });
    if (!isDeepStrictEqual(inventories.effective.toSorted(byPath), [...expected.values()].toSorted(byPath))
      || !isDeepStrictEqual(inventories['after-tree'].toSorted(byPath), inventories.effective.toSorted(byPath))) throw new Error('POSIX effective source changed outside its actual lock regeneration.');
    for (const [stage, name] of [['pristine', 'pristineLock'], ['post-edit', 'postEditLock'], ['effective', 'effectiveLock']]) {
      if (!isDeepStrictEqual(filePin(members.get(stage + '/Cargo.lock')), { bytes: capture[name].bytes, sha256: capture[name].sha256 })) throw new Error('POSIX graph stage lock bytes changed.');
    }
    for (const [stage, list] of [['pristine', capture.pristine], ['post-edit', capture.postEdit], ['effective', capture.effective]]) for (const file of list) {
      if (!isDeepStrictEqual(filePin(members.get(stage + '/' + file.path)), { bytes: file.bytes, sha256: file.sha256 })
        || !inventories[stage].some(entry => isDeepStrictEqual(entry, file))) throw new Error('POSIX graph stage source snapshot changed.');
    }
    const packages = new Map(lock.toString('utf8').split(/^\[\[package\]\]\r?$/mu).slice(1).map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
    const selected = new Map();
    for (const line of members.get('logs/library-tree.stdout').toString('utf8').split(/\r?\n/u).filter(Boolean)) {
      const match = /^([A-Za-z0-9_-]+) v([^\s|]+)/u.exec(line), block = match && packages.get(match[1] + '@' + match[2]);
      if (!block) throw new Error('POSIX raw Cargo tree is outside its actual effective lock.');
      selected.set(match[1] + '@' + match[2], { name: match[1], version: match[2], source: cargoString(block, 'source') ?? null, checksum: cargoString(block, 'checksum') ?? null });
    }
    if (!isDeepStrictEqual([...selected.values()], capture.selected.map(({ name, version, source, checksum }) => ({ name, version, source, checksum })))) throw new Error('POSIX graph selection differs from its actual raw Cargo output.');
    for (const [key, entry] of selected) {
      const captured = capture.selected.find(item => packageKey(item) === key);
      if (!entry.source) {
        if (!inventories.effective.some(file => file.path === captured.workspaceManifest) || captured.suppliedBy !== library.archive.path) throw new Error('POSIX selected workspace lacks its complete original source.');
        continue;
      }
      if (entry.source !== 'registry+https://github.com/rust-lang/crates.io-index') throw new Error('POSIX selected source needs explicit non-registry acquisition.');
      const origin = catalog.crateOrigins.find(item => packageKey(item) === key), source = supplied.get(origin?.catalog)?.crates.find(item => packageKey(item) === key);
      const original = originalCatalogs.get(origin?.catalog)?.crates.find(item => packageKey(item) === key);
      if (!source || !original || source.source !== entry.source || source.archive.sha256 !== entry.checksum || original.archive.sha256 !== entry.checksum
        || source.archive.url !== `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`
        || ['path', 'bytes', 'sha256', 'url'].some(field => source.archive[field] !== original.archive[field])
        || source.archive.path !== captured.supplied || captured.catalog !== origin.catalog || !get(source.archive.path)?.equals(await read(source.archive))) throw new Error('POSIX selected original source container is absent or changed.');
      selectedUnion.set(key, source);
    }
  }
  if (!isDeepStrictEqual([...seen].sort(), Object.keys(profiles).sort()) || !isDeepStrictEqual(catalog.crateOrigins.map(packageKey).sort(), [...selectedUnion.keys()].sort())) throw new Error('POSIX graph actual profile or complete selected source group is incomplete.');
  for (const source of selectedUnion.values()) {
    const archive = await read(source.archive), members = sourceArchiveMembers(archive, source.members), prefix = source.name + '-' + source.version + '/';
    const manifest = members.get(prefix + 'Cargo.toml')?.toString('utf8').split(/^\[package\]\r?$/mu)[1]?.split(/^\[/mu)[0];
    if (cargoString(manifest, 'name') !== source.name || cargoString(manifest, 'version') !== source.version
      || (cargoString(manifest, 'license') ?? null) !== source.license || (cargoString(manifest, 'license-file') ?? null) !== source.licenseFile) throw new Error('POSIX original crate package/license declaration changed.');
    const vcs = members.get(prefix + '.cargo_vcs_info.json');
    if (vcs ? source.vcs?.member !== prefix + '.cargo_vcs_info.json' || !isDeepStrictEqual(JSON.parse(vcs.toString('utf8')), source.vcs?.value) : source.vcs !== null) throw new Error('POSIX original crate VCS declaration changed.');
    const notices = [...members.keys()].filter(member => member === prefix + source.licenseFile || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(member)));
    if (!isDeepStrictEqual(source.notices.map(entry => entry.member).sort(), notices.sort())) throw new Error('POSIX selected original notice set is incomplete.');
    for (const notice of source.notices) if (!members.get(notice.member)?.equals(await read(notice))) throw new Error('POSIX selected notice differs from its complete original package member.');
  }
  await read(catalog.instructions);
  return { path: path.posix.join(directory, offer.rsvgPosixSources.path), profiles: [...seen], selectedRegistrySources: selectedUnion.size, limitations: catalog.limitations };
}
