import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { json } from './materials.js';
import { streamSourceArchive } from './source-archive-stream.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const namedNotice = name => /(?:^|\/)LICENSES\//iu.test(name)
  || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(name));

export async function skiaSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) {
      throw new Error('Skia source material is missing or changed: ' + pin.path);
    }
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.skiaSources)), native = JSON.parse(await read(offer.nativePackages));
  const source = catalog.source, declared = native.relatedSources.find(source => source.id === catalog.canvas.gitlink);
  if (catalog.canvas.catalog !== offer.nativePackages.path || catalog.canvas.repository !== native.canvas.repository
    || catalog.canvas.commit !== native.canvas.candidate.commit || declared?.repository !== source.repository
    || !isDeepStrictEqual(declared?.candidate, source.candidate)
    || native.canvas.gitlinks.find(link => link.path === catalog.canvas.gitlink)?.commit !== source.candidate.commit) {
    throw new Error('Skia source differs from the actual Canvas Git source and declared gitlink.');
  }
  const commit = JSON.parse(await read(declared.commitReceipt));
  const api = 'https://api.github.com/repos/' + source.repository;
  if (commit.sha !== source.candidate.commit || commit.tree.sha !== source.candidate.tree
    || commit.url !== `${api}/git/commits/${source.candidate.commit}` || source.tree.url !== `${api}/git/trees/${source.candidate.tree}?recursive=1`
    || source.root !== 'skia-' + source.candidate.commit + '/'
    || source.archive.url !== `https://codeload.github.com/${source.repository}/tar.gz/${source.candidate.commit}`) {
    throw new Error('Complete Skia source differs from its original Git repository.');
  }
  const tree = JSON.parse(await read(source.tree)), byPath = new Map(tree.tree.map(member => [member.path, member]));
  if (tree.truncated || tree.sha !== source.candidate.tree || tree.url !== `${api}/git/trees/${source.candidate.tree}`
    || byPath.size !== tree.tree.length || tree.tree.some(member => member.path.startsWith('/')
      || member.path.split('/').some(part => !part || part === '.' || part === '..')
      || (member.type === 'tree' ? member.mode !== '040000' : member.type !== 'blob' || !['100644', '100755', '120000'].includes(member.mode)))) {
    throw new Error('Original Skia recursive Git tree is incomplete or unsupported.');
  }
  const children = new Map();
  for (const member of tree.tree) {
    const parent = path.posix.dirname(member.path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(member);
  }
  for (const [prefix, expected] of [['.', source.candidate.tree], ...tree.tree.filter(member => member.type === 'tree').map(member => [member.path, member.sha])]) {
    const name = member => Buffer.from(path.posix.basename(member.path) + (member.type === 'tree' ? '/' : ''));
    const bytes = Buffer.concat((children.get(prefix) ?? []).toSorted((a, b) => Buffer.compare(name(a), name(b))).map(member => Buffer.concat([
      Buffer.from(member.mode.replace(/^0+/u, '') + ' ' + path.posix.basename(member.path) + '\0'), Buffer.from(member.sha, 'hex'),
    ])));
    if (gitIdentity('tree', bytes) !== expected) throw new Error('Original Skia recursive Git tree identity changed.');
  }
  const members = JSON.parse(await read(source.members)), supplied = new Set();
  if (members.length !== tree.tree.length + 1) throw new Error('Complete Skia source archive membership is incomplete.');
  for (const member of members) {
    if (supplied.has(member.path)) throw new Error('Complete Skia source archive member is duplicated.');
    supplied.add(member.path);
    if (member.path === source.root.slice(0, -1) && member.kind === 'directory') continue;
    const original = byPath.get(member.path.slice(source.root.length));
    const kind = original?.type === 'tree' ? 'directory' : original?.mode === '120000' ? 'symlink' : original?.type === 'blob' ? 'file' : undefined;
    // Git tracks executability; the archive reader checks the complete original TAR permissions.
    if (!member.path.startsWith(source.root) || !kind || member.kind !== kind
      || kind === 'file' && (member.bytes !== original.size || member.gitBlob !== original.sha || Boolean(member.mode & 0o111) !== (original.mode === '100755'))
      || kind === 'symlink' && (member.bytes !== 0 || member.gitBlob !== original.sha || gitIdentity('blob', Buffer.from(member.target)) !== original.sha)) {
      throw new Error('Skia source archive member differs from its original Git tree: ' + member.path);
    }
  }
  const notices = members.filter(member => member.kind === 'file' && namedNotice(member.path)).map(member => member.path);
  if (!isDeepStrictEqual(catalog.source.notices.map(notice => notice.member).toSorted(), notices.toSorted())) {
    throw new Error('Complete Skia original notice set is incomplete.');
  }
  await read(catalog.instructions);
  // The regular reader retains only the explicitly supplied small notices/build sources.
  const selected = [...new Set([...source.notices, ...source.buildFiles].map(file => file.member))];
  const archiveFile = entries.get(path.posix.join(directory, source.archive.path));
  if (!archiveFile || archiveFile.kind || archiveFile.bytes !== source.archive.bytes || archiveFile.sha256 !== source.archive.sha256) {
    throw new Error('Complete original Skia source archive is missing or changed.');
  }
  const originals = await streamSourceArchive(path.join(root, directory, source.archive.path), members, selected, source.candidate.commit);
  for (const file of [...source.notices, ...source.buildFiles]) {
    if (!originals.get(file.member)?.equals(await read(file))) throw new Error('Separately supplied Skia source differs from its original archive member: ' + file.member);
  }
  return { path: path.posix.join(directory, offer.skiaSources.path), limitations: catalog.limitations };
}
