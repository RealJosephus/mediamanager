import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileIdentity, inside, json } from './materials.js';
import { streamSourceArchive } from './source-archive-stream.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const namedNotice = name => /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(name));

export async function windowsNativeBuildInputs(root) {
  const directory = 'tools/release/source-materials', catalogPath = path.posix.join(directory, 'windows-native-aggregate-sources/build-inputs.json');
  const catalog = await json(path.join(root, catalogPath));
  const read = async pin => {
    const filename = path.join(root, directory, pin.path); inside(path.join(root, directory), filename);
    if (!isDeepStrictEqual(await fileIdentity(filename), { bytes: pin.bytes, sha256: pin.sha256 })) throw new Error('Windows native build input is missing or changed: ' + pin.path);
    return await readFile(filename);
  };
  const offer = await json(path.join(root, directory, 'source-offer.json')), recipes = JSON.parse(await read(offer.recipeFragments));
  const producerRecipe = recipes.sources.find(source => source.id === catalog.rootSourceId), sharpRecipe = recipes.sources.find(source => source.id === catalog.sharpRecipeSourceId);
  const sharpPin = sharpRecipe?.files.find(file => file.upstreamPath === catalog.sharpInput), sharp = (await read(sharpPin)).toString('utf8');
  if (catalog.target !== 'x86_64-w64-mingw32.static' || catalog.package !== 'vips-web'
    || !sharp.includes('FILENAME="vips-dev-${ARCH}-web-${VERSION_VIPS}-static.zip"')
    || !sharp.includes('rm bin/libvips-cpp-42.dll') || !sharp.includes('cp bin/*.dll lib/')
    || !isDeepStrictEqual(catalog.toolBoundaries, ['cc', 'meson-wrapper', 'rust'])
    || !isDeepStrictEqual(catalog.plugins, ['plugins/llvm-mingw', 'build', 'build/plugins/mozjpeg', 'build/plugins/zlib-ng', 'build/plugins/web-deps', 'build/plugins/proxy-libintl'])
    || !isDeepStrictEqual(catalog.sources.map(source => source.name).toSorted(), ['build-win64-mxe', 'mxe'])) {
    throw new Error('Windows native build scope differs from the actual Sharp static-dependency input.');
  }
  const captures = new Map();
  for (const source of catalog.sources) {
    if (source.archive.url !== `https://codeload.github.com/${source.repository}/tar.gz/${source.commit}`
      || source.commitReceipt.url !== `https://api.github.com/repos/${source.repository}/commits/${source.reference}`
      || source.treeReceipt.url !== `https://api.github.com/repos/${source.repository}/git/trees/${source.tree}?recursive=1`) {
      throw new Error('Windows native build source differs from its original repository identity.');
    }
    const commit = JSON.parse(await read(source.commitReceipt)), response = JSON.parse(await read(source.treeReceipt));
    if (commit.sha !== source.commit || commit.commit.tree.sha !== source.tree || response.sha !== source.tree || response.truncated !== false) {
      throw new Error('Windows native build original source receipt changed.');
    }
    const tree = response.tree, byPath = new Map(tree.map(member => [member.path, member])), children = new Map();
    if (tree.length !== byPath.size || tree.some(member => member.path.startsWith('/')
      || member.path.split('/').some(part => !part || part === '.' || part === '..')
      || (member.type === 'tree' ? member.mode !== '040000' : member.type !== 'blob' || !['100644', '100755', '120000'].includes(member.mode)))) {
      throw new Error('Windows native build original Git tree is unsupported.');
    }
    for (const member of tree) {
      const parent = path.posix.dirname(member.path);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(member);
    }
    for (const [parent, expected] of [['.', source.tree], ...tree.filter(member => member.type === 'tree').map(member => [member.path, member.sha])]) {
      const name = member => Buffer.from(path.posix.basename(member.path) + (member.type === 'tree' ? '/' : ''));
      const bytes = Buffer.concat((children.get(parent) ?? []).toSorted((a, b) => Buffer.compare(name(a), name(b))).map(member => Buffer.concat([
        Buffer.from(member.mode.replace(/^0+/u, '') + ' ' + path.posix.basename(member.path) + '\0'), Buffer.from(member.sha, 'hex'),
      ])));
      if (gitIdentity('tree', bytes) !== expected) throw new Error('Windows native build original Git tree identity changed.');
    }
    const members = JSON.parse(await read(source.members));
    if (members.length !== tree.length + 1 || !source.root.endsWith('/')) throw new Error('Windows native build complete source membership is incomplete.');
    const seen = new Set();
    for (const member of members) {
      const name = member.path.replace(/\/$/u, '');
      if (seen.has(name)) throw new Error('Windows native build source member is duplicated.');
      seen.add(name);
      if (name === source.root.slice(0, -1)) {
        if (member.kind !== 'directory') throw new Error('Windows native build source root is not an original directory.');
        continue;
      }
      const original = byPath.get(name.slice(source.root.length)), kind = original?.type === 'tree' ? 'directory'
        : original?.mode === '120000' ? 'symlink' : original?.type === 'blob' ? 'file' : undefined;
      if (!name.startsWith(source.root) || !kind || member.kind !== kind
        || kind === 'file' && (member.bytes !== original.size || member.gitBlob !== original.sha || Boolean(member.mode & 0o111) !== (original.mode === '100755'))
        || kind === 'symlink' && (member.gitBlob !== original.sha || gitIdentity('blob', Buffer.from(member.target)) !== original.sha)) {
        throw new Error('Windows native build archive differs from its original Git blob.');
      }
    }
    const notices = members.filter(member => member.kind === 'file' && namedNotice(member.path)).map(member => member.path);
    if (!isDeepStrictEqual(notices.toSorted(), source.notices.map(notice => notice.member).toSorted())) throw new Error('Windows native build original notice set is incomplete.');
    const http = JSON.parse(await read(source.httpReceipt));
    if (http.requestedUrl !== source.archive.url || http.status !== 200 || http.bytes !== source.archive.bytes || http.sha256 !== source.archive.sha256
      || !isDeepStrictEqual(await fileIdentity(path.join(root, directory, source.archive.path)), { bytes: source.archive.bytes, sha256: source.archive.sha256 })) {
      throw new Error('Windows native build original container changed.');
    }
    const selected = source.name === 'build-win64-mxe' ? [
      'build.sh', 'container/base.Dockerfile', 'container/Dockerfile', 'build/vips.mk', 'build/settings/release.mk',
      'build/plugins/mozjpeg/overrides.mk', 'build/plugins/zlib-ng/overrides.mk', 'build/plugins/web-deps/overrides.mk', 'build/plugins/proxy-libintl/overrides.mk',
    ] : ['Makefile'];
    const contents = await streamSourceArchive(path.join(root, directory, source.archive.path), members,
      [...new Set([...selected.map(name => source.root + name), ...source.notices.map(notice => notice.member)])], source.commit);
    for (const notice of source.notices) {
      if (!contents.get(notice.member)?.equals(await read(notice))) throw new Error('Windows native build original notice differs from its complete container.');
    }
    captures.set(source.name, new Map(selected.map(name => [name, contents.get(source.root + name)])));
  }
  const producer = catalog.sources.find(source => source.name === 'build-win64-mxe'), base = catalog.sources.find(source => source.name === 'mxe');
  const original = captures.get('build-win64-mxe'), text = name => original.get(name).toString('utf8');
  if (producer.commit !== producerRecipe.candidate.commit || producer.tree !== producerRecipe.candidate.tree
    || base.repository !== 'kleisauke/mxe' || base.reference !== 'llvm-mingw-20260605'
    || !text('container/base.Dockerfile').includes(`git clone -b ${base.reference} --single-branch https://github.com/${base.repository}.git`)
    || !text('build/vips.mk').includes('--default-library=shared') || !text('build/vips.mk').includes('libvips-42.dll')
    || !text('build.sh').includes('jpeg_impl="mozjpeg"') || !text('build.sh').includes('with_zlib_ng=true')
    || !text('build.sh').includes('plugin_dirs="plugins/llvm-mingw /data"') || !text('build.sh').includes('plugin_dirs+=" /data/plugins/proxy-libintl"')) {
    throw new Error('Windows native build source differs from its actual producer configuration.');
  }
  return { catalog, catalogPath, catalogIdentity: await fileIdentity(path.join(root, catalogPath)), captures,
    sharpInput: { ...sharpPin, sourceId: sharpRecipe.id, gitBlob: gitIdentity('blob', Buffer.from(sharp)) } };
}
