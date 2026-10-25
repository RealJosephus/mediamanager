#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const manifestUrl = new URL('./archive-codec-sources.json', import.meta.url);
const repository = fileURLToPath(new URL('../', import.meta.url));
const usage = `Build the pinned Book archive codec into a new output directory.

Usage:
  node tools/build-archive-codec.mjs --mode build|relink --build-root PATH
    --source-root PATH --python PATH --emcc PATH --em-config PATH --em-cache PATH

Full build additionally requires:
    --emar PATH --cmake PATH --ninja PATH --git PATH --toolchain-file PATH

Relink additionally requires existing, already patched inputs:
    --archive-lib PATH --zlib-lib PATH --bzip2-lib PATH --lzma-lib PATH
    --include-root PATH [--input-receipt PATH ...]

Options:
  --mode MODE       build (default) builds all four source packages; relink
                    actually links explicitly supplied compiled libraries.
  --build-root PATH Absolute create-only output root; it must not already exist.
  --source-root PATH Directory containing the four exact manifest archive names.
  --python PATH     Explicit Python executable for Emscripten .py entry points.
  --emcc PATH       Explicit emcc.py or executable.
  --emar PATH       Explicit emar.py or executable (full build).
  --em-config PATH  Explicit Emscripten configuration file.
  --em-cache PATH   Existing prepared Emscripten cache, used read-only.
  --toolchain-file PATH Explicit Emscripten.cmake file (full build).
  --jobs N          CMake build parallelism, 1..64 (default 4).
  --input-receipt PATH Extra immutable provenance input, repeatable.
  --help            Print this help without building.

Outputs remain under build-root. This tool never installs or copies files into
the repository. All external commands and their logs are recorded. A failed
build retains its partial outputs and failure receipt for inspection.
`;

export function parseArguments(args) {
  const values = { mode: 'build', jobs: 4, inputReceipts: [] };
  const keys = new Map(['mode', 'build-root', 'source-root', 'python', 'emcc', 'emar', 'cmake', 'ninja', 'git', 'toolchain-file',
    'em-config', 'em-cache', 'archive-lib', 'zlib-lib', 'bzip2-lib', 'lzma-lib', 'include-root', 'jobs', 'input-receipt'].map(key => ['--' + key, key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())]));
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') { values.help = true; continue; }
    const key = keys.get(args[index]);
    if (!key || index + 1 === args.length || args[index + 1].startsWith('--')) throw new Error('Unknown option or missing value: ' + args[index]);
    const value = args[++index];
    if (key === 'inputReceipt') values.inputReceipts.push(value);
    else if (Object.hasOwn(values, key) && !['mode', 'jobs'].includes(key)) throw new Error('Repeated option: ' + args[index - 1]);
    else values[key] = value;
  }
  if (values.help) return values;
  if (!['build', 'relink'].includes(values.mode)) throw new Error('--mode must be build or relink.');
  values.jobs = Number(values.jobs);
  if (!Number.isInteger(values.jobs) || values.jobs < 1 || values.jobs > 64) throw new Error('--jobs must be an integer between 1 and 64.');
  const required = ['buildRoot', 'sourceRoot', 'python', 'emcc', 'emConfig', 'emCache', ...(values.mode === 'build'
    ? ['emar', 'cmake', 'ninja', 'git', 'toolchainFile'] : ['archiveLib', 'zlibLib', 'bzip2Lib', 'lzmaLib', 'includeRoot'])];
  for (const key of required) if (!values[key]) throw new Error('Missing --' + key.replace(/[A-Z]/gu, letter => '-' + letter.toLowerCase()) + '.');
  for (const key of [...required.filter(key => key !== 'mode'), ...['emar', 'cmake', 'ninja', 'git', 'toolchainFile'].filter(key => values[key])]) {
    if (!path.isAbsolute(values[key])) throw new Error('Use an absolute path for ' + key + '.');
    values[key] = path.resolve(values[key]);
  }
  values.inputReceipts = values.inputReceipts.map(filename => {
    if (!path.isAbsolute(filename)) throw new Error('--input-receipt must be absolute.');
    return path.resolve(filename);
  });
  return values;
}

