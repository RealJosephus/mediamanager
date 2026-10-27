import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { readArchiveBytes, readZipDirectory, zipEntryDataRange } from '../../src/storage/zip-directory.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const sameSet = (a, b) => isDeepStrictEqual([...a].toSorted(), [...b].toSorted());
const key = node => node.target + '~' + node.package;
const words = text => text.trim() ? text.trim().split(/\s+/u) : [];
const columns = ['target', 'package', 'type', 'enabled', 'normal', 'orderOnly', 'allSource', 'buildRule', 'version', 'checksum', 'file', 'subdir', 'url', 'url2', 'patches'];

function zipMembers(filename, size) {
  const fd = openSync(filename, 'r'), members = new Map(); let primary, failed = false;
  try {
    for (const entry of readZipDirectory(fd, size).entries) {
      if (entry.isDirectory) continue;
      if (members.has(entry.key) || entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 32 * 1024 * 1024) throw new Error('Original Windows native graph artifact member is unsupported.');
      const range = zipEntryDataRange(fd, entry, size), compressed = readArchiveBytes(fd, range.start, entry.compressedSize, size);
      const bytes = entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: entry.size + 1 }) : compressed;
      if (bytes.length !== entry.size) throw new Error('Original Windows native graph ZIP member length changed.');
      members.set(entry.key, bytes);
    }
  } catch (error) { primary = error; failed = true; }
  try { closeSync(fd); }
  catch (error) { if (failed) throw new AggregateError([primary, error], 'Windows graph read and close failed.', { cause: primary }); throw error; }
  if (failed) throw primary;
  return members;
}

function records(bytes, phase) {
  const rows = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean), header = rows.shift()?.split('\t');
  if (header?.length !== 4 || header[0] !== 'META' || header[1] !== phase || !header[2]) throw new Error('Original Windows GNU Make metadata header is incomplete.');
  const nodes = new Map();
  for (const row of rows) {
    const fields = row.split('\t');
    if (fields.length !== columns.length) throw new Error('Original Windows GNU Make metadata record is incomplete.');
    const node = Object.fromEntries(columns.map((column, index) => [column, fields[index]]));
    for (const field of ['normal', 'orderOnly', 'allSource', 'patches']) node[field] = words(node[field]);
    if (nodes.has(key(node))) throw new Error('Original Windows GNU Make metadata node is duplicated.');
    nodes.set(key(node), node);
  }
  return { build: header[2], targets: words(header[3]), nodes };
}

