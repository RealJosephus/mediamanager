import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, appendFile, lstat, mkdir, open, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTorrent, safeMember, verifyTorrentFiles } from './torrent.js';
import { downloadOriginalIso } from './http-source.js';

const options = {}, optionErrors = [];
const optionNames = ['--source', '--output', '--torrent-tool', '--archive-tool', '--disc-tool'];
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!optionNames.includes(key)) { optionErrors.push({ option: key, reason: 'unknown-option' }); continue; }
  if (Object.hasOwn(options, key)) { optionErrors.push({ option: key, reason: 'duplicate-option' }); continue; }
  options[key] = value ?? null;
  if (!value || value.startsWith('--')) optionErrors.push({ option: key, reason: 'missing-value' });
}
const sourceId = options['--source'], descriptors = { sintel: 'sintel.json', avchdcoder: 'source.json' };
if (!Object.hasOwn(descriptors, sourceId)) optionErrors.push({ option: '--source', reason: 'unknown-source', value: sourceId ?? null });
for (const key of ['--source', '--output', '--archive-tool', '--disc-tool', ...(sourceId === 'avchdcoder' ? ['--torrent-tool'] : [])]) {
  if (!Object.hasOwn(options, key)) optionErrors.push({ option: key, reason: 'missing-option' });
}
if (sourceId !== 'avchdcoder' && Object.hasOwn(options, '--torrent-tool')) {
  optionErrors.push({ option: '--torrent-tool', reason: 'tool-not-used-by-selected-source' });
}
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Original Blu-ray acquisition runs only in GitHub Actions.');
assert.ok(process.env.RUNNER_TEMP && options['--output']);
const temporaryRoot = await realpath(process.env.RUNNER_TEMP), output = path.resolve(options['--output']);
const relative = path.relative(temporaryRoot, output);
assert.ok(relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
assert.equal(await realpath(path.dirname(output)), temporaryRoot, 'Use a fresh direct child of RUNNER_TEMP.');
await mkdir(output);
const evidence = path.join(output, 'evidence'), work = path.join(output, 'work'), media = path.join(output, 'media');
await mkdir(evidence); await mkdir(work); await mkdir(media);
const descriptorFilename = Object.hasOwn(descriptors, sourceId) ? descriptors[sourceId] : null;
const descriptor = descriptorFilename ? await readFile(new URL('./' + descriptorFilename, import.meta.url)) : null;
const source = descriptor ? JSON.parse(descriptor) : null;
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const state = { startedAt: new Date().toISOString(), phase: 'starting', sourceId: sourceId ?? null,
  source: source?.title ?? null, descriptorSha256: descriptor ? hash(descriptor) : null,
  sourceComplete: false, originalBdmvExtracted: false, passed: false, http: [], processes: [], tools: {}, errors: [],
  optionErrors, toolBindingErrors: [],
  fullInstanceVerified: false, completeLibraryVerified: false, productionScaleVerified: false, phaseAcceptance: false, releaseAcceptance: false };
const save = () => writeFile(path.join(evidence, 'acquisition.json'), json(state));
const phase = async value => { state.phase = value; console.log('Original disc acquisition: ' + value + '.'); await save(); };
const deadline = AbortSignal.timeout(55 * 60_000);
if (descriptor) await writeFile(path.join(evidence, 'source.json'), descriptor, { flag: 'wx' });

async function smallDownload(url, purpose, limit = 1024 * 1024) {
  const allowed = new Set([source.publisherUrl, source.torrent?.url, source.iso?.url, source.iso?.md5Url, source.sharingUrl,
    ...source.movies.map(movie => movie.primarySource)].filter(Boolean).map(value => new URL(value).hostname));
  let current = new URL(url);
  for (let redirect = 0; redirect <= 6; redirect++) {
    assert.ok(current.protocol === 'https:' && allowed.has(current.hostname) && !current.username && !current.password);
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(60000)]),
      headers: { 'User-Agent': 'MediaManager-original-disc-reference/1', 'Accept-Encoding': 'identity' } });
    const observation = { purpose, url: current.href, status: response.status, receivedAt: new Date().toISOString(),
      headers: Object.fromEntries(['content-type', 'content-length', 'content-encoding', 'last-modified', 'etag', 'location']
        .filter(name => response.headers.has(name)).map(name => [name, response.headers.get(name)])) };
    state.http.push(observation); await save();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); current = new URL(response.headers.get('location'), current); continue;
    }
    assert.equal(response.status, 200, purpose + ' could not be read.');
    const chunks = []; let bytes = 0;
    for await (const value of response.body) {
      bytes += value.length; assert.ok(bytes <= limit, 'Original-source metadata exceeded its size limit.'); chunks.push(Buffer.from(value));
    }
    const result = Buffer.concat(chunks), filename = 'metadata-' + purpose.toLowerCase().replace(/[^a-z0-9]+/gu, '-') + '.body';
    await writeFile(path.join(evidence, filename), result, { flag: 'wx' });
    Object.assign(observation, { filename, bytes, sha256: hash(result) }); await save(); return result;
  }
  throw new Error('Original-source metadata exceeded its redirect limit.');
}