async function pinFile(filename) {
  const resolved = await fs.realpath(filename), info = await fs.stat(resolved);
  if (!info.isFile()) throw new Error('Expected a file: ' + filename);
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(resolved)) { hash.update(chunk); bytes += chunk.length; }
  return { filename: path.resolve(filename), realPath: resolved, bytes, sha256: hash.digest('hex') };
}
async function pinDirectory(directory) {
  const result = [], root = await fs.realpath(directory);
  async function visit(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : 1)) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Input trees cannot contain links: ' + filename);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) result.push({ relativePath: path.relative(root, filename).replaceAll('\\', '/'), ...await pinFile(filename) });
      else throw new Error('Input tree contains a non-file entry: ' + filename);
    }
  }
  await visit(root); return result;
}
const sameContent = (left, right) => left.length === right.length && left.every((file, index) => file.filename === right[index].filename && file.sha256 === right[index].sha256);
const contentDigest = files => createHash('sha256').update(JSON.stringify(files.map(({ filename, sha256 }) => ({ filename, sha256 })))).digest('hex');
const within = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export async function buildArchiveCodec(options) {
  const parent = await fs.realpath(path.dirname(options.buildRoot));
  const output = path.join(parent, path.basename(options.buildRoot)), actualRepository = await fs.realpath(repository);
  if (within(actualRepository, output) || within(output, actualRepository)) throw new Error('The build root must be outside the repository and cannot be its ancestor.');
  for (const directory of [options.sourceRoot, options.emCache, options.includeRoot].filter(Boolean)) {
    const actual = await fs.realpath(directory);
    if (within(actual, output) || within(output, actual)) throw new Error('The build root must be separate from input directories: ' + directory);
  }
  try { await fs.lstat(output); throw new Error('The create-only build root already exists: ' + output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported archive codec source manifest.');
  const manifestDirectory = path.dirname(fileURLToPath(manifestUrl));
  const pinned = [await pinFile(fileURLToPath(manifestUrl)), await pinFile(fileURLToPath(import.meta.url))];
  for (const descriptor of manifest.files) {
    const actual = await pinFile(path.resolve(manifestDirectory, descriptor.filename));
    if (actual.sha256 !== descriptor.sha256 || actual.bytes !== descriptor.bytes) throw new Error('Tracked codec input differs from its manifest: ' + descriptor.filename);
    pinned.push(actual);
  }
  for (const source of manifest.sourceArchives) {
    if (path.basename(source.archiveName) !== source.archiveName) throw new Error('Source archive names must be basenames.');
    const actual = await pinFile(path.join(options.sourceRoot, source.archiveName));
    if (actual.sha256 !== source.sha256 || actual.bytes !== source.bytes) throw new Error('Pinned source archive mismatch: ' + source.archiveName);
    pinned.push(actual);
  }
  for (const key of ['python', 'emcc', 'emConfig', ...(options.mode === 'build' ? ['emar', 'cmake', 'ninja', 'git', 'toolchainFile'] : ['archiveLib', 'zlibLib', 'bzip2Lib', 'lzmaLib'])]) pinned.push(await pinFile(options[key]));
  const emscriptenRoot = path.dirname(await fs.realpath(options.emcc));
  if (options.mode === 'build') {
    const suffix = process.platform === 'win32' ? await fs.stat(path.join(emscriptenRoot, 'emcc.exe')).then(() => '.exe', () => '.bat') : '';
    for (const name of ['emcc', 'em++', 'emar', 'emranlib', 'emnm', 'em-config']) pinned.push(await pinFile(path.join(emscriptenRoot, name + suffix)));
  }
  for (const filename of options.inputReceipts) pinned.push(await pinFile(filename));
  const includeInputs = options.mode === 'relink' ? await pinDirectory(options.includeRoot) : [];
  const cacheInputs = await pinDirectory(options.emCache);
  for (const file of [...pinned, ...includeInputs, ...cacheInputs]) {
    const relative = path.relative(output, file.realPath);
    if (relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('The build root must be separate from every input: ' + file.filename);
  }
  await fs.mkdir(output); // create-only, including for relink and failure cases
  if (await fs.realpath(path.dirname(output)) !== parent) throw new Error('The build root parent changed during creation.');
  const directories = ['inputs', 'sources', 'build', 'prefix', 'logs', 'payload', 'tmp'];
  for (const directory of directories) await fs.mkdir(path.join(output, directory));
  const inputs = { mode: options.mode, manifest: fileURLToPath(manifestUrl), files: pinned, includeInputs, cacheInputs,
    inputSha256: contentDigest([...pinned, ...includeInputs, ...cacheInputs]), sourceArchives: manifest.sourceArchives,
    note: options.mode === 'relink' ? 'Existing compiled library inputs are linked; this run does not rebuild or reconfigure their source packages.' : 'Four verified source archives are extracted into this fresh build root before patching and compilation.' };
  await fs.writeFile(path.join(output, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n', { flag: 'wx' });
  const environment = { ...process.env, EM_CONFIG: options.emConfig, EM_CACHE: options.emCache, EM_FROZEN_CACHE: '1',
    EMCC_SKIP_SANITY_CHECK: '1', EMSDK_PYTHON: options.python, PYTHONDONTWRITEBYTECODE: '1',
    TEMP: path.join(output, 'tmp'), TMP: path.join(output, 'tmp'), TMPDIR: path.join(output, 'tmp') };
  const commands = []; let currentChild, interrupted = false;
  const interrupt = () => { interrupted = true; currentChild?.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function run(executable, args, label, cwd = output) {
    if (interrupted) throw new Error('Archive codec build interrupted.');
    const ordinal = String(commands.length + 1).padStart(2, '0'), base = path.join(output, 'logs', ordinal + '-' + label);
    const stdout = await fs.open(base + '.stdout.txt', 'wx'), stderr = await fs.open(base + '.stderr.txt', 'wx');
    const command = { executable, args, cwd, label, stdout: base + '.stdout.txt', stderr: base + '.stderr.txt', startedAt: new Date().toISOString() };
    commands.push(command);
    await fs.writeFile(base + '.command.json', JSON.stringify(command, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write('Running ' + label + '; logs: ' + base + '\n');
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, env: environment, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
        currentChild = child;
        child.once('error', reject); child.once('close', (status, signal) => resolve({ status, signal }));
      });
      Object.assign(command, result, { finishedAt: new Date().toISOString() });
      await fs.writeFile(base + '.result.json', JSON.stringify(command, null, 2) + '\n', { flag: 'wx' });
      if (result.status !== 0) throw new Error(label + ' failed; inspect ' + base + '.stderr.txt');
    } finally { currentChild = undefined; await stdout.close(); await stderr.close(); }
  }
  const emscriptenCommand = (entry, args) => entry.toLowerCase().endsWith('.py') ? [options.python, [entry, ...args]] : [entry, args];
  const compile = (args, label) => { const [executable, parameters] = emscriptenCommand(options.emcc, args); return run(executable, parameters, label); };
  const archive = (args, label) => { const [executable, parameters] = emscriptenCommand(options.emar, args); return run(executable, parameters, label); };
  const prefix = path.join(output, 'prefix'), build = path.join(output, 'build');
  let archiveLibrary, zlibLibrary, bzip2Library, lzmaLibrary, includeDirectory, status = 'failed', error;
  try {
    await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, 'inputs', 'build-archive-codec.mjs'), fs.constants.COPYFILE_EXCL);
    await fs.copyFile(fileURLToPath(manifestUrl), path.join(output, 'inputs', 'archive-codec-sources.json'), fs.constants.COPYFILE_EXCL);
    for (const source of manifest.sourceArchives) await fs.copyFile(path.join(options.sourceRoot, source.archiveName), path.join(output, 'inputs', source.archiveName), fs.constants.COPYFILE_EXCL);
    for (const file of manifest.files) {
      const destination = path.join(output, 'inputs', path.basename(file.filename));
      await fs.copyFile(path.resolve(manifestDirectory, file.filename), destination, fs.constants.COPYFILE_EXCL);
    }
    if (options.mode === 'build') {
      for (const source of manifest.sourceArchives) await run(options.cmake, ['-E', 'tar', 'xzf', path.join(output, 'inputs', source.archiveName)], 'extract-' + source.name, path.join(output, 'sources'));
      for (const patch of manifest.patches) {
        const source = manifest.sourceArchives.find(value => value.name === patch.component), directory = path.join(output, 'sources', source.directory);
        const actual = await pinFile(path.join(directory, patch.member));
        if (actual.sha256 !== patch.originalSha256) throw new Error('Unexpected unpatched source: ' + patch.member);
        await run(options.git, ['-c', 'core.autocrlf=false', 'apply', '--whitespace=error-all', path.join(output, 'inputs', path.basename(patch.filename))], 'patch-' + path.basename(patch.filename), directory);
        if ((await pinFile(path.join(directory, patch.member))).sha256 !== patch.patchedSha256) throw new Error('Patched source mismatch: ' + patch.member);
      }
      const common = ['-G', 'Ninja', '-DCMAKE_MAKE_PROGRAM=' + options.ninja, '-DCMAKE_TOOLCHAIN_FILE=' + options.toolchainFile,
        '-DEMSCRIPTEN_ROOT_PATH=' + emscriptenRoot,
        '-DCMAKE_INSTALL_PREFIX=' + prefix, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF'];
      const sourceDirectory = name => path.join(output, 'sources', manifest.sourceArchives.find(value => value.name === name).directory);
      async function configure(name, extra) {
        await run(options.cmake, ['-S', sourceDirectory(name), '-B', path.join(build, name), ...common, ...extra], 'configure-' + name);
        await run(options.cmake, ['--build', path.join(build, name), '--parallel', String(options.jobs), '--target', 'install'], 'build-' + name);
      }
      await configure('zlib', ['-DZLIB_BUILD_EXAMPLES=OFF']);
      await configure('xz', ['-DXZ_THREADS=no', '-DXZ_TOOL_XZ=OFF', '-DXZ_TOOL_XZDEC=OFF', '-DXZ_TOOL_LZMADEC=OFF',
        '-DXZ_TOOL_LZMAINFO=OFF', '-DXZ_TOOL_SCRIPTS=OFF', '-DXZ_DOC=OFF', '-DXZ_NLS=OFF', '-DBUILD_TESTING=OFF']);
      const bzipDirectory = path.join(build, 'bzip2'); await fs.mkdir(bzipDirectory);
      const bzipSources = ['blocksort', 'huffman', 'crctable', 'randtable', 'compress', 'decompress', 'bzlib'];
      for (const name of bzipSources) await compile(['-O3', '-c', path.join(sourceDirectory('bzip2'), name + '.c'), '-o', path.join(bzipDirectory, name + '.o')], 'compile-bzip2-' + name);
      bzip2Library = path.join(bzipDirectory, 'libbz2.a');
      await archive(['rcs', bzip2Library, ...bzipSources.map(name => path.join(bzipDirectory, name + '.o'))], 'archive-bzip2');
      zlibLibrary = path.join(prefix, 'lib', 'libz.a'); lzmaLibrary = path.join(prefix, 'lib', 'liblzma.a'); includeDirectory = path.join(prefix, 'include');
      const off = ['OPENSSL', 'MD', 'LIBB2', 'LZ4', 'LZO', 'ZSTD', 'LIBXML2', 'BSDXML', 'EXPAT', 'WIN32_XMLLITE', 'PCREPOSIX',
        'PCRE2POSIX', 'LIBGCC', 'CNG', 'TAR', 'CPIO', 'CAT', 'UNZIP', 'XATTR', 'ACL', 'TEST', 'ICONV', 'MBEDTLS', 'NETTLE'];
      await configure('libarchive', [...off.map(name => '-DENABLE_' + name + '=OFF'), '-DENABLE_ZLIB=ON', '-DENABLE_BZip2=ON', '-DENABLE_LZMA=ON',
        '-DCMAKE_PREFIX_PATH=' + prefix, '-DZLIB_LIBRARY=' + zlibLibrary, '-DZLIB_INCLUDE_DIR=' + includeDirectory,
        '-DLIBLZMA_LIBRARY=' + lzmaLibrary, '-DLIBLZMA_INCLUDE_DIR=' + includeDirectory,
        '-DBZIP2_LIBRARY_RELEASE=' + bzip2Library, '-DBZIP2_INCLUDE_DIR=' + sourceDirectory('bzip2')]);
      archiveLibrary = path.join(prefix, 'lib', 'libarchive.a');
    } else {
      const supplied = [['archiveLib', 'libarchive.a'], ['zlibLib', 'libz.a'], ['bzip2Lib', 'libbz2.a'], ['lzmaLib', 'liblzma.a']];
      for (const [key, basename] of supplied) await fs.copyFile(options[key], path.join(build, basename), fs.constants.COPYFILE_EXCL);
      [archiveLibrary, zlibLibrary, bzip2Library, lzmaLibrary] = supplied.map(([, basename]) => path.join(build, basename));
      includeDirectory = options.includeRoot;
    }
    const bridge = path.join(output, 'inputs', path.basename(manifest.bridge.filename)), payload = path.join(output, 'payload', 'archive-codec.mjs');
    await compile([bridge, '-I' + includeDirectory, archiveLibrary, zlibLibrary, bzip2Library, lzmaLibrary, '-O3',
      '-Wl,-Map=' + path.join(output, 'link.map'), '-o', payload,
      '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node', '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=4194304',
      '-sEXPORTED_FUNCTIONS=["_malloc","_free","_mm_rar4_independent"]', '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]'], 'link-codec');
    status = 'succeeded';
  } catch (failure) { error = { name: failure.name, message: failure.message }; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  const after = await Promise.all(pinned.map(file => pinFile(file.filename)));
  const includeAfter = options.mode === 'relink' ? await pinDirectory(options.includeRoot) : [];
  const cacheAfter = await pinDirectory(options.emCache);
  const inputsUnchanged = sameContent(pinned, after) && sameContent(includeInputs, includeAfter) && sameContent(cacheInputs, cacheAfter);
  const outputs = [];
  for (const filename of [path.join(output, 'payload', 'archive-codec.mjs'), path.join(output, 'payload', 'archive-codec.wasm'), path.join(output, 'link.map'), archiveLibrary, zlibLibrary, bzip2Library, lzmaLibrary].filter(Boolean)) {
    try { outputs.push(await pinFile(filename)); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  const receipt = { schemaVersion: 1, mode: options.mode, outputRoot: output, status, passed: status === 'succeeded' && inputsUnchanged,
    scope: options.mode === 'build' ? 'Fresh source-package configure/build/link execution.' : 'Actual relink of explicitly supplied compiled inputs; source-package configure/build was not executed in this run.',
    inputsUnchanged, inputSha256: inputs.inputSha256, commands, outputs, error,
    environment: { EM_CONFIG: options.emConfig, EM_CACHE: options.emCache, EM_FROZEN_CACHE: '1', EMCC_SKIP_SANITY_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' } };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  if (!receipt.passed) throw new Error('Archive codec build failed; inspect ' + path.join(output, 'receipt.json'));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else { const receipt = await buildArchiveCodec(options); process.stdout.write(JSON.stringify({ passed: receipt.passed, mode: receipt.mode, receipt: path.join(options.buildRoot, 'receipt.json') }) + '\n'); }
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
