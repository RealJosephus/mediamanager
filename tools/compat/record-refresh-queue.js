import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBaseline } from './verify-baseline.js';

const { values } = parseArgs({ options: {
  'assembly-directory': { type: 'string' },
  'baseline-manifest': { type: 'string' },
  output: { type: 'string' },
  dotnet: { type: 'string', default: process.env.MEDIAMANAGER_DOTNET ?? 'dotnet' },
} });
if (!values['assembly-directory'] || !values['baseline-manifest'] || !values.output) {
  throw new TypeError('Supply --assembly-directory, --baseline-manifest, --output and optionally --dotnet.');
}
const run = promisify(execFile);
const assemblyDirectory = path.resolve(values['assembly-directory']);
const output = path.resolve(values.output);
const project = fileURLToPath(new URL('./refresh-queue-oracle/RefreshQueueOracle.csproj', import.meta.url));
const build = path.join(output, 'build');
await mkdir(output, { recursive: true });
const baselinePath = path.resolve(values['baseline-manifest']);
const baselineBytes = await readFile(baselinePath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = JSON.parse(baselineBytes);
const verifiedBaseline = await verifyBaseline(baselinePath);
const assemblies = {};
for (const name of ['MediaBrowser.Providers.dll', 'MediaBrowser.Controller.dll', 'MediaBrowser.Model.dll', 'MediaBrowser.Common.dll', 'Jellyfin.Data.dll']) {
  assemblies[name] = hash(await readFile(path.join(assemblyDirectory, name)));
}
const buildResult = await run(values.dotnet, ['build', project, '--configuration', 'Release', '--nologo', '--verbosity', 'quiet',
  '--output', build, `-p:JellyfinAssemblyDirectory=${assemblyDirectory}`], { maxBuffer: 16 * 1024 * 1024 });
await writeFile(path.join(output, 'build.log'), buildResult.stdout + buildResult.stderr);
const execution = await run(values.dotnet, [path.join(build, 'RefreshQueueOracle.dll')], { maxBuffer: 16 * 1024 * 1024 });
const native = JSON.parse(execution.stdout);
await writeFile(path.join(output, 'native.json'), JSON.stringify(native, null, 2) + '\n');
await writeFile(path.join(output, 'native.stderr.log'), execution.stderr);
const version = (await run(values.dotnet, ['--version'])).stdout.trim();
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), platform: process.platform, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dotnet: values.dotnet, sdkVersion: version, assemblyDirectory, assemblies,
  baselineManifest: baselinePath, baselineManifestSha256: hash(baselineBytes), baselineHead: baseline.head ?? baseline.HEAD,
  sourceAggregateSha256: baseline.contentDigest,
  verifiedBaseline,
  nativeSha256: hash(Buffer.from(JSON.stringify(native, null, 2) + '\n')),
  scope: 'Actual ProviderManager queue and BaseItem dispatch, controlled dependency service, no native SQL or HTTP server.',
}, null, 2) + '\n');
console.log(JSON.stringify({ output, cases: native.length, maximumConcurrency: native.map(sample => sample.maximumConcurrency) }));