async function fileDigest(filename, { includeMd5 = false } = {}) {
  const before = await lstat(filename); assert.ok(before.isFile() && !before.isSymbolicLink());
  const sha256 = createHash('sha256'), md5 = includeMd5 ? createHash('md5') : null; let bytes = 0;
  for await (const chunk of createReadStream(filename, { signal: deadline })) { bytes += chunk.length; sha256.update(chunk); md5?.update(chunk); }
  const after = await lstat(filename); assert.equal(bytes, before.size); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  return { bytes, sha256: sha256.digest('hex'), ...(md5 ? { md5: md5.digest('hex') } : {}) };
}

async function command(label, executable, args, timeoutMs = 120000) {
  const observation = { label, executable, args, startedAt: new Date().toISOString(), timeoutMs, passed: false };
  state.processes.push(observation); await save();
  const child = spawn(executable, args, { cwd: work, shell: false, windowsHide: true,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TMPDIR: work, TMP: work, TEMP: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let outputBytes = 0, failure, forced;
  const stop = error => {
    failure ??= error;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); forced ??= setTimeout(() => child.kill('SIGKILL'), 10000);
    }
  };
  child.once('error', error => { failure ??= error; });
  const receive = parts => chunk => { outputBytes += chunk.length; if (outputBytes <= 4 * 1024 * 1024) parts.push(Buffer.from(chunk));
    else stop(new Error(label + ' exceeded its bounded diagnostic output.')); };
  child.stdout.on('data', receive(stdout)); child.stderr.on('data', receive(stderr));
  const timer = setTimeout(() => stop(new Error(label + ' exceeded its acquisition deadline.')), timeoutMs);
  const abort = () => stop(deadline.reason); deadline.addEventListener('abort', abort, { once: true });
  if (deadline.aborted) abort();
  try {
    await new Promise(resolve => child.once('close', (code, signal) => { Object.assign(observation, { code, signal }); resolve(); }));
  } finally { clearTimeout(timer); clearTimeout(forced); deadline.removeEventListener('abort', abort); }
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  await writeFile(path.join(evidence, label + '.stdout.txt'), out, { flag: 'wx' });
  await writeFile(path.join(evidence, label + '.stderr.txt'), err, { flag: 'wx' });
  Object.assign(observation, { pid: child.pid, finishedAt: new Date().toISOString(), passed: !failure && observation.code === 0,
    stdout: { bytes: out.length, sha256: hash(out) }, stderr: { bytes: err.length, sha256: hash(err) },
    ...(failure ? { error: { name: failure.name, message: failure.message } } : {}) });
  await save(); assert.equal(observation.passed, true, label + ' failed; inspect its original process receipt.');
  return out.toString('utf8');
}

function archiveMembers(listing) {
  const members = [];
  for (const block of listing.split(/(?=^Path = )/mu)) {
    const fields = Object.fromEntries(block.split(/\r?\n/u).map(line => /^([^=]+?) = (.*)$/u.exec(line))
      .filter(Boolean).map(match => [match[1], match[2]]));
    if (!fields.Path || fields.Type) continue;
    const name = safeMember(fields.Path.replaceAll('\\', '/'));
    assert.ok(!fields['Symbolic Link'] && !fields['Hard Link']);
    const directory = fields.Folder === '+' || /^D/u.test(fields.Attributes ?? '');
    const bytes = Number(fields.Size); assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
    members.push({ path: name, kind: directory ? 'directory' : 'file', bytes });
  }
  assert.ok(members.length > 0 && members.length < 100000); assert.equal(new Set(members.map(member => member.path)).size, members.length);
  assert.ok(members.reduce((sum, member) => sum + member.bytes, 0) < 3 * (source.iso?.bytes ?? source.torrent.files[0].bytes));
  return members;
}