export async function readWindowsNativeGraph(root, catalog, read, inputs) {
  const graph = catalog.graph, run = JSON.parse(await read(graph.runReceipt)), jobs = JSON.parse(await read(graph.jobsReceipt)), artifacts = JSON.parse(await read(graph.artifactsReceipt));
  const job = jobs.jobs.find(job => job.id === graph.jobId), artifact = artifacts.artifacts.find(artifact => artifact.id === graph.artifactId);
  const workflow = graph.producer.filter(file => file.upstreamPath.startsWith('.github/workflows/'));
  if (run.id !== graph.runId || run.repository.full_name !== 'RealJosephus/mediamanager' || run.status !== 'completed' || run.conclusion !== 'success'
    || workflow.length !== 1 || run.path !== workflow[0].upstreamPath
    || !job || job.run_id !== run.id || job.head_sha !== run.head_sha || job.status !== 'completed' || job.conclusion !== 'success'
    || !artifact || artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
    || artifact.name !== 'windows-native-source-graph-' + run.head_sha || artifact.size_in_bytes !== graph.archive.bytes
    || artifact.digest !== 'sha256:' + graph.archive.sha256) throw new Error('Windows native graph differs from its actual successful CI source.');
  await read(graph.archive);
  const members = zipMembers(path.join(root, 'tools/release/source-materials', graph.archive.path), graph.archive.bytes);
  if (!sameSet(members.keys(), graph.members.map(member => member.member))) throw new Error('Original Windows native graph ZIP membership is incomplete.');
  for (const member of graph.members) {
    const original = members.get(member.member);
    if (original.length !== member.bytes || sha256(original) !== member.sha256 || crc32(original) !== member.crc32 || !original.equals(await read(member))) {
      throw new Error('Held Windows native graph member differs from its original ZIP.');
    }
  }
  const original = name => {
    const bytes = members.get('mxe-native-source-graph/' + name);
    if (!bytes) throw new Error('Original Windows native graph member is absent: ' + name);
    return bytes;
  };
  const receipt = JSON.parse(original('receipt.json'));
  if (!receipt.completed || receipt.compiledNativePackages !== false || receipt.target !== inputs.catalog.target || receipt.package !== inputs.catalog.package
    || receipt.candidate.commit !== run.head_sha || receipt.candidate.tree !== run.head_commit.tree_id
    || receipt.inputs.path !== inputs.catalogPath || receipt.inputs.bytes !== inputs.catalogIdentity.bytes || receipt.inputs.sha256 !== inputs.catalogIdentity.sha256
    || !isDeepStrictEqual(receipt.plugins, inputs.catalog.plugins)) throw new Error('Windows native graph differs from its actual source input profile.');
  const trees = new Map();
  for (const tree of graph.producerTrees) {
    const raw = await read(tree.object), children = new Map(); let offset = 0;
    if (gitIdentity('tree', raw) !== tree.gitTree) throw new Error('Windows native graph producer Git tree changed.');
    while (offset < raw.length) {
      const zero = raw.indexOf(0, offset), record = raw.subarray(offset, zero).toString('utf8'), space = record.indexOf(' ');
      if (zero < offset || zero + 21 > raw.length || space < 1) throw new Error('Windows native graph producer tree is incomplete.');
      children.set(record.slice(space + 1), { mode: record.slice(0, space), sha: raw.subarray(zero + 1, zero + 21).toString('hex') }); offset = zero + 21;
    }
    trees.set(tree.prefix, { sha: tree.gitTree, children });
  }
  if (trees.get('')?.sha !== receipt.candidate.tree) throw new Error('Windows native graph producer tree differs from its actual candidate.');
  for (const [prefix, tree] of trees) {
    if (!prefix) continue;
    const parent = path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix), child = trees.get(parent)?.children.get(path.posix.basename(prefix));
    if (child?.sha !== tree.sha || child.mode !== '40000') throw new Error('Windows native graph producer subtree differs from its original parent.');
  }
  for (const file of graph.producer) {
    const raw = await read(file), child = trees.get(path.posix.dirname(file.upstreamPath))?.children.get(path.posix.basename(file.upstreamPath));
    if (child?.sha !== file.gitBlob || gitIdentity('blob', raw) !== file.gitBlob) throw new Error('Windows native graph producer source blob changed.');
  }
  for (const stem of ['extract-mxe', 'extract-build-win64-mxe', 'make-version', 'make-edges', 'make-sources']) {
    const result = JSON.parse(original(stem + '.command.json'));
    if (result.code !== 0 || result.signal !== null || result.overflow || result.expired) throw new Error('Original Windows native graph command was incomplete.');
  }
  const edges = records(original('edges.tsv'), 'edges'), sources = records(original('sources.tsv'), 'sources');
  if (edges.build !== receipt.buildHost || sources.build !== edges.build || !sameSet(sources.targets, edges.targets)) throw new Error('Original Windows native build-host observations differ.');
  const selected = new Map(), boundaries = new Map(), pending = [receipt.target + '~' + receipt.package];
  while (pending.length) {
    const identity = pending.shift(); if (selected.has(identity) || boundaries.has(identity)) continue;
    const node = edges.nodes.get(identity);
    if (!node) throw new Error('Actual Windows native dependency is missing from its original graph.');
    if (node.target !== receipt.target || inputs.catalog.toolBoundaries.includes(node.package)) {
      boundaries.set(identity, node); continue;
    }
    if (node.enabled !== 'true' && !['meta', 'script'].includes(node.type)) throw new Error('Actual selected Windows native rule is disabled.');
    selected.set(identity, node);
    for (const dependency of node.normal) {
      const match = dependency.match(/^([^/]+)\/installed\/([A-Za-z0-9+_.-]+)$/u);
      if (!match) throw new Error('Original Windows native prerequisite is unsupported.');
      pending.push(match[1] + '~' + match[2]);
    }
  }
  if (!sameSet(selected.keys(), sources.nodes.keys()) || !sameSet(boundaries.keys(), receipt.toolBoundaries.map(key))) throw new Error('Windows native graph selection differs from its original prerequisites.');
  const observed = new Map(receipt.selected.map(node => [key(node), node]));
  for (const [identity, node] of sources.nodes) {
    if (!isDeepStrictEqual(node, observed.get(identity)) || ['normal', 'orderOnly', 'allSource'].some(field => !isDeepStrictEqual(node[field], selected.get(identity)[field]))) {
      throw new Error('Windows native selected source metadata differs between its original observations.');
    }
  }
  const required = new Map();
  for (const node of sources.nodes.values()) {
    if (!/^[a-f0-9]{64}$/u.test(node.checksum) || !/^[A-Za-z0-9_.+-]+$/u.test(node.file) || !node.url) throw new Error('Actual Windows native source identity is incomplete.');
    const identity = node.file + ':' + node.checksum;
    if (!required.has(identity)) required.set(identity, { file: node.file, sha256: node.checksum, url: node.url, url2: node.url2, packages: [] });
    required.get(identity).packages.push(node.package);
  }
  if (!isDeepStrictEqual([...required.values()], receipt.requiredContainers)) throw new Error('Windows native source container set differs from its original selected graph.');
  const patches = new Map();
  for (const node of sources.nodes.values()) {
    for (const filename of node.patches) {
      const matches = receipt.patches.filter(patch => {
        const source = inputs.catalog.sources.find(source => source.name === patch.source);
        return source && filename.endsWith('/' + source.name + '/' + source.root + patch.path);
      });
      if (matches.length !== 1) throw new Error('Windows native selected patch lacks its original source-container role.');
      const patch = matches[0], source = inputs.catalog.sources.find(source => source.name === patch.source);
      const inventory = JSON.parse(await read(source.members)), member = inventory.find(member => member.path === source.root + patch.path);
      const bytes = original('patches/' + patch.source + '/' + patch.path);
      if (member?.kind !== 'file' || member.bytes !== patch.bytes || member.sha256 !== patch.sha256 || bytes.length !== patch.bytes || sha256(bytes) !== patch.sha256) {
        throw new Error('Windows native patch differs from its complete original source container.');
      }
      patches.set(patch.source + '/' + patch.path, { ...patch, content: bytes });
    }
  }
  if (!sameSet(patches.keys(), receipt.patches.map(patch => patch.source + '/' + patch.path))) throw new Error('Windows native original patch set is incomplete.');
  return { receipt, required, patches, members };
}
