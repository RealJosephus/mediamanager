import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cargoString, json, sourceArchiveMembers } from './materials.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const noticeName = name => /^(?:licen[cs]e|copying|notices?|copyright)(?:[._-]|$)/iu.test(path.posix.basename(name));
const mplHeader = Buffer.from('/* This Source Code Form is subject to the terms of the Mozilla Public\n');

function originalTree(response, root) {
  if (response.sha !== root || response.truncated) throw new Error('Original Rust notice Git tree is incomplete.');
  const entries = new Map(), children = new Map([['', []]]);
  for (const entry of response.tree) {
    if (typeof entry.path !== 'string' || entry.path.includes('\0') || entry.path.includes('\\') || path.posix.isAbsolute(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..') || entries.has(entry.path)) {
      throw new Error('Original Rust notice Git tree member changed.');
    }
    entries.set(entry.path, entry);
    const parent = path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path);
    if (!children.has(parent)) children.set(parent, []); children.get(parent).push(entry);
    if (entry.type === 'tree' && !children.has(entry.path)) children.set(entry.path, []);
  }
  const calculate = prefix => {
    const records = (children.get(prefix) ?? []).toSorted((left, right) => Buffer.compare(
      Buffer.from(path.posix.basename(left.path) + (left.type === 'tree' ? '/' : '')),
      Buffer.from(path.posix.basename(right.path) + (right.type === 'tree' ? '/' : ''))));
    const bytes = Buffer.concat(records.map(entry => {
      if (!/^[0-9a-f]{40}$/u.test(entry.sha) || !['040000', '100644', '100755', '120000', '160000'].includes(entry.mode)
        || (entry.type === 'tree' ? entry.mode !== '040000' || calculate(entry.path) !== entry.sha
          : entry.type === 'commit' ? entry.mode !== '160000' : entry.type !== 'blob' || ['040000', '160000'].includes(entry.mode))) {
        throw new Error('Original Rust notice Git subtree identity changed.');
      }
      return Buffer.concat([Buffer.from(`${entry.mode.replace(/^0/u, '')} ${path.posix.basename(entry.path)}\0`), Buffer.from(entry.sha, 'hex')]);
    }));
    return gitIdentity('tree', bytes);
  };
  for (const prefix of children.keys()) if (prefix && entries.get(prefix)?.type !== 'tree') throw new Error('Original Rust notice Git parent is absent.');
  if (calculate('') !== root) throw new Error('Original Rust notice complete Git tree identity changed.');
  return entries;
}

export async function rsvgOriginalNoticeMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) throw new Error('Original Rust notice material is missing or changed: ' + pin.path);
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.rsvgOriginalNotices)), sources = JSON.parse(await read(offer.rsvgCargoSources));
  const native = JSON.parse(await read(offer.nativePackages));
  if (catalog.sourceCatalog !== offer.rsvgCargoSources.path) throw new Error('Rust notice source differs from its selected original container group.');
  const selected = new Map(sources.crates.filter(source => source.notices.length === 0).map(source => [source.name + '@' + source.version, source]));
  const supplied = new Set();
  for (const source of catalog.sources) {
    const key = source.name + '@' + source.version, original = selected.get(key);
    if (!original || supplied.has(key) || ['path', 'bytes', 'sha256', 'url'].some(field => original.archive[field] !== source.archive[field])) {
      throw new Error('Rust notice differs from its actual selected published source.');
    }
    supplied.add(key);
    const archive = await read(source.archive), members = sourceArchiveMembers(archive, original.members), prefix = source.name + '-' + source.version + '/';
    const manifest = members.get(prefix + 'Cargo.toml').toString('utf8').split(/^\[package\]\r?$/mu)[1]?.split(/^\[/mu)[0];
    const repository = cargoString(manifest, 'repository');
    if (cargoString(manifest, 'name') !== source.name || cargoString(manifest, 'version') !== source.version
      || !['http://github.com/' + source.repository, 'https://github.com/' + source.repository].includes(repository)) {
      throw new Error('Rust notice repository differs from its original package declaration.');
    }
    const commit = JSON.parse(await read(source.commitReceipt)), tree = JSON.parse(await read(source.treeReceipt));
    const api = 'https://api.github.com/repos/' + source.repository;
    if (commit.sha !== source.candidate.commit || commit.tree.sha !== source.candidate.tree
      || commit.url !== `${api}/git/commits/${source.candidate.commit}` || source.commitReceipt.url !== commit.url
      || source.treeReceipt.url !== `${api}/git/trees/${source.candidate.tree}?recursive=1`
      || tree.url !== `${api}/git/trees/${source.candidate.tree}`) throw new Error('Original Rust notice commit association changed.');
    const git = originalTree(tree, source.candidate.tree);
    let vcsPath = '';
    const vcsBytes = members.get(prefix + '.cargo_vcs_info.json');
    if (source.association === 'original-published-vcs-base') {
      const vcs = vcsBytes && JSON.parse(vcsBytes.toString('utf8'));
      if (vcs?.git.sha1 !== source.candidate.commit) throw new Error('Original Rust notice differs from the actual published VCS base.');
      vcsPath = vcs.path_in_vcs;
    } else if (source.association === 'original-version-tag-and-published-member-blobs') {
      const ref = JSON.parse(await read(source.refReceipt));
      if (vcsBytes || source.versionRef !== source.version || ref.ref !== 'refs/tags/' + source.versionRef
        || ref.object.type !== 'commit' || ref.object.sha !== source.candidate.commit
        || source.refReceipt.url !== `${api}/git/ref/tags/${source.versionRef}`) throw new Error('Original Rust source version tag association changed.');
    } else throw new Error('Unknown original Rust notice source association.');
    const expectedMembers = [...members.keys()].filter(member => !['.cargo_vcs_info.json', 'Cargo.lock'].includes(member.slice(prefix.length))
      && !(member === prefix + 'Cargo.toml' && members.has(prefix + 'Cargo.toml.orig')));
    const actualMembers = [...source.publishedMembers, ...source.sourceVariations].map(file => file.member);
    if (!isDeepStrictEqual(expectedMembers.toSorted(), actualMembers.toSorted())) throw new Error('Original Rust source member associations are incomplete.');
    const sourcePath = member => (vcsPath ? vcsPath + '/' : '') + (member === prefix + 'Cargo.toml.orig' ? 'Cargo.toml' : member.slice(prefix.length));
    for (const file of source.publishedMembers) {
      const bytes = members.get(file.member);
      if (!bytes || file.upstreamPath !== sourcePath(file.member) || git.get(file.upstreamPath)?.sha !== file.gitBlob
        || gitIdentity('blob', bytes) !== file.gitBlob || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error('Original Rust source member differs from its version/VCS Git blob.');
      }
    }
    for (const file of source.sourceVariations) {
      const bytes = members.get(file.member), originalBytes = await read(file.original), blob = JSON.parse(await read(file.original.blobReceipt));
      if (!bytes || bytes.length !== file.published.bytes || sha256(bytes) !== file.published.sha256 || bytes.equals(originalBytes)
        || file.upstreamPath !== sourcePath(file.member) || git.get(file.upstreamPath)?.sha !== file.original.gitBlob
        || gitIdentity('blob', originalBytes) !== file.original.gitBlob || blob.sha !== file.original.gitBlob || blob.encoding !== 'base64'
        || !Buffer.from(blob.content, 'base64').equals(originalBytes)) throw new Error('Original Rust source variation bytes changed.');
    }
    const scoped = [...git.values()].filter(entry => entry.type === 'blob' && (!vcsPath || entry.path.startsWith(vcsPath + '/')));
    if (source.packageTreeHasNoNamedNotice !== !scoped.some(entry => noticeName(entry.path))) throw new Error('Original Rust named-notice availability differs from its exact source tree.');
    if (source.name === 'mutants') {
      if (cargoString(manifest, 'license') !== 'MIT' || source.notices.length !== 1) throw new Error('Original mutants notice set is incomplete.');
      const file = source.notices[0], bytes = await read(file), blob = JSON.parse(await read(file.blobReceipt));
      if (file.kind !== 'original-repository-root-notice' || file.upstreamPath !== 'LICENSE' || git.get('LICENSE')?.sha !== file.gitBlob
        || gitIdentity('blob', bytes) !== file.gitBlob || blob.sha !== file.gitBlob || blob.encoding !== 'base64'
        || !Buffer.from(blob.content, 'base64').equals(bytes) || file.url !== `https://raw.githubusercontent.com/${source.repository}/${source.candidate.commit}/LICENSE`) {
        throw new Error('Original mutants root MIT notice changed.');
      }
    } else if (source.name === 'selectors') {
      const headers = [...members].filter(([member, bytes]) => member.endsWith('.rs') && bytes.subarray(0, mplHeader.length).equals(mplHeader));
      if (cargoString(manifest, 'license') !== 'MPL-2.0'
        || !isDeepStrictEqual(source.notices.map(file => file.member).toSorted(), headers.map(([member]) => member).toSorted())) {
        throw new Error('Original selectors MPL source-header notice set is incomplete.');
      }
      for (const file of source.notices) if (file.kind !== 'original-source-with-mpl-header' || !members.get(file.member)?.equals(await read(file))) {
        throw new Error('Original selectors MPL source-header bytes changed.');
      }
    } else if (cargoString(manifest, 'license') !== 'MIT' || source.notices.length || !source.packageTreeHasNoNamedNotice) {
      throw new Error('Original legacy Rust notice availability changed.');
    }
  }
  if (!isDeepStrictEqual([...supplied].toSorted(), [...selected.keys()].toSorted())) throw new Error('Original Rust notice/declaration source group is incomplete.');
  const terms = native.sharpNativeNotices.cairo.publisherLicenseText;
  if (catalog.sourceHeaderTerms.sourceCatalog !== offer.nativePackages.path || ['path', 'bytes', 'sha256', 'url', 'license'].some(key => catalog.sourceHeaderTerms[key] !== terms[key])
    || terms.license !== 'MPL-2.0' || terms.url !== 'https://www.mozilla.org/media/MPL/2.0/index.f75d2927d3c1.txt') throw new Error('Original selectors source-header terms association changed.');
  await read(terms); await read(catalog.instructions);
  return { path: path.posix.join(directory, offer.rsvgOriginalNotices.path), limitations: catalog.limitations };
}
