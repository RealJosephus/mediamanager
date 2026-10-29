import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { archiveFailureObservation, downloadOriginalArchiveIso } from './http-source.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const descriptorFilename = fileURLToPath(new URL('./source.json', import.meta.url));
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ordered = values => values.toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const json = value => JSON.stringify(value, null, 2) + '\n';
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  assert.ok(['--variant', '--output', '--archive-tool'].includes(name) && process.argv[index + 1]
    && !Object.hasOwn(options, name), 'Supply one value for each supported acquisition option.');
  options[name] = process.argv[index + 1];
}
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Original disc acquisition must run in GitHub Actions.');
assert.ok(process.env.RUNNER_TEMP && options['--output'] && options['--archive-tool'], 'Supply isolated output and an actual archive executable.');
const temporaryRoot = await realpath(process.env.RUNNER_TEMP);
const output = path.resolve(options['--output']);
const relativeOutput = path.relative(temporaryRoot, output);
assert.ok(relativeOutput && !path.isAbsolute(relativeOutput) && !relativeOutput.split(path.sep).includes('..'),
  'Disc acquisition output must be a fresh directory inside RUNNER_TEMP.');
await mkdir(output);
const evidence = path.join(output, 'evidence'), work = path.join(output, 'work'), media = path.join(output, 'media');
await mkdir(evidence); await mkdir(work); await mkdir(media);
const state = { passed: false, phase: 'starting', startedAt: new Date().toISOString(),
  sourceComplete: false, payloadComplete: false, sourceArchiveRetained: false,
  evidenceRoot: evidence, mediaRoot: media, http: [], processes: [], disks: [], errors: [] };
const save = () => writeFile(path.join(evidence, 'acquisition.json'), json(state));
const phase = async name => { state.phase = name; console.log(`Original DVD acquisition: ${name}.`); await save(); };
const deadline = AbortSignal.timeout(100 * 60_000);

async function fileHashes(filename, algorithms = ['sha256']) {
  const before = await lstat(filename);
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Bound inputs must be regular files.');
  const hashes = algorithms.map(name => [name, createHash(name)]);
  let bytes = 0;
  for await (const chunk of createReadStream(filename, { signal: deadline })) {
    bytes += chunk.length;
    for (const [, digest] of hashes) digest.update(chunk);
  }
  const after = await lstat(filename);
  assert.equal(bytes, before.size); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  return { bytes, ...Object.fromEntries(hashes.map(([name, digest]) => [name, digest.digest('hex')])) };
}

async function disk(when, requiredBytes) {
  const values = await statfs(output, { bigint: true });
  const availableBytes = values.bavail * values.bsize;
  state.disks.push({ when, availableBytes: availableBytes.toString(), requiredBytes: String(requiredBytes) });
  await save();
  assert.ok(availableBytes >= BigInt(requiredBytes), `Insufficient free space for complete disc acquisition at ${when}.`);
}

function archiveUrl(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password
    && (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')), 'Disc downloads must remain on HTTPS Internet Archive origins.');
  return url;
}

async function fetchArchive(url, purpose) {
  let current = archiveUrl(url);
  for (let redirects = 0; redirects <= 8; redirects++) {
    const response = await fetch(current, { redirect: 'manual', signal: deadline,
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'MediaManager-original-disc-validation/1' } });
    const observation = { purpose, url: current.href, status: response.status,
      headers: Object.fromEntries(response.headers), receivedAt: new Date().toISOString() };
    state.http.push(observation); await save();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      assert.ok(response.headers.get('location'), 'Disc download redirect is missing Location.');
      current = archiveUrl(new URL(response.headers.get('location'), current));
      continue;
    }
    assert.equal(response.status, 200, `The original ${purpose} request failed.`);
    assert.ok(!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity',
      'Original disc bytes must not have a transport content encoding.');
    assert.ok(response.body, `The original ${purpose} response is empty.`);
    return { response, observation };
  }
  throw new Error('Original disc download exceeded its redirect limit.');
}

