import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { cargoString, json, sourceArchiveMembers } from './materials.js';

export async function rsvgCargoSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const pin = value => {
    const file = entries.get(path.posix.join(directory, value.path));
    if (!file || file.kind || file.bytes !== value.bytes || file.sha256 !== value.sha256) {
      throw new Error('Observed librsvg Cargo material is missing or changed: ' + value.path);
    }
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  pin(offer.rsvgCargoSources); pin(offer.nativeFullSources);
  const catalog = await json(path.join(root, directory, offer.rsvgCargoSources.path));
  pin(catalog.instructions);
  const fullSources = await json(path.join(root, directory, offer.nativeFullSources.path));
  const library = fullSources.sources.find(source => source.name === 'rsvg');
  if (catalog.library.catalog !== offer.nativeFullSources.path || catalog.library.name !== library.name
    || catalog.library.version !== library.version || catalog.library.archive !== library.archive.path
    || catalog.library.lock.member !== library.root + 'Cargo.lock') {
    throw new Error('Observed Cargo sources differ from their original librsvg source.');
  }
  pin(library.members); pin(catalog.library.lock);
  const originalMembers = await json(path.join(root, directory, library.members.path));
  const lockMember = originalMembers.find(member => member.path === catalog.library.lock.member);
  if (lockMember?.kind !== 'file' || lockMember.bytes !== catalog.library.lock.bytes || lockMember.sha256 !== catalog.library.lock.sha256) {
    throw new Error('Observed Cargo source lock differs from its original archive member.');
  }
  const lock = await readFile(path.join(root, directory, catalog.library.lock.path), 'utf8');
  const packages = new Map(lock.split(/^\[\[package\]\]\r?$/mu).slice(1)
    .map(block => [cargoString(block, 'name') + '@' + cargoString(block, 'version'), block]));
  const selected = new Set(), platforms = new Set();
  for (const observation of catalog.observations) {
    if (!['linux', 'macos'].includes(observation.platform) || platforms.has(observation.platform)) {
      throw new Error('Observed librsvg Cargo platform is missing or duplicated.');
    }
    platforms.add(observation.platform);
    const source = offer.sources.find(source => source.jobId === observation.jobId);
    if (source?.repository !== 'lovell/sharp-libvips' || source.archive.path !== `libvips-${observation.platform}-original.log.gz`) {
      throw new Error('Observed librsvg Cargo region differs from its original producer job.');
    }
    pin(source.archive);
    const raw = gunzipSync(await readFile(path.join(root, directory, source.archive.path)), { maxOutputLength: source.rawLog.bytes + 1 });
    if (raw.length !== source.rawLog.bytes || createHash('sha256').update(raw).digest('hex') !== source.rawLog.sha256) {
      throw new Error('Observed librsvg Cargo producer log changed.');
    }
    const lines = raw.toString('utf8').split(/\r?\n/u), project = lines.findIndex(line => line.includes('Project name: librsvg'));
    const start = lines.findIndex((line, index) => index > project && line.includes('[0/2] Generating rsvg/librsvg-2'));
    const end = lines.findIndex((line, index) => index > start && line.includes('Finished `release`'));
    if (project < 0 || start < 0 || end < 0 || observation.start.line !== start + 1 || observation.start.text !== lines[start]
      || observation.end.line !== end + 1 || observation.end.text !== lines[end]) {
      throw new Error('Observed librsvg Cargo compilation boundaries changed.');
    }
    const compiles = [];
    for (let index = start; index <= end; index += 1) {
      const match = /Compiling ([A-Za-z0-9_-]+) v([0-9][^\s]*)/u.exec(lines[index]);
      if (!match) continue;
      compiles.push({ line: index + 1, text: lines[index], name: match[1], version: match[2] });
      const key = match[1] + '@' + match[2], block = packages.get(key);
      if (!block) throw new Error('Observed Cargo version is absent from the pristine librsvg lock: ' + key);
      if (cargoString(block, 'source')) selected.add(key);
    }
    if (!isDeepStrictEqual(compiles, observation.compiles) || compiles.length === 0) {
      throw new Error('Observed librsvg Cargo compile rows changed.');
    }
  }
  if (platforms.size !== 2 || catalog.crates.length !== selected.size) throw new Error('Observed librsvg Cargo source set is incomplete.');
  const supplied = new Set();
  for (const source of catalog.crates) {
    const key = source.name + '@' + source.version, block = packages.get(key);
    if (!selected.has(key) || supplied.has(key) || source.source !== cargoString(block, 'source')
      || source.source !== 'registry+https://github.com/rust-lang/crates.io-index'
      || source.archive.url !== `https://static.crates.io/crates/${source.name}/${source.name}-${source.version}.crate`) {
      throw new Error('Supplied Cargo source differs from the actual librsvg compile selection: ' + key);
    }
    supplied.add(key); pin(source.archive);
    const archive = await readFile(path.join(root, directory, source.archive.path));
    if (createHash('sha256').update(archive).digest('hex') !== cargoString(block, 'checksum')) {
      throw new Error('Observed Cargo archive differs from the pristine librsvg lock checksum: ' + key);
    }
    const members = sourceArchiveMembers(archive, source.members), prefix = source.name + '-' + source.version + '/';
    const manifest = members.get(prefix + 'Cargo.toml')?.toString('utf8').split(/^\[package\]\r?$/mu)[1]?.split(/^\[/mu)[0];
    const vcsMember = prefix + '.cargo_vcs_info.json', vcsBytes = members.get(vcsMember);
    if (cargoString(manifest, 'name') !== source.name || cargoString(manifest, 'version') !== source.version
      || (cargoString(manifest, 'license') ?? null) !== source.license || (cargoString(manifest, 'license-file') ?? null) !== source.licenseFile
      || (vcsBytes ? source.vcs?.member !== vcsMember || !isDeepStrictEqual(JSON.parse(vcsBytes.toString('utf8')), source.vcs?.value) : source.vcs !== null)) {
      throw new Error('Observed Cargo package or original VCS declaration changed: ' + key);
    }
    const namedNotices = [...members.keys()].filter(name => name === prefix + source.licenseFile
      || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(name)));
    if (!isDeepStrictEqual(source.notices.map(notice => notice.member).toSorted(), namedNotices.toSorted())) {
      throw new Error('Observed Cargo original notice set is incomplete: ' + key);
    }
    for (const notice of source.notices) {
      pin(notice);
      if (!members.get(notice.member)?.equals(await readFile(path.join(root, directory, notice.path)))) {
        throw new Error('Observed Cargo original notice differs from its archive member: ' + notice.member);
      }
    }
  }
  return { path: path.posix.join(directory, offer.rsvgCargoSources.path), limitations: catalog.limitations };
}
