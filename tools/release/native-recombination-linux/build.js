import assert from 'node:assert/strict';
import { createWriteStream, constants } from 'node:fs';
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createReleaseDirectory, dependencySkip, deliverySkip, fileIdentity, gitCommand, inside, json, tree, verifyFiles, writeJson } from '../materials.js';
import { recombinationInputs, originalInlineEdits, pristineSourceSnapshot, originalPatchForExecution } from './inputs.js';
import { verifyConsumerPair } from './verify.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const own = path.join(root, 'tools/release/native-recombination-linux');
const relative = (base, value) => path.relative(base, value).split(path.sep).join('/');

async function executable(name) {
  for (const directory of process.env.PATH.split(path.delimiter)) {
    const filename = path.join(directory, name);
    try { await access(filename, constants.X_OK); if ((await lstat(await realpath(filename))).isFile()) return await realpath(filename); }
    catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('Required native recombination tool is absent: ' + name);
}

function commands(output, signal) {
  let index = 0;
  return async function run(tool, args, { cwd = root, env = process.env, capture = true, acceptedCodes = [0] } = {}) {
    signal.throwIfAborted();
    const id = String(++index).padStart(3, '0') + '-' + path.basename(tool);
    const directory = path.join(output, 'commands', id); await mkdir(directory, { recursive: true });
    const started = { executable: tool, args, cwd, started: new Date().toISOString() };
    await writeJson(path.join(directory, 'started.json'), started);
    const stdout = createWriteStream(path.join(directory, 'stdout.txt'), { flags: 'wx' });
    const stderr = createWriteStream(path.join(directory, 'stderr.txt'), { flags: 'wx' });
    const child = spawn(tool, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', failure, killTimer;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= error; } }, 5000);
      killTimer.unref();
    };
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    if (capture) child.stdout.on('data', chunk => {
      if (Buffer.byteLength(text) + chunk.length > 16 * 1024 * 1024) { failure ??= new Error('Captured native command output exceeds its complete bound.'); terminate(); }
      else text += chunk.toString('utf8');
    });
    child.once('error', error => { failure ??= error; });
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    const ended = await new Promise(resolve => child.once('close', (code, reason) => resolve({ code, signal: reason })));
    clearTimeout(killTimer); signal.removeEventListener('abort', terminate);
    await Promise.all([finished(stdout), finished(stderr)]);
    await writeJson(path.join(directory, 'completed.json'), { ...started, ...ended, acceptedCodes, finished: new Date().toISOString(), aborted: signal.aborted,
      stdout: await fileIdentity(path.join(directory, 'stdout.txt')), stderr: await fileIdentity(path.join(directory, 'stderr.txt')) });
    signal.throwIfAborted();
    if (failure) throw failure;
    if (!acceptedCodes.includes(ended.code) || ended.signal) throw new Error('Native recombination command failed; complete original output: ' + relative(output, directory));
    return text;
  };
}

async function systemDependencies(run, tools, profile, library, output) {
  const installed = await run(tools['dpkg-query'], ['-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\n']);
  await writeFile(path.join(output, 'system-packages.tsv'), installed, { flag: 'wx' });
  const versions = {};
  for (const name of profile.pkgConfigDependencies) versions[name] = (await run(tools['pkg-config'], ['--modversion', name])).trim();
  const linked = await run(tools.ldd, [library]);
  assert.ok(!linked.includes('not found'), 'The newly built aggregate has unavailable runtime dependencies.');
  const paths = [...new Set([...linked.matchAll(/(\/[^\s()]+)\s+\(0x[0-9a-f]+\)/gu)].map(value => value[1]))].sort();
  assert.ok(paths.length > 0, 'The actual linked dependency graph was not recorded.');
  const dependencies = [], packages = new Set(profile.systemPackages);
  for (const filename of paths) {
    const actual = await realpath(filename);
    // Ubuntu's merged /usr can expose a loader path different from dpkg's
    // recorded original path. Query both identities and retain every result.
    const names = new Set();
    for (const query of new Set([filename, actual, actual.replace(/^\/usr\/(lib|lib64)\//u, '/$1/')])) {
      const owners = await run(tools['dpkg-query'], ['-S', query], { acceptedCodes: [0, 1] });
      for (const match of owners.matchAll(/^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?): /gmu)) names.add(match[1]);
    }
    assert.ok(names.size, 'A used system dependency has no original package association: ' + filename);
    for (const name of names) packages.add(name);
    dependencies.push({ path: filename, realpath: actual, ...await fileIdentity(actual), packages: [...names].sort() });
  }
  const notices = [];
  for (const name of [...packages].sort()) {
    const packageName = name.split(':')[0], filename = path.join('/usr/share/doc', packageName, 'copyright');
    const actual = await realpath(filename);
    const destination = path.join(output, 'system-notices', name.replaceAll(':', '_') + '.copyright');
    await mkdir(path.dirname(destination), { recursive: true }); await copyFile(actual, destination);
    const identity = (await run(tools['dpkg-query'], ['-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\n', name])).trim();
    notices.push({ package: name, identity, originalPath: filename, path: relative(output, destination), ...await fileIdentity(destination) });
  }
  const commonLicenses = [];
  for (const name of (await readdir('/usr/share/common-licenses')).sort()) {
    const filename = path.join('/usr/share/common-licenses', name);
    if (!(await lstat(filename)).isFile()) continue;
    const destination = path.join(output, 'common-licenses', name);
    await mkdir(path.dirname(destination), { recursive: true }); await copyFile(filename, destination);
    commonLicenses.push({ originalPath: filename, path: relative(output, destination), ...await fileIdentity(destination) });
  }
  return { pkgConfig: versions, dependencies, notices, commonLicenses };
}

async function exercise(output, signal) {
  const inputs = await recombinationInputs(root), { profile, source, members } = inputs;
  await writeJson(path.join(output, 'inputs.json'), inputs);
  const run = commands(output, signal), tools = {}, toolReceipts = [];
  const node = await realpath(process.execPath);
  toolReceipts.push({ name: 'node', path: node, ...await fileIdentity(node), version: await run(node, ['--version']) });
  for (const name of ['tar', 'patch', 'meson', 'ninja', 'cc', 'c++', 'readelf', 'ldd', 'pkg-config', 'dpkg-query']) {
    tools[name] = await executable(name);
    const version = await run(tools[name], ['--version']);
    toolReceipts.push({ name, path: tools[name], ...await fileIdentity(tools[name]), version });
  }
  await writeJson(path.join(output, 'tools.json'), toolReceipts);
  const materialRoot = path.join(root, 'tools/release/source-materials');
  const archive = path.join(materialRoot, source.archive.path), extractRoot = path.join(output, 'source');
  await mkdir(extractRoot);
  const listing = (await run(tools.tar, ['-tf', archive])).split(/\r?\n/u).filter(Boolean).map(value => value.replace(/\/$/u, '')).sort();
  assert.deepEqual(listing, members.map(value => value.path).sort(), 'Complete pristine source archive membership changed.');
  await run(tools.tar, ['--extract', '--file=' + archive, '--directory=' + extractRoot, '--no-same-owner']);
  const sourceRoot = path.join(extractRoot, source.root), before = await pristineSourceSnapshot(sourceRoot, members, source.root);
  await writeJson(path.join(output, 'pristine-files.json'), before);
  const changedNames = ['meson.build', 'libvips/meson.build', 'cplusplus/meson.build', 'libvips/foreign/vipspng.c'];
  const saveSources = async stage => {
    const files = [];
    for (const name of changedNames) {
      const destination = path.join(output, stage, name);
      await mkdir(path.dirname(destination), { recursive: true }); await copyFile(path.join(sourceRoot, name), destination);
      files.push({ path: name, ...await fileIdentity(destination) });
    }
    await writeJson(path.join(output, stage, 'files.json'), files);
    return files;
  };
  await saveSources('pristine');
  const evidenceInputs = [source.members.path, ...source.notices.map(value => value.path), inputs.recipe.build.path, inputs.recipe.versions.path, inputs.recipe.patch.path];
  for (const name of evidenceInputs) {
    const target = path.join(output, 'original-inputs', name);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(materialRoot, name), target);
  }
  await cp(own, path.join(output, 'private-change'), { recursive: true });
  const originalPatch = path.join(materialRoot, inputs.recipe.patch.path);
  const executablePatch = originalPatchForExecution(await readFile(originalPatch));
  const executablePatchPath = path.join(output, 'original-recipe-applied', 'libvips-cpp-soversion.execution.patch');
  await mkdir(path.dirname(executablePatchPath), { recursive: true });
  await writeFile(executablePatchPath, executablePatch.bytes, { flag: 'wx' });
  const patchExecution = { original: { path: inputs.recipe.patch.path, ...await fileIdentity(originalPatch) },
    executed: { path: relative(output, executablePatchPath), ...await fileIdentity(executablePatchPath) }, transformation: executablePatch.transformation };
  await writeJson(path.join(output, 'patch-execution.json'), patchExecution);
  const strictPatch = async filename => {
    const text = await run(tools.patch, ['--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '--input=' + filename], { cwd: sourceRoot });
    assert.ok(!/\b(?:offset|fuzz|FAILED|Reversed)\b/iu.test(text), 'Native source patch did not apply at its original exact context.');
  };
  await strictPatch(executablePatchPath);
  const textFiles = Object.fromEntries(await Promise.all(changedNames.map(async name => [name, await readFile(path.join(sourceRoot, name), 'utf8')])));
  for (const [name, text] of Object.entries(originalInlineEdits(textFiles))) await writeFile(path.join(sourceRoot, name), text);
  await writeFile(path.join(sourceRoot, 'vips.map'), '{local:g_param_spec_types;};', { flag: 'wx' });
  await saveSources('original-recipe-applied');
  await strictPatch(path.join(own, profile.privatePatch));
  const modifiedSources = await saveSources('private-modification');
  assert.notEqual(modifiedSources.find(value => value.path === 'libvips/foreign/vipspng.c').sha256,
    before.find(value => value.path === 'libvips/foreign/vipspng.c').sha256, 'The actual private PNG source modification must be present.');
  const preparedFiles = await tree(sourceRoot);
  await writeJson(path.join(output, 'prepared-files.json'), preparedFiles);
  const prefix = path.join(output, 'prefix'), build = path.join(output, 'build');
  const linkArgs = '-Wl,-Bsymbolic-functions -Wl,--version-script=' + path.join(sourceRoot, 'vips.map');
  const environment = { ...process.env, CC: tools.cc, CXX: tools['c++'], CFLAGS: '-O3', CXXFLAGS: '-O3' };
  await run(tools.meson, ['setup', build, sourceRoot, '--prefix=' + prefix, ...profile.mesonOptions, '-Dcpp_link_args=' + linkArgs], { env: environment, capture: false });
  await run(tools.meson, ['compile', '-C', build, '-j', '2'], { env: environment, capture: false });
  await run(tools.meson, ['install', '-C', build, '--tags', 'runtime,devel'], { env: environment, capture: false });
  await cp(path.join(build, 'meson-logs'), path.join(output, 'meson-logs'), { recursive: true });
  await cp(path.join(build, 'meson-info'), path.join(output, 'meson-info'), { recursive: true });
  const library = path.join(prefix, 'lib', profile.aggregate);
  assert.equal(await realpath(library), library, 'The new aggregate must be the actual installed regular library.');
  assert.ok((await lstat(library)).isFile());
  const dynamic = await run(tools.readelf, ['--dynamic', '--wide', library]);
  assert.match(dynamic, /\(SONAME\).*\[libvips-cpp\.so\.8\.18\.6\]/u);
  assert.match(dynamic, /\bNODELETE\b/u);
  assert.ok(!/\(NEEDED\).*\[libvips(?:-cpp)?\.so/u.test(dynamic), 'The C libvips must be inside the private C++ aggregate.');
  const system = await systemDependencies(run, tools, profile, library, output);
  await writeJson(path.join(output, 'system-dependencies.json'), system);
  assert.deepEqual(await tree(sourceRoot), preparedFiles, 'The native build changed its recorded source inputs.');
  const replacement = await fileIdentity(library);
  const runtime = path.join(root, '.test-output', path.basename(output) + '-runtime');
  // Use the real delivery assembler and offline prepare. The consumer is then
  // launched from that private complete delivery, never from checkout modules.
  await run(process.execPath, [path.join(root, 'tools/release/package.js'), runtime], { capture: false });
  await run(process.execPath, [path.join(runtime, 'tools/release/prepare.js'), path.join(runtime, '.test-output', 'offline-prepare.json')], { cwd: runtime, capture: false });
  const manifest = await json(path.join(runtime, 'release.json'));
  await copyFile(path.join(runtime, 'release.json'), path.join(output, 'runtime-release.json'));
  await copyFile(path.join(runtime, '.test-output', 'offline-prepare.json'), path.join(output, 'runtime-offline-prepare.json'));
  const installedBefore = await tree(runtime, 'node_modules', dependencySkip);
  const libraryRelative = 'node_modules/@img/sharp-libvips-linux-x64/lib/' + profile.aggregate;
  const runtimeLibrary = path.join(runtime, libraryRelative);
  assert.equal(await realpath(runtimeLibrary), runtimeLibrary, 'The private vendor aggregate must be an ordinary file.');
  const original = await fileIdentity(runtimeLibrary);
  assert.notEqual(replacement.sha256, original.sha256);
  const inputRoot = path.join(output, 'images'); await mkdir(inputRoot);
  const consumer = path.join(runtime, 'tools/release/native-recombination-linux/consumer.js');
  const receipts = {};
  for (const mode of ['stock', 'modified']) {
    if (mode === 'modified') {
      await copyFile(library, runtimeLibrary);
      assert.deepEqual(await fileIdentity(runtimeLibrary), replacement);
    }
    const receiptFile = path.join(output, mode + '.json');
    await run(process.execPath, [consumer, mode, inputRoot, path.join(output, mode + '-data'), receiptFile, runtimeLibrary], { cwd: runtime, capture: false });
    receipts[mode] = await json(receiptFile);
    signal.throwIfAborted();
  }
  verifyConsumerPair(receipts.stock, receipts.modified, { original, replacement, libraryPath: runtimeLibrary, redBias: profile.redBias });
  assert.deepEqual(receipts.stock.candidate, manifest.candidate);
  const expectedInstalled = installedBefore.map(value => value.path === libraryRelative ? { path: libraryRelative, ...replacement } : value);
  assert.deepEqual(await tree(runtime, 'node_modules', dependencySkip), expectedInstalled, 'Only the private aggregate may change in the prepared runtime.');
  await verifyFiles(runtime, manifest.files, { skip: deliverySkip });
  for (const pin of inputs.pins) assert.deepEqual(await fileIdentity(path.join(root, pin.path)), { bytes: pin.bytes, sha256: pin.sha256 }, 'An original supplied input changed during recombination.');
  const candidate = { commit: (await gitCommand(['rev-parse', 'HEAD'], { cwd: root })).trim(), tree: (await gitCommand(['rev-parse', 'HEAD^{tree}'], { cwd: root })).trim() };
  assert.deepEqual(candidate, manifest.candidate);
  assert.equal((await gitCommand(['status', '--porcelain', '--untracked-files=normal'], { cwd: root })).trim(), '', 'Native recombination changed the candidate source checkout.');
  signal.throwIfAborted();
  const receipt = { candidate, scope: profile.scope, source: source.archive, originalRecipe: inputs.recipe, originalPatchExecution: patchExecution, privatePatch: await fileIdentity(path.join(own, profile.privatePatch)),
    tools: toolReceipts, system, replacement: { path: relative(output, library), ...replacement }, original: { path: libraryRelative, ...original },
    runtime, runtimeManifest: await fileIdentity(path.join(runtime, 'release.json')), offlinePrepare: await json(path.join(runtime, '.test-output', 'offline-prepare.json')),
    pristineRegularFiles: before.length, recordedModifiedSources: modifiedSources, privateRuntimeChange: [libraryRelative],
    consumers: ['stock.json', 'modified.json'], compiledNativeLibrary: true, replacedPrivateLibrary: true, realSharpAndApplicationConsumers: true, passed: true };
  await writeJson(path.join(output, 'receipt.json'), receipt);
  try { signal.throwIfAborted(); }
  catch (error) { await unlink(path.join(output, 'receipt.json')); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Run native recombination in Linux x64 GitHub Actions.');
  if (process.argv.length !== 3) throw new Error('Usage: node tools/release/native-recombination-linux/build.js NEW_OUTPUT_UNDER_TEST_OUTPUT');
  const output = path.resolve(process.argv[2]); await createReleaseDirectory(root, output);
  const lifetime = new AbortController(), deadline = AbortSignal.timeout(90 * 60 * 1000);
  const interrupted = () => lifetime.abort(new Error('Native recombination was interrupted.'));
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  try { await exercise(output, AbortSignal.any([lifetime.signal, deadline])); }
  catch (error) { await writeJson(path.join(output, 'failure.json'), { name: error.name, message: error.message, stack: error.stack, passed: false }); throw error; }
  finally { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); }
}
