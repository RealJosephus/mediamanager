import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { json } from './materials.js';
import { streamSourceArchive } from './source-archive-stream.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const namedNotice = name => /(?:^|\/)LICENSES\//iu.test(name)
  || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(name));

export async function skiaDependencySourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) {
      throw new Error('Skia dependency source material is missing or changed: ' + pin.path);
    }
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.skiaDependencySources));
  if (catalog.skiaCatalog !== offer.skiaSources.path || catalog.canvasCatalog !== offer.nativePackages.path
    || !isDeepStrictEqual(catalog.targets.toSorted(), ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'])) {
    throw new Error('Skia dependency source profile differs from the declared distribution targets.');
  }
  const skia = JSON.parse(await read(offer.skiaSources)), native = JSON.parse(await read(offer.nativePackages));
  const build = (await read(native.canvas.files.find(file => file.upstreamPath === 'scripts/build-skia.js'))).toString('utf8');
  const original = async name => (await read(skia.source.buildFiles.find(file => file.member === skia.source.root + name))).toString('utf8');
  const deps = await original('DEPS'), defaults = await original('gn/skia.gni');
  const selected = new Set();
  const select = (name, flags) => {
    if (flags.some(flag => !build.includes('`' + flag + '`'))) throw new Error('Skia dependency source differs from its actual Canvas GN selection: ' + name);
    selected.add(name);
  };
  select('expat', ['skia_use_expat=true', 'skia_use_system_expat=false']);
  select('freetype', ['skia_use_freetype=true', 'skia_use_system_freetype2=false']);
  select('harfbuzz', ['skia_use_harfbuzz=true', 'skia_use_system_harfbuzz=false']);
  select('icu', ['skia_use_icu=true', 'skia_use_system_icu=false']);
  select('libjpeg-turbo', ['skia_use_libjpeg_turbo_decode=true', 'skia_use_system_libjpeg_turbo=false']);
  select('libwebp', ['skia_use_libwebp_decode=true', 'skia_use_system_libwebp=false']);
  select('wuffs', ['skia_use_wuffs=true']);
  if (!defaults.includes('skia_use_libpng_decode = true') || !defaults.includes('skia_use_libpng_encode = true')
    || !defaults.includes('skia_use_zlib = true')) throw new Error('Skia codec dependency defaults changed.');
  select('libpng', ['skia_use_system_libpng=false']); select('zlib', ['skia_use_system_zlib=false']);
  if (!build.includes('`skia_use_libjxl_decode=${!TARGET_TRIPLE.startsWith(\'riscv64\')}`')) {
    throw new Error('Skia JPEG XL dependency selection changed.');
  }
  selected.add('libjxl');
  const jxl = await original('third_party/libjxl/BUILD.gn'), freetype = await original('third_party/freetype2/BUILD.gn');
  if (!jxl.includes('"//third_party/brotli"') || !jxl.includes('"//third_party/highway"')
    || !freetype.includes('"//third_party/brotli"') || !build.includes('`skia_use_freetype_woff2=true`')) {
    throw new Error('Skia transitive codec dependency selection changed.');
  }
  selected.add('brotli'); selected.add('highway');
  if (!isDeepStrictEqual(catalog.components.map(source => source.name).toSorted(), [...selected].toSorted())) {
    throw new Error('Selected Skia dependency source set is incomplete.');
  }
  const checked = [];
  for (const source of catalog.components) {
    if (source.externalPath !== 'third_party/externals/' + source.name
      || !deps.includes('"' + source.externalPath + '"') || !deps.includes('"' + source.repository + '@' + source.candidate.commit + '"')
      || source.archive.url !== source.repository + '/+archive/' + source.candidate.commit + '.tar.gz') {
      throw new Error('Skia dependency source differs from its original DEPS repository or revision: ' + source.name);
    }
    const commit = await read(source.commitObject);
    if (gitIdentity('commit', commit) !== source.candidate.commit || !commit.toString('utf8').startsWith('tree ' + source.candidate.tree + '\n')) {
      throw new Error('Skia dependency original Git commit changed: ' + source.name);
    }
    const tree = JSON.parse(await read(source.tree)), byPath = new Map(tree.map(member => [member.path, member])), children = new Map();
    if (byPath.size !== tree.length || tree.some(member => member.path.startsWith('/')
      || member.path.split('/').some(part => !part || part === '.' || part === '..')
      || (member.type === 'tree' ? member.mode !== '040000' : member.type === 'commit' ? member.mode !== '160000'
        : member.type !== 'blob' || !['100644', '100755', '120000'].includes(member.mode)))) {
      throw new Error('Skia dependency original Git tree is incomplete or unsupported.');
    }
    for (const member of tree) {
      const parent = path.posix.dirname(member.path);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(member);
    }
    for (const [prefix, expected] of [['.', source.candidate.tree], ...tree.filter(member => member.type === 'tree').map(member => [member.path, member.sha])]) {
      const name = member => Buffer.from(path.posix.basename(member.path) + (member.type === 'tree' ? '/' : ''));
      const bytes = Buffer.concat((children.get(prefix) ?? []).toSorted((a, b) => Buffer.compare(name(a), name(b))).map(member => Buffer.concat([
        Buffer.from(member.mode.replace(/^0+/u, '') + ' ' + path.posix.basename(member.path) + '\0'), Buffer.from(member.sha, 'hex'),
      ])));
      if (gitIdentity('tree', bytes) !== expected) throw new Error('Skia dependency original Git tree identity changed: ' + source.name);
    }
    if (!isDeepStrictEqual(source.gitlinks, tree.filter(member => member.type === 'commit'))) throw new Error('Skia dependency original nested gitlinks changed.');
    const members = JSON.parse(await read(source.members)), supplied = new Set();
    if (members.length !== tree.length) throw new Error('Complete Skia dependency archive membership is incomplete.');
    for (const member of members) {
      if (supplied.has(member.path)) throw new Error('Complete Skia dependency source member is duplicated.');
      supplied.add(member.path);
      const original = byPath.get(member.path), kind = ['tree', 'commit'].includes(original?.type) ? 'directory'
        : original?.mode === '120000' ? 'symlink' : original?.type === 'blob' ? 'file' : undefined;
      if (!kind || member.kind !== kind
        || kind === 'file' && (member.bytes !== original.bytes || member.gitBlob !== original.sha || Boolean(member.mode & 0o111) !== (original.mode === '100755'))
        || kind === 'symlink' && (member.bytes !== 0 || member.gitBlob !== original.sha || gitIdentity('blob', Buffer.from(member.target)) !== original.sha)
        || original.type === 'commit' && member.gitlink !== original.sha) {
        throw new Error('Skia dependency archive member differs from its original Git tree: ' + source.name + '/' + member.path);
      }
    }
    const notices = members.filter(member => member.kind === 'file' && namedNotice(member.path)).map(member => member.path);
    if (!isDeepStrictEqual(source.notices.map(notice => notice.member).toSorted(), notices.toSorted())) {
      throw new Error('Skia dependency original notice set is incomplete: ' + source.name);
    }
    checked.push({ source, members });
  }
  await read(catalog.instructions);
  for (const { source, members } of checked) {
    const archive = entries.get(path.posix.join(directory, source.archive.path));
    if (!archive || archive.kind || archive.bytes !== source.archive.bytes || archive.sha256 !== source.archive.sha256) {
      throw new Error('Complete original Skia dependency source archive is missing or changed.');
    }
    const originals = await streamSourceArchive(path.join(root, directory, source.archive.path), members,
      source.notices.map(file => file.member), source.candidate.commit);
    for (const file of source.notices) {
      if (!originals.get(file.member)?.equals(await read(file))) throw new Error('Separately supplied Skia dependency notice differs from its original archive member.');
    }
  }
  return { path: path.posix.join(directory, offer.skiaDependencySources.path), limitations: catalog.limitations };
}
