import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
// Invoke actual frozen Jellyfin comparers with controlled, synthetic domain data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const [outputArgument, frozenArgument, sdkArgument] = process.argv.slice(2);
assert.ok(outputArgument, 'A new ignored evidence directory is required.');
const output = validationPath(path.resolve(repo, outputArgument)), allowed = validationOutputRoot();
assert.ok(output.startsWith(allowed + path.sep) && !existsSync(output));
const frozen = validationPath(path.resolve(repo, frozenArgument ?? '.agent-docs/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0'));
const sdk = sdkArgument ? path.resolve(repo, sdkArgument) : validationExecutable('dotnet');
assert.ok(existsSync(sdk));
const source = validationPath(path.join(repo, 'tests/library/fixtures/boxset-display-order/BoundaryOracle.cs'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function dllBindings() {
  return Promise.all((await readdir(frozen)).filter(name => name.endsWith('.dll')).sort()
    .map(async name => ({ path: name, sha256: hash(await readFile(path.join(frozen, name))) })));
}
const before = await dllBindings();
await mkdir(output);
await copyFile(source, path.join(output, 'Program.cs'), 1);
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(path.join(output, 'Oracle.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><Reference Include="${xml(frozen.replaceAll('\\', '/'))}/*.dll"/></ItemGroup></Project>\n`, { flag: 'wx' });
async function run(args, label) {
  const child = spawn(sdk, args, { cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  const processResult = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await writeFile(path.join(output, label + '-stdout.log'), stdout, { flag: 'wx' });
  await writeFile(path.join(output, label + '-stderr.log'), stderr, { flag: 'wx' });
  return { command: [sdk, ...args], childPid: child.pid, processResult, stdout, stderr };
}
const build = await run(['build', 'Oracle.csproj', '--configuration', 'Release'], 'build');
assert.deepEqual(build.processResult, { code: 0, signal: null });
const oracle = await run([path.join(output, 'bin/Release/net10.0/Oracle.dll')], 'oracle');
assert.deepEqual(oracle.processResult, { code: 0, signal: null });
const native = JSON.parse(oracle.stdout);
assert.equal(native.actualFrozenDllComparersInvoked, true);
assert.equal(native.actualLinqOrderByInvoked, true);
assert.equal(native.output.length, 4);
for (const assembly of native.assemblies) assert.equal(before.find(file => file.path === assembly.assembly + '.dll').sha256, assembly.sha256);
const after = await dllBindings();
assert.deepEqual(after, before);
await writeFile(path.join(output, 'native.json'), oracle.stdout, { flag: 'wx' });
const summary = { passed: true, phaseAcceptance: false, actualComparers: native.output.map(row => row.name), orderSequences: 8,
  frozenDllsUnchanged: true, frozenDlls: before, sourceSha256: hash(await readFile(source)),
  recorderSha256: hash(await readFile(fileURLToPath(import.meta.url))), sdkPath: sdk,
  build: { command: build.command, childPid: build.childPid, processResult: build.processResult },
  oracle: { command: oracle.command, childPid: oracle.childPid, processResult: oracle.processResult },
  nativeSha256: hash(oracle.stdout), scope: 'Actual frozen comparers/.NET LINQ; controlled UserData/domain objects. No LibraryManager, HTTP, persistence or authentication. All build outputs are under this ignored directory.' };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: true, orderSequences: 8, frozenDllsUnchanged: true }));
