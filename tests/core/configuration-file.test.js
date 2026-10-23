import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfigurationFile } from './fixtures/configuration/codecs.js';
import { parseConfigurationXml, readConfigurationDocument } from './fixtures/configuration/codecs.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { configurationValue, configurationJson } from './fixtures/configuration/observations.js';
import { currentConfiguration, configurationProject, input } from './configuration-current.js';
import { holdNativeFile } from './native-file-holder.js';


export const requiredValidationServices = ['dotnet', 'jellyfinDll'];

test('configuration helper matches native recovery, canonical write admission and real file sharing, then native cold read', async t => {
  const { native, record } = await currentConfiguration();
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'Native configuration cold reads require MEDIAMANAGER_JELLYFIN_DLL and its assembly directory.');
  await fs.access(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const root = path.join(path.resolve(validationOutputRoot()), 'configuration-files'); await fs.mkdir(root);
  const observations = [], consumers = [], locks = [];
  for (const sample of input.filter(sample => sample.helper)) await t.test(sample.name, async () => {
    const expected = native.results.find(row => row.name === sample.name), directory = path.join(root, sample.name); await fs.mkdir(directory);
    const filename = path.join(directory, 'config.xml');
    if (sample.directory) await fs.mkdir(filename); else if (expected.beforeBytes != null) await fs.writeFile(filename, Buffer.from(expected.beforeBytes, 'base64'));
    if (sample.readOnly) await fs.chmod(filename, 0o444);
    let holder, value, error, bytes, reread, coldError;
    const lock = sample.locked ? { name: sample.name } : null;
    if (lock) locks.push(lock);
    try {
      if (sample.locked) holder = await holdNativeFile({ record, filename, mode: sample.lockMode ?? 'read', receipt: lock });
      try { value = await loadConfigurationFile(filename, sample.root, { processors: native.host.processorCount, rewriteValid: !sample.plugin }); }
      catch (failure) { error = { code: failure.code, message: failure.message }; }
      await holder?.inspect();
    } finally {
      try { await holder?.release(); }
      finally {
        if (lock) await fs.writeFile(path.join(directory, 'lock.json'), configurationJson(lock), { flag: 'wx' });
        if (sample.readOnly) await fs.chmod(filename, 0o666);
      }
    }
    try { bytes = await fs.readFile(filename); reread = parseConfigurationXml(bytes, sample.root, { processors: native.host.processorCount }); }
    catch (failure) { coldError = failure.message; }
    observations.push({ name: sample.name, accepted: !error, value, error, reread, coldError, afterBytes: bytes?.toString('base64') ?? null, nativeFileSharing: expected.fileSharing });
    if (bytes) consumers.push({ name: sample.name, root: sample.root, filename });
    assert.equal(!error, expected.accepted); if (!error) assert.deepEqual(value, configurationValue(expected.value, sample.root));
    assert.deepEqual(reread ?? null, configurationValue(expected.reread, sample.root));
    assert.equal((await fs.stat(filename)).isDirectory(), expected.afterDirectory);
    if (error || expected.beforeBytes === expected.afterBytes) assert.equal(bytes?.toString('base64') ?? null, expected.afterBytes);
  });
  await fs.writeFile(path.join(root, 'observations.json'), configurationJson(observations), { flag: 'wx' });
  await fs.writeFile(path.join(root, 'locked-processes.json'), configurationJson(locks), { flag: 'wx' });
  const consumerInput = path.join(root, 'consumer-input.json'); await fs.writeFile(consumerInput, configurationJson(consumers), { flag: 'wx' });
  const recording = await recordOracle({ project: configurationProject, output: path.join(root, 'native-reader'),
    args: ['consume', consumerInput, '{output}/native.json'] });
  const returned = parseLosslessJson((await fs.readFile(path.join(root, 'native-reader', 'native.json'))).toString('utf8'));
  const comparison = returned.results.map(row => {
    const observed = observations.find(value => value.name === row.name);
    return { name: row.name, accepted: row.accepted, value: configurationValue(row.value, row.root), expected: observed.reread ?? null, coldError: observed.coldError };
  });
  await fs.writeFile(path.join(root, 'native-reader-proof.json'), configurationJson({ recording, comparison, actualNativeRead: true }), { flag: 'wx' });
  assert.equal(returned.actualXmlSerializer, true); assert.equal(returned.actualFiles, true);
  assert.equal(returned.results.length, consumers.length);
  for (const row of comparison) { assert.equal(row.accepted, row.coldError == null, row.name); if (row.accepted) assert.deepEqual(row.value, row.expected, row.name); }
});