async function smallBody(response, limit) {
  const chunks = []; let bytes = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value); bytes += chunk.length;
    assert.ok(bytes <= limit, 'Archive metadata exceeded its bounded response size.'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function command(label, executable, arguments_, timeoutMs = 30 * 60_000) {
  const stdoutFilename = path.join(evidence, `${label}.stdout.txt`), stderrFilename = path.join(evidence, `${label}.stderr.txt`);
  const record = { label, executable, arguments: arguments_, startedAt: new Date().toISOString(),
    stdoutFilename, stderrFilename, timeoutMs, exitCode: null, signal: null, passed: false };
  state.processes.push(record); await save();
  const child = spawn(executable, arguments_, { cwd: work, windowsHide: true, shell: false,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure;
  const fail = error => { failure ??= error; child.kill('SIGKILL'); };
  child.once('error', fail);
  const timer = setTimeout(() => fail(new Error(`Archive command ${label} exceeded its provisioning limit.`)), timeoutMs);
  const abort = () => fail(deadline.reason); deadline.addEventListener('abort', abort, { once: true });
  const closed = new Promise(resolve => child.once('close', (code, signal) => { record.exitCode = code; record.signal = signal; resolve(); }));
  const copy = (stream, filename) => {
    let bytes = 0;
    const bounded = new Transform({ transform(chunk, encoding, next) {
      bytes += chunk.length;
      next(bytes > 16 * 1024 * 1024 ? new Error(`Archive ${label} output exceeded 16 MiB.`) : null, chunk);
    } });
    return pipeline(stream, bounded, createWriteStream(filename, { flags: 'wx' })).catch(error => { fail(error); throw error; });
  };
  const results = await Promise.allSettled([closed, copy(child.stdout, stdoutFilename), copy(child.stderr, stderrFilename)]);
  clearTimeout(timer); deadline.removeEventListener('abort', abort);
  record.completedAt = new Date().toISOString();
  for (const result of results) if (result.status === 'rejected') failure ??= result.reason;
  if (!failure && record.exitCode !== 0) failure = new Error(`Archive command ${label} exited with ${record.exitCode} (${record.signal ?? 'no signal'}).`);
  record.stdout = await fileHashes(stdoutFilename); record.stderr = await fileHashes(stderrFilename);
  record.passed = !failure; if (failure) record.error = { name: failure.name, message: failure.message };
  await save(); if (failure) throw failure;
  return { stdout: await readFile(stdoutFilename), stderr: await readFile(stderrFilename) };
}

function memberPath(raw) {
  assert.ok(raw && !/[\\:\r\n\0]/u.test(raw) && !raw.startsWith('/'), 'Unsafe original ISO member path.');
  const value = raw.replace(/^(?:\.\/)+/u, '').replace(/\/$/u, '');
  if (!value || value === '.') return '.';
  assert.ok(value.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe original ISO member component.');
  return value;
}

function parseMembers(namesBytes, verboseBytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines = bytes => decoder.decode(bytes).split(/\r?\n/u).filter(Boolean);
  const names = lines(namesBytes).map(memberPath);
  const members = lines(verboseBytes).map(line => {
    const match = /^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d{1,2}\s+\S+\s+(.+)$/u.exec(line);
    assert.ok(match, 'Cannot consume the complete ISO member listing; preserve the original listing for diagnosis.');
    const bytes = Number(match[2]); assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
    return { path: memberPath(match[3]), type: match[1][0] === '-' ? 'file' : match[1][0] === 'd' ? 'directory' : match[1][0], bytes };
  });
  assert.deepEqual(members.map(value => value.path), names, 'The complete simple and detailed ISO member lists must agree.');
  return members;
}

function videoMembers(members, directory) {
  const selected = members.filter(value => value.path === directory || value.path.startsWith(directory + '/'));
  assert.ok(selected.length, 'The original image has no complete VIDEO_TS tree.');
  const exact = new Map(), folded = new Set();
  for (const member of selected) {
    assert.ok(['file', 'directory'].includes(member.type), 'VIDEO_TS must contain only original regular files and directories.');
    assert.ok(!folded.has(member.path.toLowerCase()), 'Original VIDEO_TS has duplicate or case-colliding members.');
    exact.set(member.path, member); folded.add(member.path.toLowerCase());
  }
  for (const member of selected) {
    let parent = path.posix.dirname(member.path);
    while (parent !== '.') {
      if (exact.has(parent)) assert.equal(exact.get(parent).type, 'directory');
      else exact.set(parent, { path: parent, type: 'directory', bytes: 0 });
      parent = path.posix.dirname(parent);
    }
  }
  assert.equal(exact.get(`${directory}/VIDEO_TS.IFO`)?.type, 'file', 'The original DVD manager IFO is required.');
  assert.equal(exact.get(`${directory}/VIDEO_TS.BUP`)?.type, 'file', 'The original DVD manager backup is required.');
  assert.ok(selected.some(value => value.type === 'file' && /\/VTS_\d{2}_0\.IFO$/u.test(value.path)), 'The original DVD title-set IFO is required.');
  assert.ok(selected.some(value => value.type === 'file' && /\.VOB$/u.test(value.path)), 'The original DVD video objects are required.');
  return ordered([...exact.values()]);
}

async function inventory(directory, relative = '') {
  const values = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const member = relative ? relative + '/' + entry.name : entry.name;
    assert.equal(memberPath(member), member);
    const filename = path.join(directory, ...member.split('/'));
    const properties = await lstat(filename);
    assert.ok(!properties.isSymbolicLink(), 'Extracted VIDEO_TS must not contain links.');
    if (properties.isDirectory()) {
      values.push({ path: member, type: 'directory', bytes: 0 }); values.push(...await inventory(directory, member));
    } else {
      assert.ok(properties.isFile(), 'Extracted VIDEO_TS must contain only regular files.');
      values.push({ path: member, type: 'file', ...await fileHashes(filename) });
    }
  }
  return ordered(values);
}

try {
  await phase('bind-producer-and-source');
  const descriptorBytes = await readFile(descriptorFilename), descriptor = JSON.parse(descriptorBytes);
  assert.equal(descriptor.schemaVersion, 1); assert.equal(descriptor.format, 'DVD-Video');
  const variant = options['--variant'] ?? 'ntsc', source = descriptor.variants[variant];
  assert.ok(source && /^[a-f0-9]{40}$/u.test(source.sha1) && /^[a-f0-9]{32}$/u.test(source.md5)
    && Number.isSafeInteger(source.bytes) && source.bytes > 0, 'The original image must have fixed bytes and published digests.');
  assert.equal(memberPath(descriptor.videoDirectory), descriptor.videoDirectory);
  const identityNames = ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_JOB', 'RUNNER_OS', 'RUNNER_ARCH'];
  const identity = Object.fromEntries(identityNames.map(name => { assert.ok(process.env[name], `Missing acquisition identity ${name}.`); return [name, process.env[name]]; }));
  const git = async ref => (await execute('git', ['-C', repository, 'rev-parse', '--verify', ref],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true })).stdout.trim();
  const checkout = { head: await git('HEAD'), tree: await git('HEAD^{tree}') };
  assert.equal(checkout.head, identity.GITHUB_SHA, 'Acquisition must execute the dispatched candidate.');
  const producerFiles = [];
  for (const relative of ['tools/ci/disc-reference/acquire.js', 'tools/ci/disc-reference/http-source.js',
    'tools/ci/disc-reference/source.json',
    '.github/workflows/disc-reference.yml', '.github/workflows/ci.yml'])
    producerFiles.push({ path: relative, ...await fileHashes(path.join(repository, relative)) });
  state.producer = { identity, checkout, files: producerFiles,
    node: { filename: await realpath(process.execPath), version: process.version, ...await fileHashes(process.execPath) } };
  await writeFile(path.join(evidence, 'source.json'), descriptorBytes, { flag: 'wx' });
  state.source = { ...source, variant, descriptorSha256: hash(descriptorBytes), license: descriptor.license,
    licenseSource: descriptor.licenseSource, licenseUrl: descriptor.licenseUrl, attribution: descriptor.attribution };
  const archiveTool = await realpath(options['--archive-tool']);
  const archiveToolBefore = await fileHashes(archiveTool);
  state.archiveTool = { filename: archiveTool, ...archiveToolBefore };
  const version = await command('archive-version', archiveTool, ['--version'], 30_000);
  assert.match(Buffer.concat([version.stdout, version.stderr]).toString('utf8'), /bsdtar.*libarchive/isu,
    'The bound executable must be the ISO-capable libarchive reader.');
  await phase('fetch-original-metadata');
  const metadataRequest = await fetchArchive(descriptor.metadataUrl, 'metadata');
  const metadataBytes = await smallBody(metadataRequest.response, 4 * 1024 * 1024);
  await writeFile(path.join(evidence, 'archive-metadata.json'), metadataBytes, { flag: 'wx' });
  state.metadata = { bytes: metadataBytes.length, sha256: hash(metadataBytes) };
  const metadata = JSON.parse(metadataBytes), original = metadata.files?.find(value => value.name === source.filename);
  assert.equal(metadata.metadata?.identifier, descriptor.archiveIdentifier);
  assert.ok(original, 'The exact original image must remain present in Archive metadata.');
  assert.equal(Number(original.size), source.bytes); assert.equal(original.sha1, source.sha1); assert.equal(original.md5, source.md5);
  await disk('before-original-download', source.bytes + 2 * 1024 ** 3);
  await phase('download-complete-original-iso');
  const image = path.join(work, 'original.iso');
  state.download = { bytes: 0, complete: false }; let lastProgress = 0;
  const downloaded = await downloadOriginalArchiveIso(source, image, { signal: deadline,
    onResponse: async observation => { state.http.push(observation); await save(); },
    onProgress: async progress => {
      state.download = { ...progress, complete: false };
      await save();
      if (Date.now() - lastProgress >= 30_000) {
        console.log(`Original ISO received ${state.download.bytes}/${source.bytes} bytes.`);
        lastProgress = Date.now();
      }
    } });
  state.download = { ...downloaded, complete: false };
  assert.equal(state.download.bytes, source.bytes, 'The complete original ISO must be received.');
  assert.equal(state.download.sha1, source.sha1); assert.equal(state.download.md5, source.md5);
  if (source.sha256) assert.equal(state.download.sha256, source.sha256, 'The complete original ISO must match the independently retained first acquisition SHA-256.');
  const persisted = await fileHashes(image, ['sha256', 'sha1', 'md5']);
  for (const key of ['bytes', 'sha256', 'sha1', 'md5']) assert.equal(persisted[key], state.download[key], `The persisted original ISO ${key} must match the complete response.`);
  state.download.complete = true; state.sourceComplete = true; state.sourceArchiveRetained = true;
  await phase('list-complete-original-iso');
  const names = await command('iso-members', archiveTool, ['-tf', image]);
  const verbose = await command('iso-members-detailed', archiveTool, ['-tvf', image]);
  const members = parseMembers(names.stdout, verbose.stdout), selected = videoMembers(members, descriptor.videoDirectory);
  await writeFile(path.join(evidence, 'iso-members.json'), json(members), { flag: 'wx' });
  await writeFile(path.join(evidence, 'video-ts-members.json'), json(selected), { flag: 'wx' });
  const selectedBytes = selected.filter(value => value.type === 'file').reduce((sum, value) => sum + value.bytes, 0);
  assert.ok(Number.isSafeInteger(selectedBytes) && selectedBytes > 0 && selectedBytes <= source.bytes,
    'The complete VIDEO_TS payload must fit the original image.');
  state.members = { all: members.length, selected: selected.length, selectedBytes };
  if (source.videoTsBytes !== undefined) assert.equal(selectedBytes, source.videoTsBytes);
  await disk('before-complete-video-ts-extraction', selectedBytes + 1024 ** 3);
  await phase('extract-complete-original-video-ts');
  await command('extract-video-ts', archiveTool, ['-xf', image, '-C', media, descriptor.videoDirectory]);
  const actual = await inventory(media);
  assert.deepEqual(actual.map(({ path: member, type, bytes }) => ({ path: member, type, bytes })),
    selected.map(({ path: member, type, bytes }) => ({ path: member, type, bytes: type === 'directory' ? 0 : bytes })),
    'Extraction must retain the exact complete VIDEO_TS member set and every original byte size.');
  const manager = await open(path.join(media, descriptor.videoDirectory, 'VIDEO_TS.IFO'), 'r');
  try { const header = Buffer.alloc(12); const read = await manager.read(header, 0, 12, 0); assert.equal(read.bytesRead, 12); assert.equal(header.toString('ascii'), 'DVDVIDEO-VMG'); }
  finally { await manager.close(); }
  await writeFile(path.join(evidence, 'media-inventory.json'), json(actual), { flag: 'wx' });
  if (source.videoTsEntries !== undefined) assert.equal(actual.length, source.videoTsEntries);
  if (source.videoTsInventorySha256) assert.equal(hash(json(actual)), source.videoTsInventorySha256,
    'The entire original VIDEO_TS payload must match the first complete acquisition.');
  const afterExtraction = await fileHashes(image);
  assert.equal(afterExtraction.bytes, persisted.bytes); assert.equal(afterExtraction.sha256, persisted.sha256,
    'Archive extraction must preserve the complete original image bytes.');
  assert.deepEqual(await fileHashes(archiveTool), archiveToolBefore, 'The bound archive executable must remain unchanged.');
  for (const file of producerFiles) assert.deepEqual(await fileHashes(path.join(repository, file.path)), { bytes: file.bytes, sha256: file.sha256 });
  state.payloadComplete = true;
  assert.equal(path.dirname(image), work); await unlink(image); state.sourceArchiveRetained = false;
  const receipt = { schemaVersion: 1, complete: true, format: descriptor.format, variant,
    producer: state.producer, source: state.source, metadata: state.metadata, download: state.download,
    archiveTool: state.archiveTool, sourceArchiveRetained: false, mediaRoot: media,
    videoDirectory: descriptor.videoDirectory, members: state.members,
    inventory: { filename: 'media-inventory.json', entries: actual.length, bytes: Buffer.byteLength(json(actual)), sha256: hash(json(actual)) },
    acceptance: { realOriginalDvdAcquired: true, actualProbe: false, actualScan: false, databaseExchange: false, releaseAcceptance: false } };
  await writeFile(path.join(evidence, 'receipt.json'), json(receipt), { flag: 'wx' });
  state.passed = true; state.phase = 'complete'; state.completedAt = new Date().toISOString(); await save();
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `receipt=${path.join(evidence, 'receipt.json')}\nmedia_root=${media}\nevidence_root=${evidence}\n`);
  console.log(`Verified complete original DVD: ${state.download.bytes} ISO bytes, ${selectedBytes} VIDEO_TS bytes, ${actual.length} entries.`);
} catch (error) {
  const failure = archiveFailureObservation(error);
  state.errors.push(failure);
  state.completedAt = new Date().toISOString(); await save();
  console.error(`Original DVD acquisition failed during ${state.phase}: ${failure.message ?? JSON.stringify(failure)}`); process.exitCode = 1;
}
