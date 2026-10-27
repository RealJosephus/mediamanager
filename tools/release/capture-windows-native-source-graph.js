import { mkdir, readFile, cp, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileIdentity, gitCommand, inside, json, removeOwned } from './materials.js';
import { windowsNativeBuildInputs } from './windows-native-build-inputs.js';

const columns = ['target', 'package', 'type', 'enabled', 'normal', 'orderOnly', 'allSource', 'buildRule', 'version', 'checksum', 'file', 'subdir', 'url', 'url2', 'patches'];
const names = text => text.trim() ? text.trim().split(/\s+/u) : [];
const nodeKey = node => node.target + '~' + node.package;
const dependencyKey = text => {
  const match = text.match(/^([^/]+)\/installed\/([A-Za-z0-9+_.-]+)$/u);
  if (!match) throw new Error('GNU Make emitted an unsupported actual native prerequisite: ' + text);
  return match[1] + '~' + match[2];
};

async function command(executable, args, cwd, output, stem) {
  const child = spawn(executable, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError, stdout = '', stderr = '', bytes = 0, overflow = false, expired = false;
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  };
  child.once('error', error => { spawnError = error; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) { overflow = true; stop(); }
    else stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) { overflow = true; stop(); }
    else stderr += chunk;
  });
  const timer = setTimeout(() => { expired = true; stop(); }, 120_000);
  let outcome;
  try { outcome = await finished; } finally { clearTimeout(timer); }
  await writeFile(path.join(output, stem + '.stdout.txt'), stdout, { flag: 'wx' });
  await writeFile(path.join(output, stem + '.stderr.txt'), stderr, { flag: 'wx' });
  await writeFile(path.join(output, stem + '.command.json'), JSON.stringify({ executable, args, ...outcome, overflow, expired }, null, 2) + '\n', { flag: 'wx' });
  if (spawnError) throw spawnError;
  if (overflow || expired || outcome.code !== 0 || outcome.signal) throw new Error('Actual Windows native source graph command failed: ' + stem);
}

function parseRecords(text, expectedPhase) {
  const rows = text.split(/\r?\n/u).filter(Boolean), header = rows.shift()?.split('\t');
  if (header?.length !== 4 || header[0] !== 'META' || header[1] !== expectedPhase || !header[2] || !header[3]) throw new Error('GNU Make source graph header is incomplete.');
  const nodes = new Map();
  for (const row of rows) {
    const fields = row.split('\t');
    if (fields.length !== columns.length || fields.some(field => /[\r\n\0]/u.test(field))) throw new Error('GNU Make source graph record is incomplete.');
    const node = Object.fromEntries(columns.map((name, index) => [name, fields[index]]));
    if (!/^[A-Za-z0-9+_.-]+$/u.test(node.package) || !/^[A-Za-z0-9+_.-]+$/u.test(node.target) || !['true', 'false'].includes(node.enabled) || nodes.has(nodeKey(node))) {
      throw new Error('GNU Make source graph node is unsupported or duplicated.');
    }
    for (const kind of ['normal', 'orderOnly', 'allSource', 'patches']) node[kind] = names(node[kind]);
    nodes.set(nodeKey(node), node);
  }
  if (!nodes.size || nodes.size > 10_000) throw new Error('GNU Make source graph node set exceeds its actual bounded profile.');
  return { build: header[2], targets: names(header[3]), nodes };
}

function captureMakefile() {
  const tab = '\t', fields = [
    '$(TARGET)', '$(PKG)', '$($(PKG)_TYPE)', '$(if $(value $(call LOOKUP_PKG_RULE,$(PKG),BUILD,$(TARGET))),true,false)',
    '$(strip $(PKG_DEPS))', '$(strip $(PKG_OO_DEPS))', '$(strip $(PKG_ALL_DEPS))', '$(call LOOKUP_PKG_RULE,$(PKG),BUILD,$(TARGET))',
    '$(if $(filter sources,$(MM_PHASE)),$($(PKG)_VERSION))', '$(if $(filter sources,$(MM_PHASE)),$($(PKG)_CHECKSUM))',
    '$(if $(filter sources,$(MM_PHASE)),$($(call LOOKUP_PKG_RULE,$(PKG),FILE,$(TARGET))))',
    '$(if $(filter sources,$(MM_PHASE)),$($(PKG)_SUBDIR))',
    '$(if $(filter sources,$(MM_PHASE)),$($(call LOOKUP_PKG_RULE,$(PKG),URL,$(TARGET))))',
    '$(if $(filter sources,$(MM_PHASE)),$($(PKG)_URL_2))', '$(if $(filter sources,$(MM_PHASE)),$($(PKG)_PATCHES))',
  ];
  return [
    `$(file >$(MM_RECORDS),META${tab}$(MM_PHASE)${tab}$(BUILD)${tab}$(MXE_TARGETS))`,
    'define MM_CAPTURE_NODE', `$(file >>$(MM_RECORDS),${fields.join(tab)})`, 'endef',
    '$(foreach TARGET,$(MXE_TARGETS),$(foreach PKG,$($(TARGET)_PKGS),$(if $(or $(filter edges,$(MM_PHASE)),$(filter $(TARGET)~$(PKG),$(MM_FILTER))),$(call MM_CAPTURE_NODE))))',
    '.PHONY: mediamanager-source-graph', 'mediamanager-source-graph:', '\t@:', '',
  ].join('\n');
}

