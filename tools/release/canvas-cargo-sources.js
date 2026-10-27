import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { cargoString, json, sourceArchiveMembers } from './materials.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

export async function canvasCargoSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) throw new Error('Canvas Cargo source material is missing or changed: ' + pin.path);
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.canvasCargoSources)), native = JSON.parse(await read(offer.nativePackages));
  if (catalog.canvasCatalog !== offer.nativePackages.path || catalog.canvasCommit !== native.canvas.candidate.commit || catalog.lockFile !== 'Cargo.lock') {
    throw new Error('Observed Canvas Cargo source differs from its actual source commit.');
  }
  const lock = (await read(native.canvas.files.find(file => file.upstreamPath === catalog.lockFile))).toString('utf8');
  const packages = new Map(lock.split(/^\[\[package\]\]\r?$/mu).slice(1)
    .map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
  const selected = new Set(), platforms = new Set();
  const roles = { linux: 'linux-x64-gnu', windows: 'windows-x64-msvc', macos: 'macos-arm64' };
  for (const observation of catalog.observations) {
    if (!Object.hasOwn(roles, observation.platform) || platforms.has(observation.platform)) throw new Error('Observed Canvas compile platform is missing or duplicated.');
    platforms.add(observation.platform);
    const declared = native.canvas.observedJobs.find(job => job.role === roles[observation.platform]);
    const job = JSON.parse(await read(observation.jobReceipt));
    if (observation.runId !== native.canvas.runId || observation.jobId !== declared.jobId || observation.name !== declared.name
      || job.id !== declared.jobId || job.run_id !== native.canvas.runId || job.head_sha !== native.canvas.candidate.commit
      || job.name !== declared.name || job.status !== 'completed' || job.conclusion !== 'success') {
      throw new Error('Observed Canvas compile source differs from its original producer job.');
    }
    const raw = gunzipSync(await read(observation.archive), { maxOutputLength: observation.rawLog.bytes + 1 });
    if (raw.length !== observation.rawLog.bytes || createHash('sha256').update(raw).digest('hex') !== observation.rawLog.sha256) {
      throw new Error('Observed Canvas original compile log changed.');
    }
    const windows = job.steps.filter(step => ['Build', 'Build in docker'].includes(step.name) && step.conclusion === 'success');
    const rows = [], lines = raw.toString('utf8').split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      // Parse the producer's colored Cargo rows while retaining each complete original line.
      const line = lines[index].replace(/\u001b\[[0-9;]*m/gu, ''), match = /Compiling ([A-Za-z0-9_-]+) v([^\s]+)/u.exec(line);
      if (!match) continue;
      const when = Date.parse(line.split(' ', 1)[0]);
      const window = windows.find(step => when >= Date.parse(step.started_at) && when <= Date.parse(step.completed_at));
      if (!window) continue;
      const key = match[1] + '@' + match[2], block = packages.get(key);
      if (!block) throw new Error('Actual Canvas compile version is absent from its original source lock: ' + key);
      rows.push({ line: index + 1, text: lines[index], stepNumber: window.number, name: match[1], version: match[2] });
      if (cargoString(block, 'source')) selected.add(key);
    }
    if (!rows.length || !isDeepStrictEqual(rows, observation.compiles)) throw new Error('Observed Canvas actual library compile rows changed.');
  }
  if (platforms.size !== 3) throw new Error('Observed Canvas compile platform set is incomplete.');
  const rsvg = JSON.parse(await read(offer.rsvgCargoSources));
  const supplied = new Set(), sourceByKey = new Map(), repositoryNotices = new Map(catalog.repositoryNotices.map(source => [source.id, source]));
  let libloadingManifest;
  for (const source of catalog.crates) {
    const key = source.name + '@' + source.version, block = packages.get(key);
    if (!block || supplied.has(key) || source.source !== cargoString(block, 'source')
      || source.source !== 'registry+https://github.com/rust-lang/crates.io-index'
      || source.archive.url !== `https://static.crates.io/crates/${source.name}/${source.name}-${source.version}.crate`) {
      throw new Error('Supplied Canvas Cargo source differs from its original lock.');
    }
    supplied.add(key); sourceByKey.set(key, source);
    if (source.origin.kind === 'already-supplied') {
      const candidates = source.origin.catalog === offer.nativePackages.path ? native.canvas.cargo.crates
        : source.origin.catalog === offer.rsvgCargoSources.path ? rsvg.crates : [];
      const previous = candidates.find(previous => previous.name === source.name && previous.version === source.version);
      if (!previous || ['path', 'bytes', 'sha256', 'url'].some(key => previous.archive[key] !== source.archive[key])) {
        throw new Error('Reused Canvas source differs from its actual supplied container.');
      }
    } else if (source.origin.kind !== 'current-exact-version-source-read') throw new Error('Unknown Canvas source acquisition.');
    const archive = await read(source.archive);
    if (createHash('sha256').update(archive).digest('hex') !== cargoString(block, 'checksum')) throw new Error('Canvas Cargo archive differs from its original lock checksum.');
    if (source.registry) {
      const response = JSON.parse(await read(source.registry.receipt));
      if (source.registry.url !== `https://crates.io/api/v1/crates/${source.name}/${source.version}`
        || response.version.crate !== source.name || response.version.num !== source.version || response.version.checksum !== cargoString(block, 'checksum')
        || response.version.crate_size !== archive.length) throw new Error('Canvas Cargo original registry association changed.');
    }
    const members = sourceArchiveMembers(archive, source.members), prefix = source.name + '-' + source.version + '/';
    const manifest = members.get(prefix + 'Cargo.toml')?.toString('utf8').split(/^\[package\]\r?$/mu)[1]?.split(/^\[/mu)[0];
    const vcs = members.get(prefix + '.cargo_vcs_info.json');
    if (cargoString(manifest, 'name') !== source.name || cargoString(manifest, 'version') !== source.version
      || (cargoString(manifest, 'license') ?? null) !== source.license || (cargoString(manifest, 'license-file') ?? null) !== source.licenseFile
      || (cargoString(manifest, 'repository') ?? null) !== source.repository
      || (vcs ? source.vcs?.member !== prefix + '.cargo_vcs_info.json' || !isDeepStrictEqual(JSON.parse(vcs.toString('utf8')), source.vcs?.value) : source.vcs !== null)) {
      throw new Error('Canvas Cargo original package or VCS declaration changed.');
    }
    const notices = [...members.keys()].filter(member => member === prefix + source.licenseFile
      || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(member)));
    if (!isDeepStrictEqual(source.notices.map(notice => notice.member).toSorted(), notices.toSorted())) throw new Error('Canvas Cargo original notice set is incomplete.');
    for (const notice of source.notices) {
      if (!members.get(notice.member)?.equals(await read(notice))) throw new Error('Canvas Cargo original notice differs from its archive member.');
    }
    if (source.repositoryNotice) {
      const notice = repositoryNotices.get(source.repositoryNotice);
      if (!notice || source.repository !== 'https://github.com/' + notice.repository || source.vcs?.value.git.sha1 !== notice.candidate.commit) {
        throw new Error('Canvas Cargo repository notice differs from its original published VCS base.');
      }
    }
    if (source.name === 'libloading' && source.version === '0.9.0') libloadingManifest = members.get(prefix + 'Cargo.toml').toString('utf8');
  }
  const dependency = libloadingManifest?.split(/^\[target\."cfg\(windows\)"\.dependencies\.windows-link\]\r?$/mu)[1]?.split(/^\[/mu)[0];
  if (cargoString(dependency, 'version') !== '0.2' || !sourceByKey.has('windows-link@0.2.1')) throw new Error('Actual Canvas Windows library dependency source is missing.');
  selected.add('windows-link@0.2.1');
  if (!isDeepStrictEqual([...supplied].toSorted(), [...selected].toSorted())) throw new Error('Actual Canvas Cargo source set is incomplete.');
  for (const source of catalog.repositoryNotices) {
    const commit = JSON.parse(await read(source.commitReceipt)), tree = JSON.parse(await read(source.treeReceipt));
    const api = 'https://api.github.com/repos/' + source.repository;
    if (commit.sha !== source.candidate.commit || commit.tree.sha !== source.candidate.tree || commit.url !== `${api}/git/commits/${source.candidate.commit}`
      || tree.sha !== source.candidate.tree || tree.url !== `${api}/git/trees/${source.candidate.tree}` || tree.truncated) throw new Error('Original Canvas repository notice source identity changed.');
    for (const file of source.files) {
      const bytes = await read(file), blob = JSON.parse(await read(file.blobReceipt)), member = tree.tree.find(member => member.path === file.upstreamPath);
      if (member?.type !== 'blob' || member.sha !== file.gitBlob || gitIdentity('blob', bytes) !== file.gitBlob
        || blob.sha !== file.gitBlob || blob.encoding !== 'base64' || !Buffer.from(blob.content, 'base64').equals(bytes)
        || file.url !== `https://raw.githubusercontent.com/${source.repository}/${source.candidate.commit}/${file.upstreamPath}`) {
        throw new Error('Original Canvas repository notice blob changed.');
      }
    }
  }
  await read(catalog.instructions);
  return { path: path.posix.join(directory, offer.canvasCargoSources.path), limitations: catalog.limitations };
}
