import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileIdentity, inside, removeOwned } from './materials.js';
import { readWindowsNativeAggregateSources } from './windows-native-aggregate-sources.js';

async function command(executable, args, cwd, output, stem, timeout = 120_000) {
  const child = spawn(executable, args, { cwd, detached: true, windowsHide: true, env: { ...process.env, MAKEFLAGS: '', MAKEFILES: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError, stdout = '', stderr = '', bytes = 0, overflow = false, expired = false;
  const settled = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  };
  child.once('error', error => { spawnError = error; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const receive = (field, chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) { overflow = true; stop(); return; }
    if (field === 'stdout') stdout += chunk; else stderr += chunk;
  };
  child.stdout.on('data', chunk => receive('stdout', chunk)); child.stderr.on('data', chunk => receive('stderr', chunk));
  const timer = setTimeout(() => { expired = true; stop(); }, timeout);
  let result;
  try { result = await settled; } finally { clearTimeout(timer); }
  await writeFile(path.join(output, stem + '.stdout.txt'), stdout, { flag: 'wx' });
  await writeFile(path.join(output, stem + '.stderr.txt'), stderr, { flag: 'wx' });
  await writeFile(path.join(output, stem + '.command.json'), JSON.stringify({ executable, args, ...result, overflow, expired }, null, 2) + '\n', { flag: 'wx' });
  if (spawnError) throw spawnError;
  if (result.code !== 0 || result.signal || overflow || expired) throw new Error('Actual Windows native source preparation command failed: ' + stem);
}

async function sourceTree(root) {
  const files = [];
  async function visit(relative) {
    const filename = path.join(root, relative); inside(root, filename);
    const info = await lstat(filename);
    if (info.isSymbolicLink()) files.push({ path: relative.split(path.sep).join('/'), kind: 'symlink', target: await readlink(filename) });
    else if (info.isDirectory()) for (const name of (await readdir(filename)).sort()) await visit(path.join(relative, name));
    else if (info.isFile()) files.push({ path: relative.split(path.sep).join('/'), ...await fileIdentity(filename) });
    else throw new Error('Prepared Windows native source contains an unsupported filesystem object.');
  }
  for (const name of (await readdir(root)).sort()) await visit(name);
  return files;
}

export async function prepareWindowsNativeSources(root, output) {
  root = path.resolve(root); output = path.resolve(output); inside(root, output);
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Actual GNU Make source preparation requires its isolated Linux CI build host.');
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  if (path.dirname(output) !== parent) throw new Error('Native source preparation evidence must be a new direct child of .test-output.');
  await mkdir(output, { recursive: false });
  const receipt = { completed: false, compiledNativePackages: false, target: 'x86_64-w64-mingw32.static', package: 'vips-web',
    scope: 'Actual original GNU Make prepare-pkg-source targets apply selected fixed patches to complete pristine native source containers. Build-time inline edits and native compilation retain their own scope.' };
  let work, primary;
  try {
    const state = await readWindowsNativeAggregateSources(root), directory = 'tools/release/source-materials';
    receipt.inputs = { catalogPath: state.catalogPath, ...await fileIdentity(path.join(root, state.catalogPath)),
      graphRun: state.catalog.graph.runId, graphCandidate: state.graph.receipt.candidate };
    work = await mkdtemp(path.join(parent, 'windows-native-prepare-work-'));
    for (const source of state.inputs.catalog.sources) {
      const target = path.join(work, source.name); await mkdir(target);
      await command('tar', ['-xzf', path.join(root, directory, source.archive.path), '-C', target], work, output, 'extract-' + source.name);
    }
    const base = state.inputs.catalog.sources.find(source => source.name === 'mxe'), producer = state.inputs.catalog.sources.find(source => source.name === 'build-win64-mxe');
    const mxe = path.resolve(work, 'mxe', base.root), producerRoot = path.resolve(work, 'build-win64-mxe', producer.root), data = path.join(producerRoot, 'build');
    await cp(path.join(data, 'settings/release.mk'), path.join(mxe, 'settings.mk'));
    const cache = path.join(work, 'cache'), temporary = path.join(work, 'native-tmp');
    await mkdir(cache); await mkdir(temporary);
    for (const source of state.sources) {
      const filename = path.join(cache, source.file); inside(cache, filename);
      await cp(path.join(root, directory, source.archive.path), filename);
      const actual = await fileIdentity(filename);
      if (actual.bytes !== source.archive.bytes || actual.sha256 !== source.sha256) throw new Error('Prepared native cache differs from its exact selected source container.');
    }
    const plugins = [path.join(mxe, 'plugins/llvm-mingw'), data, ...['mozjpeg', 'zlib-ng', 'web-deps', 'proxy-libintl'].map(name => path.join(data, 'plugins', name))];
    const goals = state.graph.receipt.selected.map(node => 'prepare-pkg-source-' + node.package);
    await command('make', ['--no-print-directory', ...goals, 'MXE_TARGETS=' + receipt.target, 'MXE_PLUGIN_DIRS=' + plugins.join(' '),
      'GIT_HEAD=' + base.commit, 'MXE_USE_CCACHE=', 'PKG_DIR=' + cache, 'MXE_TMP=' + temporary, 'MXE_PREFIX=' + path.join(work, 'prefix'),
      'LOG_DIR=' + path.join(output, 'make-logs')], mxe, output, 'make-prepare-native-sources', 600_000);
    const prepared = [];
    let changedBytes = 0;
    for (const node of state.graph.receipt.selected) {
      const source = state.sources.find(source => source.packages.includes(node.package));
      const sourceRoot = path.join(temporary, 'tmp-' + node.package, node.subdir); inside(temporary, sourceRoot);
      const before = new Map(source.members.filter(member => member.kind !== 'directory').map(member => [member.path.slice(source.root.length), member]));
      const after = await sourceTree(sourceRoot), byPath = new Map(after.map(member => [member.path, member])), changed = [];
      for (const member of after) {
        const previous = before.get(member.path), same = member.kind === 'symlink'
          ? previous?.kind === 'symlink' && previous.target === member.target
          : previous?.kind === 'file' && previous.bytes === member.bytes && previous.sha256 === member.sha256;
        if (!same) changed.push(member);
      }
      for (const [name, member] of before) if (!byPath.has(name)) changed.push({ path: name, kind: 'removed', previous: member });
      const identityFile = path.join(output, 'prepared', node.package, 'members.json'); await mkdir(path.dirname(identityFile), { recursive: true });
      await writeFile(identityFile, JSON.stringify(after, null, 2) + '\n', { flag: 'wx' });
      for (const member of changed) {
        if (member.kind) continue;
        changedBytes += member.bytes;
        if (changedBytes > 32 * 1024 * 1024) throw new Error('Actual native source patch output exceeds its inspectable changed-file bound.');
        const destination = path.join(output, 'prepared', node.package, 'changed', member.path); inside(output, destination);
        await mkdir(path.dirname(destination), { recursive: true }); await cp(path.join(sourceRoot, member.path), destination);
      }
      const patchKeys = node.patches.map(filename => [...state.graph.patches].find(([, patch]) => {
        const owner = state.inputs.catalog.sources.find(owner => owner.name === patch.source);
        return filename.endsWith('/' + owner.name + '/' + owner.root + patch.path);
      })?.[0]);
      if (patchKeys.some(key => !key) || patchKeys.length && !changed.length) throw new Error('Actual selected source patches did not produce inspectable prepared source changes.');
      prepared.push({ package: node.package, subdir: node.subdir, originalContainer: source.archive, patches: patchKeys, changed,
        completePreparedMembers: { path: path.relative(output, identityFile).split(path.sep).join('/'), ...await fileIdentity(identityFile) },
        buildRule: node.buildRule, buildTimeInlineEditsApplied: false });
    }
    const applied = new Set(prepared.flatMap(source => source.patches));
    if (applied.size !== state.graph.patches.size || [...state.graph.patches.keys()].some(key => !applied.has(key))) throw new Error('Actual original Windows native patch preparation is incomplete.');
    receipt.prepared = prepared; receipt.appliedOriginalPatchCount = applied.size; receipt.changedFileBytes = changedBytes;
    await removeOwned(parent, work); work = undefined; receipt.completed = true;
  } catch (error) { primary = error; receipt.error = { name: error.name, message: error.message }; }
  finally {
    if (work) receipt.retainedFailureWork = path.relative(root, work).split(path.sep).join('/');
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
  if (primary) throw primary;
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareWindowsNativeSources(process.cwd(), process.argv[2] ?? '.test-output/windows-native-source-preparation');
}
