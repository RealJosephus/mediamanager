import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { json, removeOwned, tree } from './materials.js';
import { windowsNativeBuildInputs } from './windows-native-build-inputs.js';
import { readWindowsNativeGraph } from './windows-native-graph.js';
import { readNativeSourceArchive } from './native-source-archive.js';

const namedNotice = name => /(?:^|\/)LICENSES\//iu.test(name)
  || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(name))
  || ['ftl.txt', 'gplv2.txt', 'readme.ijg'].includes(path.posix.basename(name).toLowerCase());
const sameSet = (a, b) => isDeepStrictEqual([...a].toSorted(), [...b].toSorted());

export async function readWindowsNativeAggregateSources(root, files) {
  const directory = 'tools/release/source-materials';
  files ??= await tree(root, directory);
  const entries = new Map(files.map(file => [file.path, file]));
  const pin = source => {
    const file = source && entries.get(path.posix.join(directory, source.path));
    if (!file || file.kind || file.bytes !== source.bytes || file.sha256 !== source.sha256) throw new Error('Windows native aggregate source is missing or changed: ' + source?.path);
  };
  const read = async source => { pin(source); return await readFile(path.join(root, directory, source.path)); };
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const catalog = JSON.parse(await read(offer.windowsNativeAggregateSources));
  const inputs = await windowsNativeBuildInputs(root);
  if (catalog.buildInputs.path !== 'windows-native-aggregate-sources/build-inputs.json') throw new Error('Windows native aggregate build input profile changed.');
  await read(catalog.buildInputs);
  const graph = await readWindowsNativeGraph(root, catalog, read, inputs);
  const required = graph.required;
  if (!required.size || catalog.sources.length !== required.size || new Set(catalog.sources.map(source => source.file + ':' + source.sha256)).size !== required.size) {
    throw new Error('Actual selected Windows native source container set is incomplete.');
  }
  const full = JSON.parse(await read(offer.nativeFullSources)), posix = JSON.parse(await read(offer.nativeAggregateSources)), native = JSON.parse(await read(offer.nativePackages));
  const versionPin = native.sharpNativeNotices.platforms.find(platform => platform.platform === 'win32' && platform.architecture === 'x64')?.versions;
  if (!versionPin || !isDeepStrictEqual(JSON.parse(await read(versionPin)), graph.receipt.windowsVersions.values)) throw new Error('Windows native source graph differs from the current constituent version declarations.');
  const old = new Map([[offer.nativeFullSources.path, full.sources], [offer.nativeAggregateSources.path, posix.components], [offer.nativePackages.path, native.sharpNativeNotices.components]]);
  const checked = [];
  for (const source of catalog.sources) {
    const chosen = required.get(source.file + ':' + source.sha256);
    if (!chosen || !isDeepStrictEqual(source.packages, chosen.packages) || source.archive.sha256 !== chosen.sha256) throw new Error('Windows native source differs from its actual selected container.');
    pin(source.archive);
    if (source.origin) {
      const previous = old.get(source.origin.catalog)?.find(previous => previous.name === source.origin.name);
      if (!previous?.archive || ['path', 'bytes', 'sha256'].some(field => previous.archive[field] !== source.archive[field])) {
        throw new Error('Reused Windows native source differs from the actually held original container.');
      }
    } else {
      const acquisition = JSON.parse(await read(source.httpReceipt));
      if (!isDeepStrictEqual(acquisition.selectedSource, chosen) || ![chosen.url, chosen.url2].filter(Boolean).includes(acquisition.http.requestedUrl)
        || acquisition.http.status !== 200 || acquisition.http.bytes !== source.archive.bytes || acquisition.http.sha256 !== chosen.sha256) {
        throw new Error('Additional Windows native source differs from its original response and actual recipe checksum.');
      }
    }
    const members = JSON.parse(await read(source.members));
    if (!source.root.endsWith('/') || source.root.startsWith('/') || source.root.split('/').some(part => part === '.' || part === '..')
      || source.packages.some(name => graph.receipt.selected.find(node => node.package === name)?.subdir !== source.root.slice(0, -1))
      || members.some(member => !member.path.startsWith(source.root) && member.path.replace(/\/$/u, '') !== source.root.slice(0, -1)
        || /[\\\r\n\0]/u.test(member.path) || member.path.split('/').some(part => part === '.' || part === '..')
        || !['file', 'directory', 'symlink'].includes(member.kind) || !Number.isSafeInteger(member.bytes) || member.bytes < 0)) {
      throw new Error('Windows native original source members differ from the actual recipe extraction root.');
    }
    const notices = members.filter(member => member.kind === 'file' && namedNotice(member.path)).map(member => member.path);
    if (!sameSet(notices, source.notices.map(notice => notice.member))) throw new Error('Windows native original notice set is incomplete.');
    checked.push({ ...source, members });
  }
  await read(catalog.instructions);
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, 'windows-native-source-reader-')); let primary, failed = false;
  try {
    for (const source of checked) {
      const cwd = path.join(work, source.packages[0]); await mkdir(cwd);
      const contents = await readNativeSourceArchive(path.join(root, directory, source.archive.path), source.members, source.notices.map(notice => notice.member), cwd);
      for (const notice of source.notices) {
        if (!contents.get(notice.member)?.equals(await read(notice))) throw new Error('Windows native original notice differs from its complete archive member.');
      }
    }
  } catch (error) { failed = true; primary = error; }
  try { await removeOwned(parent, work); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], 'Windows native source reading and cleanup failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
  return { catalogPath: path.posix.join(directory, offer.windowsNativeAggregateSources.path), catalog, graph, inputs, sources: checked };
}

export async function windowsNativeAggregateSourceMaterials(root, files) {
  const state = await readWindowsNativeAggregateSources(root, files);
  return { path: state.catalogPath, limitations: state.catalog.limitations, selectedNativeNodes: state.graph.receipt.selected.length,
    suppliedContainers: state.sources.length, selectedOriginalPatches: state.graph.patches.size };
}
