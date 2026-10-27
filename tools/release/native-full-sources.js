import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildLogMaterials, json, removeOwned } from './materials.js';
import { nativeFallbackSourceMaterials } from './native-fallback-sources.js';

function command(args, cwd) {
  const child = spawn('tar', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error, stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
  child.on('error', value => { error = value; });
  const settled = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, async finish() {
    const { code, signal } = await settled;
    if (error) throw error;
    if (code !== 0 || signal) throw new Error(`Source archive reader failed (${signal ?? code}): ${stderr}`);
  }, settled };
}

async function archiveMembers(filename, members, work) {
  // A relative archive name also avoids GNU tar interpreting a Windows drive as a remote host.
  const archive = path.relative(work, filename).split(path.sep).join('/');
  const listing = command(['-tf', archive], work);
  listing.child.stdout.setEncoding('utf8');
  let output = '', outputBytes = 0;
  try {
    for await (const chunk of listing.child.stdout) {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16 * 1024 * 1024) throw new Error('Source member listing exceeds its complete-output bound.');
      output += chunk;
    }
    await listing.finish();
  } catch (error) { listing.child.kill(); await listing.settled; throw error; }
  const canonical = name => name.endsWith('/') ? name.slice(0, -1) : name;
  const expected = new Map(members.map(member => [canonical(member.path), member]));
  const names = output.split(/\r?\n/u).filter(Boolean).map(canonical);
  if (expected.size !== members.length || names.length !== members.length || new Set(names).size !== names.length
    || names.some(name => !expected.has(name))) throw new Error('Original source archive membership changed.');
  // Select regular files explicitly. Original directories and links remain in the supplied archive;
  // their platform-specific extraction-to-stdout behavior cannot alter the regular-file boundaries.
  const files = names.map(name => expected.get(name)).filter(member => member.kind === 'file');
  if (files.some(file => file.path.includes('\n') || file.path.includes('\r'))) throw new Error('Source file selector contains a line break.');
  const selector = path.join(work, 'regular-members.txt');
  await writeFile(selector, files.map(file => file.path).join('\n') + '\n', { flag: 'wx' });
  const extraction = command(['-xOf', archive, '-T', path.basename(selector)], work);
  let index = 0, bytes = 0, hash = createHash('sha256');
  const finishFile = () => {
    if (hash.digest('hex') !== files[index].sha256) throw new Error('Original source member bytes changed: ' + files[index].path);
    index += 1; bytes = 0; hash = createHash('sha256');
  };
  try {
    for await (const chunk of extraction.child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        while (index < files.length && bytes === files[index].bytes) finishFile();
        if (index === files.length) throw new Error('Source archive emitted unbound file bytes.');
        const length = Math.min(chunk.length - offset, files[index].bytes - bytes);
        hash.update(chunk.subarray(offset, offset + length)); bytes += length; offset += length;
      }
    }
    await extraction.finish();
    while (index < files.length && bytes === files[index].bytes) finishFile();
    if (index !== files.length) throw new Error('Source archive regular-file stream is incomplete.');
  } catch (error) { extraction.child.kill(); await extraction.settled; throw error; }
}

