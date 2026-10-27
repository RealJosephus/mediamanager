import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { gitCommand, inside, json, removeOwned } from './materials.js';

const gitIdentity = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const namedNotice = name => /(?:^|\/)LICENSES\//iu.test(name)
  || /(?:^|[._-])(?:licen[cs]e|copying|notices?|copyright|authors|patents)(?:[._-]|$)/iu.test(path.posix.basename(name));
const key = name => name.endsWith('/') ? name.slice(0, -1) : name;

function tar(args, cwd) {
  const child = spawn('tar', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error, stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
  child.on('error', value => { error = value; });
  const settled = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, settled, async finish() {
    const { code, signal } = await settled;
    if (error) throw error;
    if (code !== 0 || signal) throw new Error(`Native aggregate source archive reader failed (${signal ?? code}): ${stderr}`);
  } };
}

// Both original gzip and XZ releases are read as streams. No original member path is extracted.
async function archiveContents(filename, members, capture, work) {
  const archive = path.relative(work, filename).split(path.sep).join('/');
  const listing = tar(['-tf', archive], work);
  listing.child.stdout.setEncoding('utf8');
  let output = '', outputBytes = 0;
  try {
    for await (const chunk of listing.child.stdout) {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16 * 1024 * 1024) throw new Error('Native aggregate source listing exceeds its complete-output bound.');
      output += chunk;
    }
    await listing.finish();
  } catch (error) { listing.child.kill(); await listing.settled; throw error; }
  const byPath = new Map(members.map(member => [key(member.path), member]));
  const names = output.split(/\r?\n/u).filter(Boolean).map(key);
  if (byPath.size !== members.length || names.length !== members.length || new Set(names).size !== names.length
    || names.some(name => !byPath.has(name))) throw new Error('Complete native aggregate source membership changed.');
  const files = names.map(name => byPath.get(name)).filter(member => member.kind === 'file');
  const selector = path.join(work, 'regular-members.txt');
  await writeFile(selector, files.map(file => file.path).join('\n') + '\n', { flag: 'wx' });
  const extraction = tar(['-xOf', archive, '-T', path.basename(selector)], work), selected = new Set(capture), captured = new Map();
  let index = 0, bytes = 0, hash = createHash('sha256'), git = createHash('sha1').update(`blob ${files[0]?.bytes ?? 0}\0`), chunks = [];
  const finish = () => {
    const member = files[index];
    if (hash.digest('hex') !== member.sha256 || git.digest('hex') !== member.gitBlob) {
      throw new Error('Original native aggregate source member bytes changed: ' + member.path);
    }
    if (selected.has(member.path)) captured.set(member.path, Buffer.concat(chunks));
    index += 1; bytes = 0; hash = createHash('sha256'); chunks = [];
    if (index < files.length) git = createHash('sha1').update(`blob ${files[index].bytes}\0`);
  };
  try {
    for await (const chunk of extraction.child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        while (index < files.length && bytes === files[index].bytes) finish();
        if (index === files.length) throw new Error('Original native aggregate archive emitted unbound bytes.');
        const length = Math.min(chunk.length - offset, files[index].bytes - bytes), part = chunk.subarray(offset, offset + length);
        hash.update(part); git.update(part);
        if (selected.has(files[index].path)) chunks.push(Buffer.from(part));
        bytes += length; offset += length;
      }
    }
    await extraction.finish();
    while (index < files.length && bytes === files[index].bytes) finish();
    if (index !== files.length || [...selected].some(name => !captured.has(name))) throw new Error('Original native aggregate source stream is incomplete.');
  } catch (error) { extraction.child.kill(); await extraction.settled; throw error; }
  return captured;
}

