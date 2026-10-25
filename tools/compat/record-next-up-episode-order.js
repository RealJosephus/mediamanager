#!/usr/bin/env node
import { validationExecutable, validationOutputRoot, validationPath } from '../validation/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3) throw new Error('Usage: node tools/compat/record-next-up-episode-order.js <new-evidence-directory>');
const output = validationPath(path.resolve(root, directory));
assert.ok(output.startsWith(validationOutputRoot() + path.sep));
await mkdir(output, { recursive: false });
const reference = JSON.parse(await readFile(validationPath(path.join(root, 'tests/library/fixtures/next-up/order-native.json'))));
const sequences = [];
for (const length of [1, 2, 3, 4, 15, 16, 17, 31, 32, 33, 57, 109]) for (let seed = 1; seed <= 32; seed++) {
  let random = seed;
  sequences.push(Array.from({ length }, () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % reference.episodes.length;
  }));
}
sequences.push(reference.episodes.map((_episode, index) => index));
sequences.push(reference.episodes.map((_episode, index) => index).reverse());
const json = value => JSON.stringify(value, null, 2) + '\n';
await writeFile(path.join(output, 'input.json'), json({ episodes: reference.episodes, sequences }), { flag: 'wx' });
await writeFile(path.join(output, 'EpisodeOrder.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><Reference Include="${validationPath(path.join(root, '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/*.dll')).replaceAll('\\', '/')}"/></ItemGroup></Project>\n`, { flag: 'wx' });
await writeFile(path.join(output, 'Program.cs'), `using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Emby.Server.Implementations.Sorting;
using MediaBrowser.Controller.Entities.TV;
using var document = JsonDocument.Parse(File.ReadAllText(args[0]));
var inputs = document.RootElement.GetProperty("episodes").EnumerateArray().ToArray();
var episodes = inputs.Select(input => {
    var episode = new Episode();
    foreach (var property in input.EnumerateObject()) {
        var member = typeof(Episode).GetProperty(property.Name, BindingFlags.Instance | BindingFlags.Public) ?? throw new Exception(property.Name);
        var value = JsonSerializer.Deserialize(property.Value.GetRawText(), member.PropertyType);
        member.SetValue(episode, value);
        if (!Equals(member.GetValue(episode), value)) throw new Exception("Binding failed: " + property.Name);
    }
    return episode;
}).ToArray();
var comparer = new AiredEpisodeOrderComparer();
var orders = document.RootElement.GetProperty("sequences").EnumerateArray().Select(sequence => {
    var indices = sequence.EnumerateArray().Select(value => value.GetInt32()).ToArray();
    return Enumerable.Range(0, indices.Length).OrderBy(index => episodes[indices[index]], comparer).ToArray();
}).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { bindingValidated = episodes.Length, orders,
    runtime = new { frameworkDescription = RuntimeInformation.FrameworkDescription, version = Environment.Version.ToString() } }));
`, { flag: 'wx' });
const command = [validationExecutable('dotnet'), 'run', '--project', path.join(output, 'EpisodeOrder.csproj'),
  '--', path.join(output, 'input.json'), path.join(output, 'comparisons.json')];
const result = await new Promise(resolve => {
  const child = spawn(command[0], command.slice(1), { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.once('error', error => resolve({ code: null, signal: null, stdout, stderr, error: error.message }));
  child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
});
await writeFile(path.join(output, 'process.json'), json({ command, ...result }), { flag: 'wx' });
assert.equal(result.code, 0, result.stderr || result.stdout);
const comparisons = JSON.parse(await readFile(path.join(output, 'comparisons.json')));
assert.equal(comparisons.bindingValidated, reference.episodes.length);
assert.equal(comparisons.orders.length, sequences.length);
for (const [index, order] of comparisons.orders.entries()) assert.deepEqual([...order].sort((a, b) => a - b), sequences[index].map((_episode, index) => index));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['Program.cs', 'EpisodeOrder.csproj'].map(name => path.join(output, name)).concat([
  validationPath(path.join(root, 'tools/compat/record-next-up-episode-order.js')),
  validationPath(path.join(root, '.test-input/baselines/jellyfin-current/source/Emby.Server.Implementations/Sorting/AiredEpisodeOrderComparer.cs')),
  validationPath(path.join(root, '.test-input/baselines/jellyfin-current/source/Jellyfin.Server/bin/Release/net10.0/Emby.Server.Implementations.dll')),
  validationPath(path.join(root, '.tools/dotnet/shared/Microsoft.NETCore.App/10.0.12/System.Private.CoreLib.dll')),
  validationPath(path.join(root, '.tools/dotnet/shared/Microsoft.NETCore.App/10.0.12/System.Linq.dll'))]);
const fixture = { schemaVersion: 1, episodes: reference.episodes, sequences, ...comparisons,
  source: Object.fromEntries(await Promise.all(sources.map(async name => [path.relative(root, name).replaceAll('\\', '/'), sha256(await readFile(name))]))),
  result: { code: result.code, signal: result.signal }, phaseAcceptance: false };
await writeFile(path.join(output, 'native.json'), json(fixture), { flag: 'wx' });
console.log(JSON.stringify({ episodes: fixture.episodes.length, sequences: sequences.length, result: fixture.result, runtime: fixture.runtime, phaseAcceptance: false }));
