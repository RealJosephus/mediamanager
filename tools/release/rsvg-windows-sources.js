import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cargoString, gitCommand, inside, json, removeOwned, sourceArchiveMembers } from './materials.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

async function verifyEffectiveSource(root, pristine, effective, patch) {
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, 'rsvg-windows-source-'));
  let failed = false, primary;
  try {
    for (const [name, bytes] of pristine) {
      const filename = path.join(work, name); inside(work, filename);
      await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
    }
    await gitCommand(['init', '--quiet'], { cwd: work });
    await gitCommand(['config', 'core.autocrlf', 'false'], { cwd: work });
    const patchFile = path.join(work, 'original-windows.patch'); await writeFile(patchFile, patch, { flag: 'wx' });
    await gitCommand(['apply', patchFile], { cwd: work });
    for (const [name, expected] of effective) {
      const filename = path.join(work, name); inside(work, filename);
      if (!(await readFile(filename)).equals(expected)) throw new Error('Effective Windows source differs from its original applied patch: ' + name);
    }
  } catch (error) { failed = true; primary = error; }
  try { await removeOwned(parent, work); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], 'Windows source preparation and cleanup failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
}

export async function rsvgWindowsSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) throw new Error('Windows librsvg source material is missing or changed: ' + pin.path);
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.rsvgWindowsSources));
  const run = JSON.parse(await read(catalog.runReceipt)), job = JSON.parse(await read(catalog.jobReceipt)), capture = JSON.parse(await read(catalog.captureReceipt));
  if (run.id !== catalog.runId || run.repository.full_name !== 'RealJosephus/mediamanager' || run.head_sha !== capture.candidate.commit
    || run.head_commit.tree_id !== capture.candidate.tree || run.status !== 'completed' || run.conclusion !== 'success'
    || job.id !== catalog.jobId || job.run_id !== run.id || job.head_sha !== capture.candidate.commit || job.status !== 'completed' || job.conclusion !== 'success'
    || capture.completed !== true || capture.target !== 'x86_64-pc-windows-gnullvm' || capture.package !== 'librsvg-c' || !isDeepStrictEqual(capture.features, [])) {
    throw new Error('Windows source graph differs from its actual completed CI capture.');
  }
  const trees = new Map();
  for (const tree of catalog.producerTrees) {
    const raw = await read(tree.object), members = new Map(); let offset = 0;
    if (gitIdentity('tree', raw) !== tree.gitTree) throw new Error('Windows source producer original Git tree changed.');
    while (offset < raw.length) {
      const zero = raw.indexOf(0, offset), record = raw.subarray(offset, zero).toString('utf8'), space = record.indexOf(' ');
      if (zero < offset || zero + 21 > raw.length || space < 1) throw new Error('Windows source producer Git tree is incomplete.');
      members.set(record.slice(space + 1), { mode: record.slice(0, space), sha: raw.subarray(zero + 1, zero + 21).toString('hex') }); offset = zero + 21;
    }
    trees.set(tree.prefix, { sha: tree.gitTree, members });
  }
  if (trees.get('')?.sha !== capture.candidate.tree) throw new Error('Windows source producer tree differs from its actual candidate.');
  for (const [prefix, tree] of trees) {
    if (!prefix) continue;
    const parent = path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix), entry = trees.get(parent)?.members.get(path.posix.basename(prefix));
    if (entry?.mode !== '40000' || entry.sha !== tree.sha) throw new Error('Windows source producer Git subtree differs from its actual parent.');
  }
  for (const file of catalog.producer) {
    const raw = await read(file), member = trees.get(path.posix.dirname(file.upstreamPath))?.members.get(path.posix.basename(file.upstreamPath));
    if (member?.sha !== file.gitBlob || gitIdentity('blob', raw) !== file.gitBlob) throw new Error('Windows source producer original Git blob changed.');
  }
  const bindings = new Map();
  for (const binding of catalog.inputBindings) {
    const actual = capture.inputs.find(input => input.path === binding.original.path);
    if (!actual || actual.bytes !== binding.original.bytes || actual.sha256 !== binding.original.sha256
      || binding.supplied.bytes !== actual.bytes || binding.supplied.sha256 !== actual.sha256) throw new Error('Windows source capture input association changed.');
    bindings.set(actual.path, await read(binding.supplied));
  }
  if (capture.inputs.some(input => !bindings.has(input.path))) throw new Error('Windows source capture input set is incomplete.');
  const fullOffer = JSON.parse(bindings.get('native-full-sources.json').toString('utf8')), library = fullOffer.sources.find(source => source.name === 'rsvg');
  const originalMembers = JSON.parse(await read(library.members)), pristine = new Map(), effective = new Map();
  for (const file of catalog.pristine) {
    const bytes = await read(file), original = originalMembers.find(member => member.path === library.root + file.upstreamPath);
    if (original?.kind !== 'file' || original.bytes !== bytes.length || original.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error('Windows pristine source differs from its original librsvg archive.');
    }
    pristine.set(file.upstreamPath, bytes);
  }
  for (const file of catalog.effective) effective.set(file.upstreamPath, await read(file));
  const patches = library.modifications.windows.patches;
  if (patches.length !== 1 || !bindings.has(patches[0].path)) throw new Error('Windows source preparation lacks its actual original patch.');
  const patch = bindings.get(patches[0].path);
  const affected = [...patch.toString('utf8').matchAll(/^diff --git a\/([^\r\n ]+) b\/[^\r\n ]+$/gmu)].map(match => match[1]);
  if (affected.some(name => !pristine.has(name) || !effective.has(name))) throw new Error('Windows source preparation omits an actually patched source file.');
  await verifyEffectiveSource(root, pristine, effective, patch);
  const lock = effective.get('Cargo.lock');
  if (!lock || lock.length !== capture.effectiveLock.bytes || createHash('sha256').update(lock).digest('hex') !== capture.effectiveLock.sha256) {
    throw new Error('Windows source graph effective lock differs from its actual capture.');
  }
  const packages = new Map(lock.toString('utf8').split(/^\[\[package\]\]\r?$/mu).slice(1)
    .map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
  const outputs = new Map(); for (const output of catalog.logs) outputs.set(output.name + '.' + output.stream, await read(output));
  const selected = new Map();
  for (const line of outputs.get('library-tree.stdout').toString('utf8').split(/\r?\n/u).filter(Boolean)) {
    const match = /^([A-Za-z0-9_-]+) v([^\s|]+)/u.exec(line); if (!match) throw new Error('Windows Cargo tree source row changed.');
    const key = match[1] + '@' + match[2], block = packages.get(key);
    if (!block) throw new Error('Windows Cargo tree version is absent from its actual effective lock.');
    selected.set(key, { name: match[1], version: match[2], source: cargoString(block, 'source') ?? null, checksum: cargoString(block, 'checksum') ?? null });
  }
  if (!isDeepStrictEqual(capture.selected.map(({ name, version, source, checksum }) => ({ name, version, source, checksum })), [...selected.values()])) {
    throw new Error('Windows Cargo source set differs from its actual captured tree.');
  }
  const old = JSON.parse(await read(offer.rsvgCargoSources)), canvas = JSON.parse(await read(offer.canvasCargoSources)), supplied = new Set();
  for (const source of catalog.crates) {
    const key = source.name + '@' + source.version, chosen = selected.get(key), block = packages.get(key);
    if (!chosen?.source || supplied.has(key) || chosen.source !== source.source || source.archive.url !== `https://static.crates.io/crates/${source.name}/${source.name}-${source.version}.crate`) {
      throw new Error('Windows Cargo source differs from its actual declared library selection.');
    }
    supplied.add(key);
    if (source.origin.kind === 'already-supplied') {
      const previous = (source.origin.catalog === offer.rsvgCargoSources.path ? old.crates : source.origin.catalog === offer.canvasCargoSources.path ? canvas.crates : [])
        .find(previous => previous.name === source.name && previous.version === source.version);
      if (!previous || ['path', 'bytes', 'sha256', 'url'].some(key => previous.archive[key] !== source.archive[key])) throw new Error('Reused Windows Cargo source container changed.');
    } else if (source.origin.kind !== 'captured-exact-version-source-read') throw new Error('Unknown Windows Cargo source acquisition.');
    const archive = await read(source.archive);
    if (createHash('sha256').update(archive).digest('hex') !== chosen.checksum || chosen.checksum !== cargoString(block, 'checksum')) throw new Error('Windows Cargo source differs from its actual effective lock checksum.');
    if (source.registry) {
      const response = JSON.parse(await read(source.registry.receipt));
      if (source.registry.url !== `https://crates.io/api/v1/crates/${source.name}/${source.version}`
        || response.version.crate !== source.name || response.version.num !== source.version || response.version.checksum !== chosen.checksum) throw new Error('Windows Cargo source original registry association changed.');
    }
    const members = sourceArchiveMembers(archive, source.members), prefix = source.name + '-' + source.version + '/';
    const manifest = members.get(prefix + 'Cargo.toml')?.toString('utf8').split(/^\[package\]\r?$/mu)[1]?.split(/^\[/mu)[0], vcs = members.get(prefix + '.cargo_vcs_info.json');
    if (cargoString(manifest, 'name') !== source.name || cargoString(manifest, 'version') !== source.version
      || (cargoString(manifest, 'license') ?? null) !== source.license || (cargoString(manifest, 'license-file') ?? null) !== source.licenseFile
      || (vcs ? source.vcs?.member !== prefix + '.cargo_vcs_info.json' || !isDeepStrictEqual(JSON.parse(vcs.toString('utf8')), source.vcs?.value) : source.vcs !== null)) {
      throw new Error('Windows Cargo original package or VCS declaration changed.');
    }
    const notices = [...members.keys()].filter(member => member === prefix + source.licenseFile || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(member)));
    if (!isDeepStrictEqual(source.notices.map(notice => notice.member).toSorted(), notices.toSorted())) throw new Error('Windows Cargo original notice set is incomplete.');
    for (const notice of source.notices) if (!members.get(notice.member)?.equals(await read(notice))) throw new Error('Windows Cargo original notice differs from its published member.');
  }
  if (!isDeepStrictEqual([...supplied].toSorted(), [...selected].filter(([, source]) => source.source).map(([key]) => key).toSorted())) throw new Error('Windows Cargo library source set is incomplete.');
  await read(catalog.instructions);
  return { path: path.posix.join(directory, offer.rsvgWindowsSources.path), limitations: catalog.limitations };
}
