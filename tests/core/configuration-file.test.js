import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfigurationFile } from './fixtures/configuration/codecs.js';
import { parseConfigurationXml, readConfigurationDocument } from './fixtures/configuration/codecs.js';
import { parseLosslessJson } from '../../src/core/json.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { validationExecutable, validationOutputRoot } from '../../tools/validation/paths.js';
import { configurationValue, configurationJson } from './fixtures/configuration/observations.js';


const fixture = new URL('./fixtures/configuration/', import.meta.url);
const input = JSON.parse(await fs.readFile(new URL('input.json', fixture))), native = parseLosslessJson((await fs.readFile(new URL('native.json', fixture))).toString('utf8'));
const proof = JSON.parse(await fs.readFile(new URL('provenance.json', fixture)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function heldFile(filename, mode, records) {
  const executable = validationExecutable('dotnet');
  assert.equal(hash(await fs.readFile(executable)), proof.dotnet.sha256);
  assert.equal(hash(await fs.readFile(proof.oracleAssembly.filename)), proof.oracleAssembly.sha256);
  const args = [proof.oracleAssembly.filename, 'hold-file', filename, mode], child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const row = { pid: child.pid, executable, args, beforeSha256: hash(await fs.readFile(filename)), started: new Date().toISOString() }; records.push(row);
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message })); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let output = '', stderr = '', timer;
  child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('READY')) resolve(); });
      child.once('error', reject); child.once('exit', () => reject(new Error('File holder exited before acquiring the lock.')));
      timer = setTimeout(() => reject(new Error('File holder did not acquire the lock.')), 5000); timer.unref();
    });
  } catch (error) { child.kill(); await completion; throw error; }
  finally { clearTimeout(timer); }
  return async () => {
    child.stdin.end('\n');
    row.completion = await completion; row.completed = new Date().toISOString(); row.stderr = stderr;
    row.afterSha256 = hash(await fs.readFile(filename));
    assert.deepEqual(row.completion, { code: 0, signal: null });
  };
}

test('configuration helper matches native recovery, canonical write admission and real file sharing, then native cold read', async t => {
  assert.ok(process.env.MEDIAMANAGER_JELLYFIN_DLL, 'Native configuration cold reads require MEDIAMANAGER_JELLYFIN_DLL and its assembly directory.');
  await fs.access(process.env.MEDIAMANAGER_JELLYFIN_DLL);
  const root = path.join(path.resolve(validationOutputRoot()), 'configuration-files'); await fs.mkdir(root);
  const observations = [], consumers = [], locks = [];
  for (const sample of input.filter(sample => sample.helper)) await t.test(sample.name, async () => {
    const expected = native.results.find(row => row.name === sample.name), directory = path.join(root, sample.name); await fs.mkdir(directory);
    const filename = path.join(directory, 'config.xml');
    if (sample.directory) await fs.mkdir(filename); else if (expected.beforeBytes != null) await fs.writeFile(filename, Buffer.from(expected.beforeBytes, 'base64'));
    if (sample.readOnly) await fs.chmod(filename, 0o444);
    let release, value, error, bytes, reread, coldError;
    try {
      if (sample.locked) release = await heldFile(filename, sample.lockMode ?? 'read', locks);
      try { value = await loadConfigurationFile(filename, sample.root, { processors: native.host.processorCount, rewriteValid: !sample.plugin }); }
      catch (failure) { error = { code: failure.code, message: failure.message }; }
    } finally { await release?.(); if (sample.readOnly) await fs.chmod(filename, 0o666); }
    try { bytes = await fs.readFile(filename); reread = parseConfigurationXml(bytes, sample.root, { processors: native.host.processorCount }); }
    catch (failure) { coldError = failure.message; }
    observations.push({ name: sample.name, accepted: !error, value, error, reread, coldError, afterBytes: bytes?.toString('base64') ?? null });
    if (bytes) consumers.push({ name: sample.name, root: sample.root, filename });
    assert.equal(!error, expected.accepted); if (!error) assert.deepEqual(value, configurationValue(expected.value, sample.root));
    assert.deepEqual(reread ?? null, configurationValue(expected.reread, sample.root));
    assert.equal((await fs.stat(filename)).isDirectory(), expected.afterDirectory);
    if (error || expected.beforeBytes === expected.afterBytes) assert.equal(bytes?.toString('base64') ?? null, expected.afterBytes);
  });
  await fs.writeFile(path.join(root, 'observations.json'), configurationJson(observations), { flag: 'wx' });
  await fs.writeFile(path.join(root, 'locked-processes.json'), configurationJson(locks), { flag: 'wx' });
  const consumerInput = path.join(root, 'consumer-input.json'); await fs.writeFile(consumerInput, configurationJson(consumers), { flag: 'wx' });
  const recording = await recordOracle({ project: 'tests/core/fixtures/configuration/Oracle.csproj', output: path.join(root, 'native-reader'),
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
