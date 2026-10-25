import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { describeFile } from '../../../../tools/validation/inventory.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
export const hash = value => createHash('sha256').update(value).digest('hex');
export const diagnosticJson = (_key, value) => value instanceof Error
  ? Object.fromEntries([...new Set([...Object.getOwnPropertyNames(value), 'name', 'message', 'code', 'status', 'statusCode', 'cause', 'errors', 'stack'])]
    .map(key => [key, value[key]]))
  : typeof value === 'bigint' ? value.toString() : value;
const fixture = new URL('./', import.meta.url);

export async function captureLocalFileTimes({ output, input, profile, signal }) {
  const build = await verifyNativeBuild();
  const sourceManifest = JSON.parse(await fs.readFile(path.join(build.sourceOfferRoot, 'jellyfin-source-manifest.json'), 'utf8'));
  const sourceBindings = [];
  for (const relative of profile.nativeSourcePaths) {
    const expected = sourceManifest.files.find(value => value.path === relative); assert.ok(expected, relative);
    const source = await describeFile(path.join(build.sourceRoot, relative));
    assert.equal(source.sha256, expected.sha256, relative); assert.equal(source.bytes, expected.size, relative);
    sourceBindings.push({ relative, source, expected });
  }
  const inputFile = path.join(output, 'input.json'), bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  await fs.writeFile(inputFile, bytes, { flag: 'wx' });
  const record = await recordOracle({ project: fileURLToPath(new URL('Oracle.csproj', fixture)),
    output: path.join(output, 'native'), args: [inputFile, '{output}/native.json'] });
  const nativeFile = path.join(output, 'native', 'native.json'), nativeBytes = await fs.readFile(nativeFile), native = JSON.parse(nativeBytes);
  assert.equal(native.inputSha256, hash(bytes)); assert.equal(native.actualManagedFileSystem, true);
  assert.equal(record.outputs.find(value => path.basename(value.filename) === 'native.json')?.sha256, hash(nativeBytes));
  for (const assembly of native.assemblies) {
    const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
    assert.equal(actual.sha256, assembly.sha256, assembly.name); assert.equal(actual.bytes, assembly.bytes, assembly.name);
  }
  const coreLib = await describeFile(native.runtime.coreLib.filename);
  assert.equal(coreLib.sha256, native.runtime.coreLib.sha256); assert.equal(coreLib.bytes, native.runtime.coreLib.bytes);
  const sdkBefore = JSON.parse(await fs.readFile(path.join(build.receipts, 'sdk-before.json'), 'utf8'));
  const relativeCoreLib = path.relative(build.sdkRoot, native.runtime.coreLib.filename).replaceAll('\\', '/');
  assert.ok(relativeCoreLib && !relativeCoreLib.startsWith('../') && !path.isAbsolute(relativeCoreLib));
  const sdkCoreLib = sdkBefore.files.find(value => value.path === relativeCoreLib); assert.ok(sdkCoreLib, relativeCoreLib);
  assert.equal(sdkCoreLib.sha256, coreLib.sha256); assert.equal(sdkCoreLib.bytes, coreLib.bytes);
  // The executing SDK is built from the official dotnet/dotnet VMR. Its
  // informational commit selects both the manifest and src/runtime source;
  // the manifest's runtime commit is retained without substituting its tree.
  // These extra source reads are diagnostics, separate from same-file dates.
  const commit = native.runtime.sourceCommit, runtimeSources = [], sourceFailures = [], sourceRequests = [];
  let runtimeSourceIdentity;
  const retrieve = async (url, relative, role) => {
    const request = { url, relative, role }; sourceRequests.push(request);
    try {
      signal?.throwIfAborted();
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
      request.status = response.status; request.statusText = response.statusText; request.headers = Object.fromEntries(response.headers);
      const sourceBytes = Buffer.from(await response.arrayBuffer()), filename = path.join(output, 'runtime-source', relative);
      await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, sourceBytes, { flag: 'wx' });
      request.body = await describeFile(filename);
      if (!response.ok) throw Object.assign(new Error('The executing runtime source could not be retrieved.'), {
        code: 'runtime-source-unavailable', status: response.status, statusCode: response.status, url,
        responseHeaders: request.headers, responseBody: request.body,
      });
      return { bytes: sourceBytes, filename, request };
    } catch (error) {
      error.url ??= url; error.sourceRole = role; error.sourceRelative = relative;
      request.error = error; throw error;
    }
  };
  try {
    assert.match(commit ?? '', /^[a-f0-9]{40}$/iu, 'The executing CoreLib must identify its source commit.');
    assert.equal(profile.runtimeSourceRepository, 'https://github.com/dotnet/dotnet');
    assert.equal(profile.runtimeSourceManifest, 'src/source-manifest.json');
    assert.equal(profile.runtimeSourcePrefix, 'src/runtime/');
    assert.equal(profile.runtimeMappedRepository, 'https://github.com/dotnet/runtime');
    const origin = profile.runtimeSourceRepository.replace('https://github.com/', 'https://raw.githubusercontent.com/') + '/' + commit;
    try {
      const manifest = await retrieve(origin + '/' + profile.runtimeSourceManifest, profile.runtimeSourceManifest, 'exact-informational-commit-vmr-manifest');
      const runtime = JSON.parse(manifest.bytes).repositories.find(value => value.path === 'runtime');
      assert.ok(runtime, 'The exact VMR manifest must identify runtime.'); assert.equal(runtime.remoteUri, profile.runtimeMappedRepository);
      assert.match(runtime.commitSha ?? '', /^[a-f0-9]{40}$/iu);
      runtimeSourceIdentity = { repository: profile.runtimeSourceRepository, commit, prefix: profile.runtimeSourcePrefix,
        manifest: manifest.request.body, runtimeManifestEntry: runtime };
    } catch (error) { sourceFailures.push(error); }
    for (const relative of profile.runtimeSourcePaths[process.platform]) try {
      assert.match(relative, /^src\/[A-Za-z0-9_./-]+$/u); assert.ok(!relative.split('/').includes('..'));
      const vmrRelative = profile.runtimeSourcePrefix + relative, url = origin + '/' + vmrRelative;
      const source = await retrieve(url, vmrRelative, 'exact-informational-commit-vmr-runtime-source');
      runtimeSources.push({ relative, vmrRelative, url, filename: source.filename, bytes: source.bytes.length, sha256: hash(source.bytes) });
    } catch (error) { sourceFailures.push(error); }
  } catch (error) { sourceFailures.push(error); }
  const afterCoreLib = await describeFile(native.runtime.coreLib.filename); assert.equal(afterCoreLib.sha256, coreLib.sha256);
  const result = { native, record, input: await describeFile(inputFile), observation: await describeFile(nativeFile), sourceBindings,
    build: { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256 },
    coreLib: { observed: coreLib, originalSdkEntry: sdkCoreLib, relative: relativeCoreLib }, runtimeSourceIdentity, runtimeSources, sourceRequests, sourceFailures,
    sourceEvidenceComplete: runtimeSourceIdentity !== undefined && sourceFailures.length === 0
      && runtimeSources.length === profile.runtimeSourcePaths[process.platform].length,
    sourceScope: 'Records executing repository libraries and CoreLib bytes, the original SDK file entry and the public informational source commit. Extra exact VMR manifest/source retrieval and full HTTP failures are diagnostics; sourceEvidenceComplete describes only that source closure and does not redefine public date sampling or cleanup acceptance.' };
  await fs.writeFile(path.join(output, 'capture.json'), JSON.stringify(result, diagnosticJson, 2) + '\n', { flag: 'wx' });
  return result;
}
