import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { json, sourceArchiveMembers } from './materials.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

export async function nativeFallbackSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const read = async pin => {
    const file = entries.get(path.posix.join(directory, pin.path));
    if (!file || file.kind || file.bytes !== pin.bytes || file.sha256 !== pin.sha256) {
      throw new Error('Native fallback material is missing or changed: ' + pin.path);
    }
    return await readFile(path.join(root, directory, pin.path));
  };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.nativeFullSources)), selected = new Set();
  const recipes = JSON.parse(await read(offer.recipeFragments));
  const recipe = recipes.sources.find(source => source.id === catalog.recipe.sourceId);
  const buildFile = recipe.files.find(file => file.upstreamPath === catalog.recipe.buildFile);
  const build = (await read(buildFile)).toString('utf8');
  for (const match of build.matchAll(/--force-fallback-for=([A-Za-z0-9_,+-]+)/gu)) {
    const library = [...build.slice(0, match.index).matchAll(/^cd \$\{DEPS\}\/([A-Za-z0-9_-]+)\r?$/gmu)].at(-1)?.[1];
    if (!catalog.sources.some(source => source.name === library)) throw new Error('Selected native fallback library source is missing.');
    for (const name of match[1].split(',')) selected.add(library + '/' + name);
  }
  if (!Array.isArray(catalog.fallbacks) || catalog.fallbacks.length !== selected.size) throw new Error('Selected native fallback source set is incomplete.');
  const supplied = new Set();
  for (const source of catalog.fallbacks) {
    const key = source.library + '/' + source.name;
    if (!selected.has(key) || supplied.has(key)) throw new Error('Native fallback differs from its actual recipe selection: ' + key);
    supplied.add(key);
    const library = catalog.sources.find(library => library.name === source.library);
    const libraryMembers = JSON.parse(await read(library.members)), wrap = await read(source.wrap);
    const original = libraryMembers.find(member => member.path === library.root + 'subprojects/' + source.name + '.wrap');
    if (original?.kind !== 'file' || original.path !== source.wrap.member || original.bytes !== wrap.length
      || original.sha256 !== createHash('sha256').update(wrap).digest('hex')) {
      throw new Error('Native fallback wrap differs from its original library archive.');
    }
    const fields = new Map(wrap.toString('utf8').split(/\r?\n/u).map(line => {
      const equals = line.indexOf('='); return equals < 0 ? [] : [line.slice(0, equals).trim(), line.slice(equals + 1).trim()];
    }).filter(field => field.length));
    if (!wrap.toString('utf8').startsWith('[wrap-git]\n') || fields.get('url') !== source.repository + '.git'
      || fields.get('directory') !== source.name || fields.get('revision') !== source.candidate.commit
      || !/^[a-f0-9]{40}$/u.test(source.candidate.commit)) {
      throw new Error('Native fallback source differs from its original pinned revision.');
    }
    const api = new URL(source.repository).origin + '/api/v4/projects/'
      + encodeURIComponent(new URL(source.repository).pathname.slice(1));
    const commit = await read(source.commitObject), receipt = JSON.parse(await read(source.commitReceipt));
    if (gitIdentity('commit', commit) !== source.candidate.commit
      || !commit.toString('utf8').startsWith('tree ' + source.candidate.tree + '\n')
      || receipt.id !== source.candidate.commit || receipt.web_url !== `${source.repository}/-/commit/${source.candidate.commit}`
      || source.commitReceipt.url !== `${api}/repository/commits/${source.candidate.commit}`
      || source.treeReceipt.url !== `${api}/repository/tree?ref=${source.candidate.commit}&recursive=true&per_page=100`) {
      throw new Error('Native fallback original Git source identity changed.');
    }
    const tree = JSON.parse(await read(source.treeReceipt)), byPath = new Map(tree.map(member => [member.path, member]));
    if (byPath.size !== tree.length || tree.some(member => member.name !== path.posix.basename(member.path)
      || member.path.startsWith('/') || member.path.split('/').some(part => !part || part === '.' || part === '..')
      || (member.type === 'tree' ? member.mode !== '040000' : member.type !== 'blob' || !['100644', '100755'].includes(member.mode)))) {
      throw new Error('Native fallback original Git tree is unsupported.');
    }
    for (const [prefix, expected] of [['', source.candidate.tree], ...tree.filter(member => member.type === 'tree').map(member => [member.path, member.id])]) {
      const children = tree.filter(member => path.posix.dirname(member.path) === (prefix || '.'));
      const name = member => Buffer.from(member.name + (member.type === 'tree' ? '/' : ''));
      const bytes = Buffer.concat(children.toSorted((a, b) => Buffer.compare(name(a), name(b))).map(member => Buffer.concat([
        Buffer.from(member.mode.replace(/^0+/u, '') + ' ' + member.name + '\0'), Buffer.from(member.id, 'hex'),
      ])));
      if (gitIdentity('tree', bytes) !== expected) throw new Error('Native fallback original Git tree identity changed.');
    }
    if (source.root !== source.name + '-' + source.candidate.commit + '/'
      || source.archive.url !== `${source.repository}/-/archive/${source.candidate.commit}/${source.name}-${source.candidate.commit}.tar.gz`) {
      throw new Error('Native fallback archive differs from its original repository.');
    }
    const members = sourceArchiveMembers(await read(source.archive), JSON.parse(await read(source.members)));
    if (members.size !== tree.filter(member => member.type === 'blob').length) throw new Error('Complete native fallback source is incomplete.');
    for (const [member, bytes] of members) {
      const original = byPath.get(member.slice(source.root.length));
      if (!member.startsWith(source.root) || original?.type !== 'blob' || gitIdentity('blob', bytes) !== original.id) {
        throw new Error('Native fallback archive differs from its original Git blob: ' + member);
      }
    }
    const namedNotices = [...members.keys()].filter(member => /(?:^|\/)LICENSES\//iu.test(member)
      || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(member)));
    if (!isDeepStrictEqual(source.notices.map(notice => notice.member).toSorted(), namedNotices.toSorted())) {
      throw new Error('Native fallback original notice set is incomplete.');
    }
    for (const notice of source.notices) {
      if (!members.get(notice.member)?.equals(await read(notice))) throw new Error('Native fallback original notice differs from its archive member.');
    }
  }
}
