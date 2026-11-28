import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { VirtualFileSystem } from '../../src/storage/vfs.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const driver = `
using System.Reflection;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Providers;
using MediaBrowser.XbmcMetadata.Providers;
using Microsoft.Extensions.Logging.Abstractions;

var paths = DispatchProxy.Create<IApplicationPaths, AppPaths>();
var files = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
BaseItem.FileSystem = files;
var dirs = new DirectoryService(files);
var provider = new MovieNfoProvider(NullLogger<MovieNfoProvider>.Instance, files, null!, null!, null!, null!, dirs);
var saved = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
var cases = new List<object>();
foreach (var name in new[] { "exact", "inside", "outside" })
{
    var movie = new Movie { Path = Path.Combine(args[0], name + ".mkv"), DateLastSaved = saved, IsInMixedFolder = true };
    var modified = File.GetLastWriteTimeUtc(Path.Combine(args[0], name + ".nfo"));
    cases.Add(new { name, modified = modified.ToString("O"), changed = provider.HasChanged(movie, dirs) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(cases));

public class AppPaths : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) =>
        method?.Name == "get_TempDirectory" ? Path.GetTempPath() : throw new NotSupportedException(method?.Name);
}
`;

test('the NFO provider detects a real sidecar over the one-minute threshold at filesystem precision', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-nfo-clock-'));
  const registry = new StorageRegistry();
  t.after(async () => {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  });
  registry.registerType('local', config => LocalAdapter.open(config));
  await registry.createInstance('disk', 'local', { root });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/media', instanceId: 'disk', capabilities: {} });
  const provider = createNfoPlugin({ vfs });
  const seconds = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const samples = [];
  for (const [name, fraction] of [['exact', 0], ['inside', 0.0005], ['outside', 0.004]]) {
    const sidecar = path.join(root, name + '.nfo');
    await writeFile(sidecar, '<movie><title>Edited</title></movie>');
    await utimes(sidecar, seconds + 60 + fraction, seconds + 60 + fraction);
    const item = { Type: 'Movie', IsInMixedFolder: true, Path: '/media/' + name + '.mkv', DateLastSaved: '2026-01-01 00:00:00.0000000' };
    const { modified } = await vfs.stat('/media/' + name + '.nfo');
    const observed = await provider.hasChanged(item);
    const expected = modified > '2026-01-01T00:01:00.0000000Z';
    samples.push({ name, modified, observed, expected });
  }
  const evidence = await mkdtemp(path.join(validationOutputRoot(), 'review-native-nfo-'));
  const source = path.join(evidence, 'source'), project = path.join(source, 'Oracle.csproj');
  await mkdir(source);
  await copyFile(new URL('./fixtures/nfo-local-images/Oracle.csproj', import.meta.url), project);
  await writeFile(path.join(source, 'Program.cs'), driver);
  const output = path.join(evidence, 'native.json');
  await recordOracle({ project, output: path.join(evidence, 'oracle'), args: [root, output] });
  const native = JSON.parse(await readFile(output, 'utf8'));
  t.diagnostic('AUDIT nfo-native ' + JSON.stringify({ candidate: samples, native }));
  assert.deepEqual(native.map(v => v.modified), samples.map(s => s.modified));
  assert.deepEqual(native.map(v => v.changed), [false, true, true]);
  assert.deepEqual(samples.map(s => s.observed), native.map(v => v.changed));
  assert.deepEqual(samples.map(s => s.expected), [false, true, true], 'physical timestamps retained the control and both edits');
  assert.deepEqual(samples.map(s => s.observed), samples.map(s => s.expected));
});