export async function captureWindowsNativeSourceGraph(root, output) {
  root = path.resolve(root); output = path.resolve(output); inside(root, output);
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Actual MXE source graph capture requires its Linux CI build host.');
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  if (path.dirname(output) !== parent) throw new Error('MXE source graph evidence must be a new direct child of .test-output.');
  await mkdir(output, { recursive: false });
  const receipt = { completed: false, compiledNativePackages: false, target: 'x86_64-w64-mingw32.static', package: 'vips-web',
    scope: 'Current effective GNU Make source/dependency graph of the actual static-dependency Sharp Windows variant; not a recovered historical builder/link map.' };
  let work, primary;
  try {
    const inputs = await windowsNativeBuildInputs(root), { catalog } = inputs;
    receipt.candidate = { commit: (await gitCommand(['rev-parse', 'HEAD'], { cwd: root })).trim(), tree: (await gitCommand(['rev-parse', 'HEAD^{tree}'], { cwd: root })).trim() };
    receipt.inputs = { path: inputs.catalogPath, ...inputs.catalogIdentity, sources: catalog.sources.map(source => ({ name: source.name, commit: source.commit, tree: source.tree, archive: source.archive })) };
    work = await mkdtemp(path.join(parent, 'mxe-native-work-'));
    const sourceDirectory = 'tools/release/source-materials';
    for (const source of catalog.sources) {
      const target = path.join(work, source.name); await mkdir(target);
      await command('tar', ['-xzf', path.join(root, sourceDirectory, source.archive.path), '-C', target], work, output, 'extract-' + source.name);
    }
    const base = catalog.sources.find(source => source.name === 'mxe'), producer = catalog.sources.find(source => source.name === 'build-win64-mxe');
    const mxe = path.resolve(work, 'mxe', base.root), producerRoot = path.resolve(work, 'build-win64-mxe', producer.root), data = path.join(producerRoot, 'build');
    await cp(path.join(data, 'settings/release.mk'), path.join(mxe, 'settings.mk'));
    const capture = path.join(work, 'capture.mk'); await writeFile(capture, captureMakefile(), { flag: 'wx' });
    await cp(capture, path.join(output, 'capture.mk'));
    const plugins = [path.join(mxe, 'plugins/llvm-mingw'), data, ...['mozjpeg', 'zlib-ng', 'web-deps', 'proxy-libintl'].map(name => path.join(data, 'plugins', name))];
    const common = ['--no-print-directory', '-f', 'Makefile', '-f', capture, 'mediamanager-source-graph',
      'MXE_TARGETS=' + catalog.target, 'MXE_PLUGIN_DIRS=' + plugins.join(' '), 'GIT_HEAD=' + base.commit, 'MXE_USE_CCACHE='];
    await command('make', ['--version'], mxe, output, 'make-version');
    const edgesFile = path.join(output, 'edges.tsv');
    await command('make', [...common, 'MM_PHASE=edges', 'MM_RECORDS=' + edgesFile], mxe, output, 'make-edges');
    const edges = parseRecords(await readFile(edgesFile, 'utf8'), 'edges');
    const selected = new Map(), boundaries = new Map(), pending = [catalog.target + '~' + catalog.package];
    while (pending.length) {
      const key = pending.shift();
      if (selected.has(key) || boundaries.has(key)) continue;
      const node = edges.nodes.get(key);
      if (!node) throw new Error('Actual MXE dependency is absent from the expanded graph: ' + key);
      if (node.target !== catalog.target || catalog.toolBoundaries.includes(node.package)) {
        boundaries.set(key, { ...node, reason: node.target !== catalog.target ? 'build-host dependency' : 'available compatible build tool boundary' });
        continue;
      }
      if (node.enabled !== 'true' && !['meta', 'script'].includes(node.type)) throw new Error('Actual selected Windows native build rule is disabled: ' + key);
      selected.set(key, node);
      for (const dependency of node.normal) pending.push(dependencyKey(dependency));
    }
    const sourcesFile = path.join(output, 'sources.tsv');
    await command('make', [...common, 'MM_PHASE=sources', 'MM_RECORDS=' + sourcesFile, 'MM_FILTER=' + [...selected.keys()].sort().join(' ')], mxe, output, 'make-sources');
    const sources = parseRecords(await readFile(sourcesFile, 'utf8'), 'sources');
    if (sources.build !== edges.build || !isSameSet(sources.nodes.keys(), selected.keys())) throw new Error('Actual MXE selected source graph changed between metadata observations.');
    const offer = await json(path.join(root, sourceDirectory, 'source-offer.json')), native = await json(path.join(root, sourceDirectory, offer.nativePackages.path));
    const versionsPin = native.sharpNativeNotices.platforms.find(platform => platform.platform === 'win32' && platform.architecture === 'x64')?.versions;
    if (!versionsPin || !isIdentity(await fileIdentity(path.join(root, sourceDirectory, versionsPin.path)), versionsPin)) throw new Error('Actual Windows version declaration is missing or changed.');
    const versions = await json(path.join(root, sourceDirectory, versionsPin.path)), fields = new Set(), aliases = {
      'vips-web': 'vips', 'freetype-bootstrap': 'freetype', libarchive: 'archive', libexif: 'exif', libffi: 'ffi', libheif: 'heif',
      libimagequant: 'imagequant', libpng: 'png', librsvg: 'rsvg', libwebp: 'webp', libxml2: 'xml2',
    };
    const patches = new Map();
    for (const [key, node] of sources.nodes) {
      const first = selected.get(key);
      if (['normal', 'orderOnly', 'allSource'].some(kind => JSON.stringify(first[kind]) !== JSON.stringify(node[kind]))) throw new Error('Actual MXE dependencies changed during source metadata selection.');
      const field = aliases[node.package] ?? node.package;
      if (versions[field] !== node.version || !/^[a-f0-9]{64}$/u.test(node.checksum) || !node.file || !node.url) throw new Error('Actual selected MXE source differs from the Windows constituent declaration: ' + node.package);
      fields.add(field);
      for (const filename of node.patches) {
        inside(work, filename);
        const source = filename.startsWith(mxe + path.sep) ? { name: 'mxe', root: mxe } : filename.startsWith(producerRoot + path.sep) ? { name: 'build-win64-mxe', root: producerRoot } : undefined;
        if (!source) throw new Error('Actual MXE selected patch is outside its original source containers.');
        const relative = path.relative(source.root, filename).split(path.sep).join('/'), target = path.join(output, 'patches', source.name, relative);
        await mkdir(path.dirname(target), { recursive: true }); await cp(filename, target);
        patches.set(source.name + '/' + relative, { source: source.name, path: relative, ...await fileIdentity(filename) });
      }
    }
    if (!isSameSet(fields, Object.keys(versions))) throw new Error('Actual selected MXE native graph does not cover the full declared Windows constituent set.');
    receipt.buildHost = edges.build; receipt.plugins = catalog.plugins; receipt.windowsVersions = { ...versionsPin, values: versions };
    receipt.selected = [...sources.nodes.values()].sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)));
    const requiredContainers = new Map();
    for (const node of receipt.selected) {
      const identity = node.file + ':' + node.checksum;
      if (!requiredContainers.has(identity)) requiredContainers.set(identity, { file: node.file, sha256: node.checksum, url: node.url, url2: node.url2, packages: [] });
      requiredContainers.get(identity).packages.push(node.package);
    }
    receipt.requiredContainers = [...requiredContainers.values()];
    receipt.toolBoundaries = [...boundaries.values()]; receipt.patches = [...patches.values()];
    await removeOwned(parent, work); work = undefined; receipt.completed = true;
  } catch (error) { primary = error; receipt.error = { name: error.name, message: error.message }; }
  finally {
    if (work) receipt.retainedFailureWork = path.relative(root, work).split(path.sep).join('/');
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
  if (primary) throw primary;
  return receipt;
}

const isSameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const isIdentity = (actual, pin) => actual.bytes === pin.bytes && actual.sha256 === pin.sha256;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await captureWindowsNativeSourceGraph(process.cwd(), process.argv[2] ?? '.test-output/mxe-native-source-graph');
}
