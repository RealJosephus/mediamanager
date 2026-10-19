import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageFile = fileURLToPath(new URL('./fixtures/alist-api-host/package.json', import.meta.url));
const packagePin = '6b9631506420acf8873ea7956b896d8ab0864a8b08d8f60338dd9eb2d1498bc3';
const kind = 'alist-api-only-test-host';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

async function ordinary(root, relative) {
  if (typeof relative !== 'string' || !relative || /[:\\\r\n\0]/u.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) {
    throw new Error('Invalid AList input member path.');
  }
  let filename = root;
  for (const part of ['', ...relative.split('/')]) {
    if (part) filename = path.join(filename, part);
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('AList input traverses a symbolic link.');
  }
  if (!(await lstat(filename)).isFile()) throw new Error('AList input is not an ordinary file.');
  return filename;
}

async function expected(root, descriptor, contents = false) {
  if (!descriptor || !digest(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) {
    throw new Error('Invalid AList input digest declaration.');
  }
  const filename = await ordinary(root, descriptor.path);
  const checksum = createHash('sha256'); let length = 0;
  for await (const bytes of createReadStream(filename)) { checksum.update(bytes); length += bytes.length; }
  if (length !== descriptor.bytes || checksum.digest('hex') !== descriptor.sha256) throw new Error(`AList input bytes changed: ${descriptor.path}`);
  if (contents && length > 16 * 1024 * 1024) throw new Error('AList JSON evidence exceeds its bounded size.');
  return { filename, ...(contents ? { bytes: await readFile(filename) } : {}),
    descriptor: { filename, bytes: length, sha256: descriptor.sha256 } };
}

export async function alistSourceInputs() {
  const root = path.dirname(packageFile), filename = await ordinary(root, path.basename(packageFile));
  const bytes = await readFile(filename);
  if (hash(bytes) !== packagePin) throw new Error('AList source package pin changed.');
  const source = JSON.parse(bytes);
  if (source.kind !== kind || source.head !== '38316357f1a0507e9e8906ed9ec78e8535ba2d1c'
    || source.sourceFiles !== 635 || source.webUiValidated !== false || source.originalReleaseReproduced !== false
    || source.frontend.destination !== 'public/dist/index.html' || source.frontend.authoredForThisTestHost !== true) {
    throw new Error('AList source package is outside the designated API-only scope.');
  }
  const inputs = [{ filename, bytes: bytes.length, sha256: packagePin }];
  for (const descriptor of [source.sourceArchive, source.sourceManifest, source.license, source.frontend, source.frontendLicense]) {
    inputs.push((await expected(root, descriptor)).descriptor);
  }
  return { source, inputs };
}

/** Inputs for strict before/after identity capture; no build or process is started. */
export async function alistBuildInputs(environment = process.env) {
  if (environment.MEDIAMANAGER_CI_ALIST_REFERENCE !== 'true') return [];
  const root = environment.MEDIAMANAGER_ALIST_BUILD_ROOT, executable = environment.MEDIAMANAGER_ALIST_EXECUTABLE;
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error('AList CI provisioning requires its build root and executable path.');
  }
  const { source, inputs } = await alistSourceInputs();
  const receiptFile = await ordinary(root, 'receipts/build-receipt.json'), bytes = await readFile(receiptFile);
  inputs.push({ filename: receiptFile, bytes: bytes.length, sha256: hash(bytes) });
  const receipt = JSON.parse(bytes);
  if (receipt.kind !== kind || receipt.status !== 'succeeded' || receipt.originalGoSourceUnchanged !== true
    || receipt.webUiValidated !== false || receipt.originalReleaseReproduced !== false || receipt.goExpected !== 'go1.23.1'
    || !/^go version go1\.23\.1 (?:linux|windows|darwin)\/(?:amd64|arm64)$/u.test(receipt.goActual ?? '')
    || receipt.package?.sha256 !== packagePin) throw new Error('AList build receipt does not prove the designated API-only build.');
  for (const [key, variable] of [['commit', 'GITHUB_SHA'], ['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT'], ['repository', 'GITHUB_REPOSITORY']]) {
    if (!environment[variable] || receipt[key] !== environment[variable]) throw new Error(`AList build receipt is not from this run: ${key}`);
  }
  const bind = async (descriptor, contents = false) => {
    const result = await expected(root, descriptor, contents); inputs.push(result.descriptor); return result;
  };
  const binary = await bind(receipt.executable);
  if (binary.filename !== path.resolve(executable) || !/^runtime\/alist(?:\.exe)?$/u.test(receipt.executable.path)) {
    throw new Error('AList executable is not the audited same-run binary.');
  }
  if (!Array.isArray(receipt.sourceOffer) || new Set(receipt.sourceOffer.map(file => file.path)).size !== receipt.sourceOffer.length) {
    throw new Error('Invalid AList source offer.');
  }
  for (const file of receipt.sourceOffer) {
    if (!file.path.startsWith('source-offer/')) throw new Error('AList source offer escaped its directory.');
    await bind(file);
  }
  for (const file of [{ path: 'package.json', bytes: inputs[0].bytes, sha256: packagePin }, source.sourceArchive,
    source.sourceManifest, source.license, source.frontend, source.frontendLicense]) {
    const recorded = receipt.sourceOffer.find(value => value.path === `source-offer/${file.path}`);
    if (!recorded || recorded.sha256 !== file.sha256 || recorded.bytes !== file.bytes) throw new Error('AList source offer does not match its pinned package.');
  }
  const manifest = JSON.parse((await readFile(inputs.find(input => input.filename.endsWith(`${path.sep}source-manifest.json`)).filename)));
  for (const descriptor of [receipt.sourceBefore, receipt.sourceAfter]) {
    const snapshot = JSON.parse((await bind(descriptor, true)).bytes);
    if (!snapshot.allMatched || snapshot.files?.length !== source.sourceFiles
      || new Set(snapshot.files.map(file => file.path)).size !== source.sourceFiles
      || snapshot.frontend?.path !== source.frontend.destination || snapshot.frontend.sha256 !== source.frontend.sha256
      || snapshot.frontend.bytes !== source.frontend.bytes || snapshot.frontend.matches !== true) throw new Error('AList source snapshot is incomplete.');
    const pinned = new Map(manifest.files.map(file => [file.path, file]));
    for (const file of snapshot.files) {
      if (file.matches !== true || file.sha256 !== pinned.get(file.path)?.sha256 || file.bytes !== pinned.get(file.path)?.bytes) {
        throw new Error('AList source snapshot does not match its original source.');
      }
    }
  }
  const required = ['compiler-version', 'compiler-target', 'go-version', 'go-environment', 'build',
    'module-verify', 'dependencies', 'binary-modules', 'alist-version'];
  if (!Array.isArray(receipt.commands) || new Set(receipt.commands.map(command => command.name)).size !== receipt.commands.length
    || required.some(name => !receipt.commands.some(command => command.name === name))) throw new Error('AList build command evidence is incomplete.');
  for (const command of receipt.commands) {
    if (command.exitCode !== 0 || command.timedOut) throw new Error('AList build command did not complete successfully.');
    await bind(command.stdout); await bind(command.stderr);
  }
  const sdkPins = {
    'go1.23.1.windows-amd64.zip': '32dedf277c86610e380e1765593edb66876f00223df71690bd6be68ee17675c0',
    'go1.23.1.linux-amd64.tar.gz': '49bbb517cfa9eee677e1e7897f7cf9cfdbcf49e05f61984a2789136de359f9bd',
    'go1.23.1.darwin-amd64.tar.gz': '488d9e4ca3e3ed513ee4edd91bef3a2360c65fa6d6be59cf79640bf840130a58',
    'go1.23.1.darwin-arm64.tar.gz': 'e223795ca340e285a760a6446ce57a74500b30e57469a4109961d36184d3c05a',
  };
  const target = receipt.goActual.split(' ').at(-1).replace('/', '-');
  const sdkName = `go1.23.1.${target}${target.startsWith('windows-') ? '.zip' : '.tar.gz'}`;
  if (receipt.sdkArchive?.path !== sdkName || receipt.sdkArchive.sha256 !== sdkPins[sdkName]
    || receipt.goExecutable?.path !== `go/bin/go${target.startsWith('windows-') ? '.exe' : ''}`) {
    throw new Error('AList Go SDK does not match its official pin and target.');
  }
  await bind(receipt.sdkArchive); await bind(receipt.goExecutable);
  const compiler = receipt.compiler;
  if (typeof compiler?.filename !== 'string' || !path.isAbsolute(compiler.filename)) throw new Error('AList compiler identity is missing.');
  inputs.push((await expected(path.dirname(compiler.filename), { ...compiler, path: path.basename(compiler.filename) })).descriptor);
  return [...new Map(inputs.map(input => [input.filename, input])).values()];
}