function unknown(node) {
  const attrs = Object.fromEntries(Object.entries(node.attributes).filter(([name]) => !name.startsWith('xmlns')));
  return { name: node.name, attrs, text: node.text, children: node.children.map(unknown) };
}

test('configuration recovery retains unknown root, object, array and scalar attributes and mixed content', async () => {
  const root = path.join(path.resolve(validationOutputRoot()), 'configuration-unknown'); await fs.mkdir(root);
  const original = Buffer.from('<ServerConfiguration xmlns:u="urn:future" u:flag="a&#x9;b">before<u:root a="v">x<u:child/>y</u:root>after'
    + '<ServerName u:name="kept">001</ServerName><ContentTypes u:first="first"><u:extra>one</u:extra></ContentTypes>'
    + '<ContentTypes u:last="last"><NameValuePair u:pair="p"><Name u:name="n">test</Name><Value>movies</Value><u:inside>nested</u:inside></NameValuePair><u:extra>two</u:extra></ContentTypes>'
    + '<TrickplayOptions u:object="o"><Interval u:integer="i">+100</Interval><u:nested>before<u:child/>after</u:nested></TrickplayOptions></ServerConfiguration>');
  const filename = path.join(root, 'system.xml'); await fs.writeFile(filename, original);
  const before = readConfigurationDocument(original, 'server'), loaded = await loadConfigurationFile(filename, 'server'), after = readConfigurationDocument(await fs.readFile(filename), 'server');
  assert.deepEqual(loaded, before.value); assert.deepEqual(after.value, before.value);
  const originals = before.node.children.filter(node => node.name.startsWith('u:'));
  assert.deepEqual(after.node.children.filter(node => node.name.startsWith('u:')).map(unknown), originals.map(unknown));
  for (const [name, attribute] of [['ServerName', 'u:name'], ['TrickplayOptions', 'u:object']]) {
    assert.equal(after.node.children.find(node => node.name === name).attributes[attribute], before.node.children.find(node => node.name === name).attributes[attribute]);
  }
  const arrays = after.node.children.filter(node => node.name === 'ContentTypes');
  assert.deepEqual(arrays.map(node => node.attributes['u:first'] ?? node.attributes['u:last']), ['first', 'last']);
  assert.deepEqual(arrays.map(node => node.children.filter(child => child.name === 'u:extra').map(unknown)),
    before.node.children.filter(node => node.name === 'ContentTypes').map(node => node.children.filter(child => child.name === 'u:extra').map(unknown)));
  assert.match(after.node.text, /before/u); assert.match(after.node.text, /after/u);
  const item = arrays[1].children.find(node => node.name === 'NameValuePair'); assert.equal(item.attributes['u:pair'], 'p');
  assert.equal(item.children.find(node => node.name === 'Name').attributes['u:name'], 'n');
  assert.equal(item.children.find(node => node.name === 'u:inside').text, 'nested');
  const options = after.node.children.find(node => node.name === 'TrickplayOptions');
  assert.equal(options.children.find(node => node.name === 'Interval').attributes['u:integer'], 'i');
  assert.deepEqual(unknown(options.children.find(node => node.name === 'u:nested')), unknown(before.node.children.find(node => node.name === 'TrickplayOptions').children.find(node => node.name === 'u:nested')));
});

test('configuration paths reject links before reading or repairing another state root', async () => {
  const root = path.join(path.resolve(validationOutputRoot()), 'configuration-paths'); await fs.mkdir(root);
  const external = path.join(root, 'external'); await fs.mkdir(external); const filename = path.join(external, 'system.xml'), original = Buffer.from('<ServerConfiguration/>');
  await fs.writeFile(filename, original); const link = path.join(root, 'config'); await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(loadConfigurationFile(path.join(link, 'system.xml'), 'server'), { code: 'unsafe-configuration-path' }); }
  finally { await fs.unlink(link); }
  assert.deepEqual(await fs.readFile(filename), original);
});