async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = safeMember(prefix ? prefix + '/' + entry.name : entry.name), filename = path.join(directory, entry.name);
    const info = await lstat(filename); assert.ok(!info.isSymbolicLink());
    if (info.isDirectory()) result.push({ path: relative, kind: 'directory', bytes: 0 }, ...await inventory(filename, relative));
    else { assert.ok(info.isFile()); result.push({ path: relative, kind: 'file', ...await fileDigest(filename) }); }
  }
  return result;
}

try {
  await phase('bind-real-tools');
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  state.producer = { identity: Object.fromEntries(['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_JOB', 'RUNNER_OS', 'RUNNER_ARCH'].map(name => {
    assert.ok(process.env[name], 'Missing acquisition identity ' + name); return [name, process.env[name]];
  })), files: [] };
  for (const relative of ['tools/ci/bluray-reference/acquire.js', 'tools/ci/bluray-reference/torrent.js',
    'tools/ci/bluray-reference/http-source.js', '.github/workflows/bluray-reference.yml',
    ...(descriptorFilename ? ['tools/ci/bluray-reference/' + descriptorFilename] : [])]) {
    state.producer.files.push({ path: relative, ...await fileDigest(path.join(repository, relative)) });
  }
  for (const [name, option] of [...(sourceId === 'avchdcoder' ? [['torrent', '--torrent-tool']] : []),
    ['archive', '--archive-tool'], ['disc', '--disc-tool']]) {
    const binding = { requestedPath: options[option] ?? null, available: false };
    state.tools[name] = binding;
    try {
      assert.ok(options[option] && path.isAbsolute(options[option]), name + ' requires an explicit absolute executable path.');
      const filename = await realpath(options[option]);
      Object.assign(binding, { filename, ...await fileDigest(filename) });
      await access(filename, constants.X_OK);
      const handle = await open(filename, 'r');
      try {
        const magic = Buffer.alloc(4), { bytesRead } = await handle.read(magic, 0, magic.length, 0);
        binding.magic = magic.subarray(0, bytesRead).toString('hex');
        assert.equal(binding.magic, '7f454c46', name + ' must bind the actual ELF executable, not a launcher script.');
      } finally { await handle.close(); }
      binding.available = true;
    } catch (error) {
      binding.error = { name: error.name, message: error.message, code: error.code };
      state.toolBindingErrors.push({ tool: name, option, ...binding });
    }
    await save();
  }
  assert.equal(optionErrors.length, 0, 'Invalid acquisition options: ' + json(optionErrors));
  assert.equal(state.toolBindingErrors.length, 0, 'Required acquisition tools are missing or invalid: ' + json(state.toolBindingErrors));
  state.originalSourceMetadata = [];
  for (const metadata of source.metadata ?? []) {
    safeMember(metadata.path);
    const relative = 'tools/ci/bluray-reference/' + metadata.path;
    const actual = await fileDigest(path.join(repository, relative));
    assert.deepEqual(actual, { bytes: metadata.bytes, sha256: metadata.sha256 }, 'An original source metadata input changed.');
    state.originalSourceMetadata.push(metadata);
    state.producer.files.push({ path: relative, ...actual });
    await writeFile(path.join(evidence, 'original-' + path.basename(metadata.path)), await readFile(path.join(repository, relative)), { flag: 'wx' });
  }
  if (source.metadata?.length) {
    const relative = 'tools/ci/bluray-reference/metadata/.gitattributes';
    state.producer.files.push({ path: relative, ...await fileDigest(path.join(repository, relative)) });
  }
  for (const [name, binding] of Object.entries(state.tools)) {
    const filename = binding.filename;
    const linked = await command(name + '-linked-libraries', '/usr/bin/ldd', [filename]);
    const dependencies = [];
    for (const line of linked.split(/\r?\n/u)) {
      const target = /(?:=>\s*|^\s*)(\/\S+)\s+\(/u.exec(line)?.[1];
      if (target) { const dependency = await realpath(target); dependencies.push({ filename: dependency, ...await fileDigest(dependency) }); }
    }
    assert.ok(dependencies.length > 0, 'The actual ELF tool dependencies must be observed.'); state.tools[name].dependencies = dependencies;
  }
  if (state.tools.torrent) await command('torrent-version', state.tools.torrent.filename, ['--version']);
  await command('archive-formats', state.tools.archive.filename, ['i']);
  await phase('observe-primary-publisher-and-movie-licenses');
  for (const [purpose, url] of [['publisher', source.publisherUrl], ...source.movies.map(movie => [movie.title + ' license', movie.primarySource]),
    ...(source.sharingUrl ? [['sharing terms', source.sharingUrl]] : [])]) {
    // Current page digests are observations; timestamps/layout are not a new
    // license condition or a substitute for the cited publisher permission.
    await smallDownload(url, purpose);
  }
  const requiredOriginalBytes = source.iso?.bytes ?? source.torrent.files.reduce((sum, file) => sum + file.bytes, 0);
  const disk = await statfs(output, { bigint: true }); state.availableBytes = String(disk.bavail * disk.bsize);
  assert.ok(disk.bavail * disk.bsize > BigInt(requiredOriginalBytes) * 4n, 'The runner must retain the entire original and full extracted disc.');
  let iso, originals, originalMds;
  if (source.iso) {
    await phase('bind-original-publisher-iso-checksum');
    safeMember(source.iso.filename); assert.equal(source.iso.filename.includes('/'), false);
    const checksumBytes = await smallDownload(source.iso.md5Url, 'original ISO MD5', 4096);
    const checksum = /^MD5 \(([^\r\n]+)\) = ([a-f0-9]{32})\s*$/iu.exec(checksumBytes.toString('utf8'));
    assert.ok(checksum, 'The original adjacent publisher MD5 is not recognized.');
    assert.equal(checksum[1], source.iso.filename); assert.equal(checksum[2].toLowerCase(), source.iso.md5);
    await phase('download-complete-original-https-iso');
    originals = work; iso = path.join(originals, source.iso.filename);
    state.isoDownload = await downloadOriginalIso(source.iso, iso, { signal: deadline, timeoutMinutes: source.downloadTimeoutMinutes,
      onResponse: async response => { state.http.push(response); await save(); },
      onProgress: async progress => { state.isoDownload = progress; await save(); } });
    await phase('independently-reread-complete-original-iso');
    const observed = await fileDigest(iso, { includeMd5: true });
    assert.deepEqual(observed, { bytes: source.iso.bytes, sha256: state.isoDownload.sha256, md5: source.iso.md5 });
    state.originals = { transport: 'official-https', files: [{ path: source.iso.filename, ...observed }],
      totalBytes: observed.bytes, publisherMd5Verified: true, independentDiskHashVerified: true,
      frozenSha256Verified: source.iso.sha256 != null, firstObservedSha256: source.iso.sha256 == null };
  } else {
    await phase('bind-original-torrent');
    const torrentBytes = await smallDownload(source.torrent.url, 'original torrent', 128 * 1024);
    const torrent = readTorrent(torrentBytes, source.torrent), torrentFile = path.join(evidence, 'original.torrent');
    await writeFile(torrentFile, torrentBytes, { flag: 'wx' });
    state.torrent = { name: torrent.name, infoHash: torrent.infoHash, files: torrent.files, announces: torrent.announces,
      metadata: torrent.metadata, pieces: source.torrent.piecesCount, pieceLength: torrent.pieceLength, totalBytes: torrent.totalBytes, rawMetadataSha256: hash(torrentBytes) };
    await phase('download-complete-original-torrent');
    await command('torrent-download', state.tools.torrent.filename, ['--no-conf=true', '--no-netrc=true', '--dir=' + work,
      '--dht-file-path=' + path.join(work, 'dht.dat'), '--dht-file-path6=' + path.join(work, 'dht6.dat'),
      '--file-allocation=none', '--check-integrity=true',
      '--seed-time=0', '--seed-ratio=0', '--enable-color=false', '--console-log-level=warn', '--summary-interval=60',
      '--download-result=full', '--allow-overwrite=false', '--auto-file-renaming=false', '--bt-stop-timeout=300',
      '--max-upload-limit=128K', '--stop=' + String(source.downloadTimeoutMinutes * 60), torrentFile], source.downloadTimeoutMinutes * 60_000 + 10000);
    await phase('independently-verify-every-original-piece');
    originals = path.join(work, torrent.name);
    state.originals = await verifyTorrentFiles(originals, torrent, { signal: deadline });
    iso = path.join(originals, source.torrent.files[0].path);
    originalMds = path.join(originals, source.torrent.files[1].path);
  }
  state.sourceComplete = true; await save();
  await phase('read-test-and-extract-complete-original-udf');
  const listing = await command('iso-members', state.tools.archive.filename, ['l', '-slt', iso]);
  assert.match(listing, /Type = Udf\b/iu, 'The original must be readable as an actual UDF disc.');
  const members = archiveMembers(listing); await writeFile(path.join(evidence, 'original-members.json'), json(members), { flag: 'wx' });
  await command('iso-test', state.tools.archive.filename, ['t', '-y', iso], 10 * 60_000);
  await command('iso-extract', state.tools.archive.filename, ['x', '-y', '-o' + media, iso], 10 * 60_000);
  const actual = (await inventory(media)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const expected = members.filter(member => member.kind === 'file').map(({ path, bytes }) => ({ path, bytes })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assert.deepEqual(actual.filter(member => member.kind === 'file').map(({ path, bytes }) => ({ path, bytes })), expected,
    'Every original ISO file is extracted, without creating replacement media or directories.');
  assert.deepEqual(actual.filter(member => member.kind === 'directory').map(member => member.path).sort(),
    members.filter(member => member.kind === 'directory').map(member => member.path).sort(), 'Every original empty or populated directory is retained.');
  const index = actual.filter(member => member.kind === 'file' && /(?:^|\/)BDMV\/index\.bdmv$/iu.test(member.path));
  assert.equal(index.length, 1, 'The complete original must expose exactly one BDMV index.');
  const bdmv = index[0].path.slice(0, -'/index.bdmv'.length), bdmvFiles = actual.filter(member => member.kind === 'file' && member.path.startsWith(bdmv + '/'));
  for (const pattern of [/^MovieObject\.bdmv$/iu, /^PLAYLIST\/[^/]+\.mpls$/iu, /^CLIPINF\/[^/]+\.clpi$/iu, /^STREAM\/[^/]+\.m2ts$/iu]) {
    assert.ok(bdmvFiles.some(member => pattern.test(member.path.slice(bdmv.length + 1)) && member.bytes > 0), 'The original BDMV structure is incomplete: ' + pattern);
  }
  await writeFile(path.join(evidence, 'complete-files.json'), json(actual), { flag: 'wx' });
  await writeFile(path.join(evidence, 'bdmv-files.json'), json(bdmvFiles), { flag: 'wx' });
  const discRoot = path.dirname(path.join(media, ...bdmv.split('/')));
  const discInfo = await command('libbluray-disc-info', state.tools.disc.filename, [discRoot]);
  assert.match(discInfo, /Blu-?ray\s+detected\s*:\s*(?:yes|1|true)\b/iu, 'The real disc reader must detect the extracted BDMV.');
  state.media = { originalIso: iso, ...(originalMds ? { originalMds } : {}), discRoot,
    bdmvRoot: path.join(media, ...bdmv.split('/')), completeFiles: actual.filter(member => member.kind === 'file').length,
    bdmvFiles: bdmvFiles.length, bdmvBytes: bdmvFiles.reduce((sum, file) => sum + file.bytes, 0), format: source.format, scope: source.scope };
  for (const tool of Object.values(state.tools)) for (const value of [tool, ...tool.dependencies]) {
    assert.deepEqual(await fileDigest(value.filename), { bytes: value.bytes, sha256: value.sha256 });
  }
  for (const file of state.producer.files) assert.deepEqual(await fileDigest(path.join(repository, file.path)),
    { bytes: file.bytes, sha256: file.sha256 });
  for (const file of state.originals.files) {
    assert.deepEqual(await fileDigest(path.join(originals, ...file.path.split('/')), { includeMd5: Object.hasOwn(file, 'md5') }),
      { bytes: file.bytes, sha256: file.sha256, ...(file.md5 ? { md5: file.md5 } : {}) }, 'The original media changed during full UDF verification.');
  }
  state.originalBdmvExtracted = true; state.passed = true; await phase('complete-original-ready-for-same-run-consumer');
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, 'MEDIAMANAGER_TEST_BLURAY_ISO=' + iso
    + '\nMEDIAMANAGER_TEST_BDMV_ROOT=' + state.media.bdmvRoot + '\nMEDIAMANAGER_TEST_BLURAY_DISC_ROOT=' + discRoot + '\n');
} catch (error) {
  state.errors.push({ name: error.name, message: error.message, stack: error.stack, code: error.code });
  state.passed = false; process.exitCode = 1;
} finally {
  state.finishedAt = new Date().toISOString(); await save();
  console.log(state.passed ? 'Complete original disc BDMV verified; media remains on the runner.'
    : 'Original disc acquisition failed or remains incomplete; no source-availability claim is made.');
}