export async function nativeFullSourceMaterials(root, files) {
  const buildLogs = await buildLogMaterials(root, files);
  const directory = 'tools/release/source-materials', entries = new Map(files.map(file => [file.path, file]));
  const offer = await json(path.join(root, directory, 'source-offer.json'));
  const pinned = pin => {
    const member = entries.get(path.posix.join(directory, pin.path));
    if (!member || member.kind || member.bytes !== pin.bytes || member.sha256 !== pin.sha256) {
      throw new Error('Complete native source material is missing or changed: ' + pin.path);
    }
  };
  pinned(offer.nativeFullSources);
  const catalog = await json(path.join(root, directory, offer.nativeFullSources.path));
  const recipes = await json(path.join(root, directory, offer.recipeFragments.path));
  const recipe = recipes.sources.find(source => source.id === catalog.recipe.sourceId);
  const recipeFile = name => recipe.files.find(file => file.upstreamPath === name);
  const versionText = await readFile(path.join(root, directory, recipeFile(catalog.recipe.versionFile).path), 'utf8');
  const build = await readFile(path.join(root, directory, recipeFile(catalog.recipe.buildFile).path), 'utf8');
  const versions = new Map([...versionText.matchAll(/^(VERSION_[A-Z0-9_]+)=([^\r\n]+)\r?$/gmu)].map(match => [match[1], match[2]]));
  const expand = template => template
    .replace(/\$\(without_patch \$(VERSION_[A-Z0-9_]+)\)/gu, (_, name) => versions.get(name).replace(/\.[^.]+$/u, ''))
    .replace(/\$\(without_prerelease \$(VERSION_[A-Z0-9_]+)\)/gu, (_, name) => versions.get(name).split('-')[0])
    .replace(/\$\{(VERSION_[A-Z0-9_]+)\}/gu, (_, name) => versions.get(name));
  const native = await json(path.join(root, directory, offer.nativePackages.path));
  for (const platform of native.sharpNativeNotices.platforms) {
    if (platform.platform !== process.platform || platform.architecture !== process.arch) continue;
    const actual = await json(path.join(root, platform.versions.member));
    for (const source of catalog.sources) {
      if (actual[source.name] !== source.version) throw new Error('Installed native source version differs: ' + source.name);
    }
  }
  const checked = [];
  for (const source of catalog.sources) {
    pinned(source.archive); pinned(source.members);
    if (versions.get(source.versionVariable) !== source.version || !build.includes(source.downloadTemplate)
      || expand(source.downloadTemplate) !== source.archive.url || !build.includes(source.modifications.posix.originalRegion)) {
      throw new Error('Complete source differs from its original version recipe: ' + source.name);
    }
    const checksum = source.checksumSource;
    if (checksum.receipt) {
      pinned(checksum.receipt);
      const original = await readFile(path.join(root, directory, checksum.receipt.path), 'utf8');
      if (checksum.url !== source.archive.url + '.sha256sum' || original.trim().split(/\s+/u)[0] !== source.archive.sha256) {
        throw new Error('Complete source differs from its original published checksum: ' + source.name);
      }
    } else {
      const owner = recipes.sources.find(owner => owner.id === checksum.sourceId);
      const file = owner?.files.find(file => file.upstreamPath === checksum.upstreamPath);
      if (!file) throw new Error('Complete source checksum recipe is absent: ' + source.name);
      const fields = new Map((await readFile(path.join(root, directory, file.path), 'utf8')).split(/\r?\n/u)
        .filter(line => line.includes(':=')).map(line => line.split(':=').map(value => value.trim())));
      if (fields.get(checksum.variablePrefix + '_VERSION') !== source.version
        || fields.get(checksum.variablePrefix + '_CHECKSUM') !== source.archive.sha256) {
        throw new Error('Complete source differs from its original recipe checksum: ' + source.name);
      }
    }
    const members = await json(path.join(root, directory, source.members.path));
    const byPath = new Map(members.map(member => [member.path, member]));
    for (const notice of source.notices) {
      pinned(notice);
      const member = byPath.get(notice.member);
      if (member?.kind !== 'file' || member.bytes !== notice.bytes || member.sha256 !== notice.sha256) {
        throw new Error('Complete source notice differs from its archive member: ' + notice.member);
      }
    }
    for (const patch of source.modifications.posix.patches) {
      if (!recipes.patches.some(original => original.path === patch.path && original.url === patch.url)) {
        throw new Error('Complete source patch differs from its original recipe: ' + source.name);
      }
    }
    const windows = recipes.sources.find(owner => owner.id === source.modifications.windows.sourceId);
    for (const patch of source.modifications.windows.patches) {
      if (!windows.files.some(original => original.path === patch.path && original.upstreamPath === patch.upstreamPath)) {
        throw new Error('Complete Windows source patch differs from its original Git recipe: ' + source.name);
      }
    }
    checked.push({ source, members });
  }
  if (!entries.has(path.posix.join(directory, catalog.instructions))) throw new Error('Complete native source access instructions are missing.');
  await nativeFallbackSourceMaterials(root, files);
  const parent = path.join(root, '.test-output'); await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, 'native-source-reader-'));
  let failed = false, primary;
  try {
    for (const { source, members } of checked) {
      const target = path.join(work, source.name); await mkdir(target);
      await archiveMembers(path.join(root, directory, source.archive.path), members, target);
    }
  } catch (error) { failed = true; primary = error; }
  try { await removeOwned(parent, work); }
  catch (error) {
    if (failed) throw new AggregateError([primary, error], primary?.message ?? 'Source reader and cleanup failed.', { cause: primary });
    throw error;
  }
  if (failed) throw primary;
  return { path: path.posix.join(directory, offer.nativeFullSources.path), limitations: catalog.limitations, buildLogs };
}