async function verifyGit(source, members, read) {
  const git = source.git;
  if (!git) return;
  let tree;
  if (git.kind === 'original-git-object') {
    const commit = await read(git.commitObject);
    if (gitIdentity('commit', commit) !== git.commit || !commit.toString('utf8').startsWith('tree ' + git.tree + '\n')) {
      throw new Error('Native aggregate original Git commit changed: ' + source.name);
    }
    tree = JSON.parse(await read(git.treeReceipt));
  } else {
    const receipt = JSON.parse(await read(git.commitReceipt)), original = JSON.parse(await read(git.treeReceipt));
    if (git.commitReceipt.url !== `https://api.github.com/repos/${git.repository}/commits/${git.ref}`
      || git.treeReceipt.url !== `https://api.github.com/repos/${git.repository}/git/trees/${git.tree}?recursive=1`
      || receipt.sha !== git.commit || receipt.commit.tree.sha !== git.tree || original.sha !== git.tree || original.truncated !== false) {
      throw new Error('Native aggregate original Git source receipt changed: ' + source.name);
    }
    tree = original.tree;
  }
  const byPath = new Map(tree.map(member => [member.path, member])), children = new Map();
  if (tree.length !== byPath.size || tree.some(member => member.path.startsWith('/')
    || member.path.split('/').some(part => !part || part === '.' || part === '..')
    || (member.type === 'tree' ? member.mode !== '040000' : member.type === 'commit' ? member.mode !== '160000'
      : member.type !== 'blob' || !['100644', '100755', '120000'].includes(member.mode)))) {
    throw new Error('Native aggregate original Git tree is unsupported.');
  }
  for (const member of tree) {
    const parent = path.posix.dirname(member.path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(member);
  }
  for (const [parent, expected] of [['.', git.tree], ...tree.filter(member => member.type === 'tree').map(member => [member.path, member.sha])]) {
    const name = member => Buffer.from(path.posix.basename(member.path) + (member.type === 'tree' ? '/' : ''));
    const raw = Buffer.concat((children.get(parent) ?? []).toSorted((a, b) => Buffer.compare(name(a), name(b))).map(member => Buffer.concat([
      Buffer.from(member.mode.replace(/^0+/u, '') + ' ' + path.posix.basename(member.path) + '\0'), Buffer.from(member.sha, 'hex'),
    ])));
    if (gitIdentity('tree', raw) !== expected) throw new Error('Native aggregate original Git tree identity changed: ' + source.name);
  }
  if (!isDeepStrictEqual(git.gitlinks, tree.filter(member => member.type === 'commit'))) throw new Error('Native aggregate nested gitlink declaration changed.');
  let ignored = [], attributes;
  if (git.exportAttributes) {
    attributes = await read(git.exportAttributes);
    if (gitIdentity('blob', attributes) !== byPath.get(git.exportAttributes.member)?.sha) throw new Error('Native aggregate original export attributes changed.');
    ignored = attributes.toString('utf8').split(/\r?\n/u).filter(line => !line.startsWith('#') && /\s+export-ignore\s*$/u.test(line))
      .map(line => line.trim().split(/\s+/u)[0]);
    if (ignored.some(pattern => !/^\/?[.A-Za-z0-9_*?-]+\/?$/u.test(pattern))) throw new Error('Unsupported original native archive export rule.');
  }
  const exportRules = ignored.map(pattern => ({ rootOnly: pattern.startsWith('/') || pattern.endsWith('/'),
    expression: new RegExp('^' + pattern.replace(/^\/|\/$/gu, '').replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*') + '$', 'u') }));
  const exportedOut = tree.filter(member => exportRules.some(rule => (rule.rootOnly ? [member.path.split('/')[0]] : member.path.split('/'))
    .some(part => rule.expression.test(part)))).map(member => member.path);
  if (!isDeepStrictEqual(git.exportedOut.toSorted(), exportedOut.toSorted())) throw new Error('Native aggregate archive export omissions differ from original attributes.');
  const expected = new Map(tree.filter(member => !exportedOut.includes(member.path)).map(member => [member.path, member]));
  const converted = new Map();
  for (const conversion of git.exportConversions ?? []) {
    const original = expected.get(conversion.member), repository = new URL(git.repository);
    if (conversion.kind !== 'original-attributes-crlf-export' || conversion.attributeRule !== '*.ps1 text eol=crlf'
      || !conversion.member.endsWith('.ps1') || !attributes?.toString('utf8').split(/\r?\n/u).includes(conversion.attributeRule)
      || original?.type !== 'blob' || original.mode === '120000' || converted.has(conversion.member)
      || repository.origin !== 'https://gitlab.com') {
      throw new Error('Native aggregate export conversion differs from its original attributes.');
    }
    const blob = await read(conversion.originalBlob), http = JSON.parse(await read(conversion.httpReceipt));
    const project = repository.pathname.slice(1).replace(/\.git$/u, ''), url = repository.origin + '/api/v4/projects/'
      + encodeURIComponent(project) + '/repository/blobs/' + original.sha + '/raw';
    if (gitIdentity('blob', blob) !== original.sha || conversion.originalBlob.gitBlob !== original.sha
      || conversion.originalBlob.url !== url || http.requestedUrl !== url || http.status !== 200
      || http.bytes !== blob.length || http.sha256 !== conversion.originalBlob.sha256 || blob.includes(13) || !blob.includes(10)) {
      throw new Error('Native aggregate original Git source blob changed during export conversion.');
    }
    const rendered = Buffer.alloc(blob.length + blob.reduce((count, byte) => count + Number(byte === 10), 0));
    let offset = 0;
    for (const byte of blob) { if (byte === 10) rendered[offset++] = 13; rendered[offset++] = byte; }
    converted.set(conversion.member, { bytes: rendered.length, gitBlob: gitIdentity('blob', rendered), sha256: createHash('sha256').update(rendered).digest('hex') });
  }
  const supplied = members.filter(member => key(member.path) !== source.root.slice(0, -1));
  if (supplied.length !== expected.size) throw new Error('Complete native aggregate Git export is incomplete.');
  for (const member of supplied) {
    const name = key(member.path).slice(source.root.length), original = expected.get(name);
    const kind = ['tree', 'commit'].includes(original?.type) ? 'directory' : original?.mode === '120000' ? 'symlink' : original?.type === 'blob' ? 'file' : undefined;
    const exported = converted.get(name);
    if (kind !== member.kind || kind === 'file' && (member.gitBlob !== (exported?.gitBlob ?? original.sha)
      || exported && (member.sha256 !== exported.sha256 || member.bytes !== exported.bytes)
      || !exported && original.size !== undefined && member.bytes !== original.size || Boolean(member.mode & 0o111) !== (original.mode === '100755'))
      || kind === 'symlink' && (member.gitBlob !== original.sha || gitIdentity('blob', Buffer.from(member.target)) !== original.sha)) {
      throw new Error('Native aggregate source member differs from its original Git blob: ' + source.name + '/' + name);
    }
  }
}

async function checksum(source, read, recipes, root, directory) {
  const proof = source.checksum;
  if (!proof) return;
  if (proof.kind === 'original-mxe-recipe-sha256') {
    const file = recipes.sources.find(recipe => recipe.id === proof.sourceId)?.files.find(file => file.upstreamPath === proof.upstreamPath);
    if (!file) throw new Error('Native aggregate original checksum recipe is missing.');
    const text = (await read(file)).toString('utf8');
    const fields = new Map(text.split(/\r?\n/u).filter(line => line.includes(':=')).map(line => line.split(':=').map(field => field.trim())));
    if (fields.get(proof.prefix + '_VERSION') !== source.version || fields.get(proof.prefix + '_CHECKSUM') !== source.archive.sha256) {
      throw new Error('Native aggregate source differs from its original recipe checksum: ' + source.name);
    }
  } else if (proof.kind === 'original-google-object-metadata') {
    const metadata = JSON.parse(await read(proof.receipt)), http = JSON.parse(await read(proof.httpReceipt));
    const url = new URL(source.archive.url);
    if (url.origin !== 'https://storage.googleapis.com' || url.pathname !== '/' + metadata.bucket + '/' + metadata.name
      || String(source.archive.bytes) !== metadata.size || http.requestedUrl !== `https://storage.googleapis.com/storage/v1/b/${metadata.bucket}/o/${encodeURIComponent(metadata.name)}`) {
      throw new Error('Native aggregate source differs from its original storage object.');
    }
    const hash = createHash('md5');
    for await (const chunk of createReadStream(path.join(root, directory, source.archive.path))) hash.update(chunk);
    if (hash.digest('base64') !== metadata.md5Hash) throw new Error('Native aggregate source differs from its original published object checksum.');
  } else if (proof.kind === 'original-gnome-sha256') {
    const text = (await read(proof.receipt)).toString('utf8'), url = new URL(source.archive.url);
    if (proof.receipt.url !== source.archive.url.replace(/\.tar\.xz$/u, '.sha256sum')
      || !text.split(/\r?\n/u).some(line => line === source.archive.sha256 + '  ' + path.posix.basename(url.pathname))) {
      throw new Error('Native aggregate source differs from its original GNOME checksum.');
    }
    await read(proof.httpReceipt);
  } else if (proof.kind === 'original-github-release-asset') {
    const receipt = JSON.parse(await read(proof.receipt)), asset = receipt.assets.find(asset => asset.browser_download_url === source.archive.url);
    if (!asset || asset.size !== source.archive.bytes || asset.digest !== 'sha256:' + source.archive.sha256
      || receipt.tag_name !== 'lcms' + source.version || proof.receipt.url !== 'https://api.github.com/repos/mm2/Little-CMS/releases/tags/' + receipt.tag_name) {
      throw new Error('Native aggregate source differs from its original release asset digest.');
    }
  } else throw new Error('Unsupported native aggregate original checksum source.');
}

async function prepareUltraHdr(root, patch, read, originals, build) {
  const pull = JSON.parse(await read(patch.pullReceipt)), commits = JSON.parse(await read(patch.commitsReceipt));
  if (patch.repository !== 'google/libultrahdr' || patch.pull !== 383
    || patch.pullReceipt.url !== 'https://api.github.com/repos/google/libultrahdr/pulls/383'
    || patch.commitsReceipt.url !== 'https://api.github.com/repos/google/libultrahdr/pulls/383/commits?per_page=100'
    || pull.number !== 383 || pull.commits !== commits.length || !commits.length || commits.length > 10
    || patch.commits.length !== commits.length || commits.at(-1).sha !== pull.head.sha
    || commits.some((commit, index) => commit.parents.length !== 1 || commit.parents[0].sha !== (index ? commits[index - 1].sha : pull.base.sha))) {
    throw new Error('Ultra HDR patch differs from its original ordered PR commits.');
  }
  const raw = await read(patch.currentResponse), http = JSON.parse(await read(patch.httpReceipt));
  if (patch.originalRecipeUrl !== 'https://patch-diff.githubusercontent.com/raw/google/libultrahdr/pull/383.patch'
    || !build.includes('$CURL ' + patch.originalRecipeUrl + ' | patch -p1') || !build.includes(patch.inlineEdit)
    || patch.inlineEdit !== "sed -i'.bak' 's/CMAKE_CROSSCOMPILING AND UHDR_ENABLE_INSTALL/FALSE/' CMakeLists.txt"
    || http.requestedUrl !== patch.originalRecipeUrl || http.sha256 !== patch.currentResponse.sha256 || http.bytes !== raw.length || http.status !== 200) {
    throw new Error('Ultra HDR patch differs from the actual native recipe or original acquired response.');
  }
  const messages = raw.toString('utf8').split(/(?=^From [a-f0-9]{40} Mon Sep 17 00:00:00 2001\r?$)/gmu).filter(Boolean), patches = [];
  if (messages.length !== commits.length) throw new Error('Ultra HDR PR patch commit sequence is incomplete.');
  const sourceFiles = new Set();
  for (let index = 0; index < commits.length; index += 1) {
    const pin = patch.commits[index], fixed = await read(pin), text = fixed.toString('utf8');
    const commit = commits[index].sha, prefix = 'From ' + commit + ' Mon Sep 17 00:00:00 2001\n';
    if (pin.commit !== commit || pin.url !== 'https://github.com/google/libultrahdr/commit/' + commit + '.patch'
      || !text.startsWith(prefix) || !messages[index].startsWith(prefix)
      || text.slice(text.indexOf('diff --git ')).replace(/\n+$/u, '\n') !== messages[index].slice(messages[index].indexOf('diff --git ')).replace(/\n+$/u, '\n')) {
      throw new Error('Ultra HDR PR diff differs from its immutable commit patch.');
    }
    for (const match of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)) {
      if (match[1] !== match[2] || !['CMakeLists.txt', 'cmake/package.cmake'].includes(match[1])) throw new Error('Ultra HDR patch changes an unexpected source file.');
      sourceFiles.add(match[1]);
    }
    patches.push(fixed);
  }
  if (!isDeepStrictEqual([...sourceFiles].toSorted(), patch.sourceFiles.toSorted()) || originals.size !== sourceFiles.size) throw new Error('Ultra HDR pristine patch input set is incomplete.');
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, 'native-aggregate-patch-'));
  let failed = false, primary, result;
  try {
    for (const [name, bytes] of originals) {
      const filename = path.join(work, name); inside(work, filename);
      await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx' });
    }
    await gitCommand(['init', '--quiet'], { cwd: work });
    await gitCommand(['config', 'core.autocrlf', 'false'], { cwd: work });
    for (let index = 0; index < patches.length; index += 1) {
      const filename = path.join(work, 'commit-' + index + '.patch'); await writeFile(filename, patches[index], { flag: 'wx' });
      await gitCommand(['apply', '--check', filename], { cwd: work });
      await gitCommand(['apply', filename], { cwd: work });
    }
    const cmakeFile = path.join(work, 'CMakeLists.txt'), cmake = await readFile(cmakeFile, 'utf8'), from = 'CMAKE_CROSSCOMPILING AND UHDR_ENABLE_INSTALL';
    if (cmake.split(from).length !== 2) throw new Error('Ultra HDR original inline edit has an unexpected source preimage.');
    await writeFile(cmakeFile, cmake.replace(from, 'FALSE'));
    result = [];
    for (const name of sourceFiles) {
      const bytes = await readFile(path.join(work, name));
      if (bytes.equals(originals.get(name))) throw new Error('Ultra HDR actual source preparation did not change its declared input.');
      result.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  } catch (error) { failed = true; primary = error; }
  try { await removeOwned(parent, work); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], 'Ultra HDR source preparation and cleanup failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
  return result;
}

export async function nativeAggregateSourceMaterials(root, files) {
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const pin = source => {
    const file = source && entries.get(path.posix.join(directory, source.path));
    if (!file || file.kind || file.bytes !== source.bytes || file.sha256 !== source.sha256) throw new Error('Native aggregate material is missing or changed: ' + source?.path);
  };
  const read = async source => { pin(source); return await readFile(path.join(root, directory, source.path)); };
  const offer = await json(path.join(root, directory, 'source-offer.json')), catalog = JSON.parse(await read(offer.nativeAggregateSources));
  if (!isDeepStrictEqual(catalog.profiles.toSorted(), ['darwin-arm64', 'linux-x64-glibc'])
    || catalog.alreadySupplied.nativeFullSources !== offer.nativeFullSources.path || catalog.alreadySupplied.nativePackages !== offer.nativePackages.path) {
    throw new Error('Native aggregate source profile differs from the actual declared POSIX scope.');
  }
  const recipes = JSON.parse(await read(offer.recipeFragments)), recipe = recipes.sources.find(source => source.id === catalog.recipe.sourceId);
  const originalFile = async name => {
    const source = recipe?.files.find(file => file.upstreamPath === name), bytes = await read(source);
    if (gitIdentity('blob', bytes) !== source.gitBlob) throw new Error('Native aggregate original recipe Git blob changed.');
    return bytes.toString('utf8');
  };
  const versionText = await originalFile(catalog.recipe.versionFile), build = await originalFile(catalog.recipe.buildFile);
  const versions = new Map([...versionText.matchAll(/^(VERSION_[A-Z0-9_]+)=([^\r\n]+)\r?$/gmu)].map(match => [match[1], match[2]]));
  const expand = template => template
    .replace(/\$\(without_patch \$(VERSION_[A-Z0-9_]+)\)/gu, (_, name) => versions.get(name).replace(/\.[^.]+$/u, ''))
    .replace(/\$\(without_prerelease \$(VERSION_[A-Z0-9_]+)\)/gu, (_, name) => versions.get(name).split('-')[0])
    .replace(/\$\{(VERSION_[A-Z0-9_]+)\/\/\.\/([^}]+)\}/gu, (_, name, separator) => versions.get(name).replaceAll('.', separator))
    .replace(/\$\{(VERSION_[A-Z0-9_]+)\}/gu, (_, name) => versions.get(name));
  const full = JSON.parse(await read(offer.nativeFullSources)), native = JSON.parse(await read(offer.nativePackages));
  const supplied = new Map([...full.sources, ...native.sharpNativeNotices.components.filter(source => source.archive)].map(source => [source.versionVariable, source]));
  const selected = new Map();
  for (const match of build.matchAll(/^\s*\$CURL (https:\/\/.+?) \| tar [^\r\n]+\$\{DEPS\}\/([a-z0-9-]+)/gmu)) {
    const variable = match[1].match(/VERSION_[A-Z0-9_]+/u)?.[0], previous = supplied.get(variable);
    if (previous) {
      if (previous.version !== versions.get(variable) || previous.downloadTemplate !== match[1] || previous.archive.url !== expand(match[1])) {
        throw new Error('Previously supplied native source differs from its actual recipe selection: ' + previous.name);
      }
    } else selected.set(match[2], { template: match[1], variable });
  }
  if (!selected.size || catalog.components.length !== selected.size || new Set(catalog.components.map(source => source.workingDirectory)).size !== selected.size
    || catalog.components.some(source => !selected.has(source.workingDirectory))) throw new Error('Selected native aggregate source set is incomplete.');
  const checked = [];
  for (const source of catalog.components) {
    const selection = selected.get(source.workingDirectory);
    if (source.downloadTemplate !== selection.template || source.versionVariable !== selection.variable || source.version !== versions.get(selection.variable)
      || source.archive.url !== expand(selection.template) || source.name !== (source.workingDirectory === 'jpeg' ? 'mozjpeg' : source.workingDirectory)) {
      throw new Error('Native aggregate source differs from its actual original version recipe: ' + source.name);
    }
    if (!source.git && !source.checksum) throw new Error('Native aggregate original source identity proof is missing: ' + source.name);
    pin(source.archive);
    const http = JSON.parse(await read(source.httpReceipt));
    if (http.requestedUrl !== source.archive.url || http.status !== 200 || http.bytes !== source.archive.bytes || http.sha256 !== source.archive.sha256) {
      throw new Error('Native aggregate source differs from its acquired original response.');
    }
    const members = JSON.parse(await read(source.members));
    if (!source.root.endsWith('/') || source.root.includes('..') || members.some(member => !key(member.path).startsWith(source.root) && key(member.path) !== source.root.slice(0, -1)
      || member.path.startsWith('/') || /[\\\r\n\0]/u.test(member.path) || member.path.split('/').some(part => part === '.' || part === '..')
      || !['file', 'directory', 'symlink'].includes(member.kind) || !Number.isSafeInteger(member.bytes) || member.bytes < 0)) {
      throw new Error('Native aggregate original archive member is unsupported.');
    }
    const notices = members.filter(member => member.kind === 'file' && namedNotice(member.path)).map(member => member.path);
    if (!isDeepStrictEqual(source.notices.map(notice => notice.member).toSorted(), notices.toSorted())) throw new Error('Native aggregate original notice set is incomplete: ' + source.name);
    await verifyGit(source, members, read);
    await checksum(source, read, recipes, root, directory);
    checked.push({ source, members });
  }
  await read(catalog.instructions);
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, 'native-aggregate-reader-'));
  let failed = false, primary, originals;
  try {
    for (const { source, members } of checked) {
      const cwd = path.join(work, source.name); await mkdir(cwd);
      const captures = [...source.notices.map(file => file.member), ...(source.name === 'uhdr' ? catalog.ultrahdrPatch.sourceFiles.map(name => source.root + name) : [])];
      const contents = await archiveContents(path.join(root, directory, source.archive.path), members, captures, cwd);
      for (const notice of source.notices) {
        if (!contents.get(notice.member)?.equals(await read(notice))) throw new Error('Native aggregate original notice differs from its archive member.');
      }
      if (source.name === 'uhdr') originals = new Map(catalog.ultrahdrPatch.sourceFiles.map(name => [name, contents.get(source.root + name)]));
    }
  } catch (error) { failed = true; primary = error; }
  try { await removeOwned(parent, work); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], 'Native aggregate source reading and cleanup failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
  if (!originals) throw new Error('Ultra HDR original archive is missing from its actual aggregate source set.');
  const preparedPatch = await prepareUltraHdr(root, catalog.ultrahdrPatch, read, originals, build);
  return { path: path.posix.join(directory, offer.nativeAggregateSources.path), limitations: catalog.limitations, preparedPatch };
}
