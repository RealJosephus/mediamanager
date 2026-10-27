import { cp, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { copyRegular, createReleaseDirectory, deliverySkip, dependencyMaterials, dependencySkip, fileIdentity,
  gitCommand, inside, install, json, removeOwned, sourceMaterials, tree, writeJson } from './materials.js';

export async function packageRelease(root, output) {
  root = await realpath(root); output = path.resolve(output);
  inside(path.join(root, '.test-output'), output);
  if (await gitCommand(['status', '--porcelain', '--untracked-files=normal'], { cwd: root })) {
    throw new Error('Commit the candidate before packaging it.');
  }
  const commit = (await gitCommand(['rev-parse', 'HEAD'], { cwd: root })).trim();
  const gitTree = (await gitCommand(['rev-parse', 'HEAD^{tree}'], { cwd: root })).trim();
  const sourceFiles = (await gitCommand(['ls-files', '-z'], { cwd: root })).split('\0').filter(Boolean).sort();
  const temporaryParent = await createReleaseDirectory(root, output);
  const work = path.join(temporaryParent, 'release-build-' + randomUUID()); await mkdir(work);
  try {
    await copyRegular(root, output, sourceFiles);
    const cache = path.join(work, 'cache');
    const npmVersion = await install(output, cache, path.join(work, 'config'));
    const cacheOutput = path.join(output, 'dependency-cache');
    await cp(cache, cacheOutput, { recursive: true, filter: filename => path.basename(filename) !== '_logs' });
    const cacheFiles = await tree(output, 'dependency-cache');
    const dependencies = await dependencyMaterials(output, await json(path.join(output, 'package-lock.json')), cacheFiles);
    const installedFiles = await tree(output, 'node_modules', dependencySkip);
    const files = await tree(output, '', deliverySkip);
    const sources = await sourceMaterials(output, files), pkg = await json(path.join(output, 'package.json'));
    await removeOwned(output, path.join(output, 'node_modules'));
    const delivered = new Map(files.map(file => [file.path, file]));
    for (const filename of sourceFiles) {
      const file = delivered.get(filename);
      if (!file || file.kind) throw new Error('Tracked source was omitted from the release: ' + filename);
      const original = await fileIdentity(path.join(root, filename));
      if (original.bytes !== file.bytes || original.sha256 !== file.sha256) throw new Error('Candidate changed while packaging: ' + file.path);
    }
    if ((await gitCommand(['rev-parse', 'HEAD'], { cwd: root })).trim() !== commit
      || await gitCommand(['status', '--porcelain', '--untracked-files=normal'], { cwd: root })) throw new Error('Candidate changed while packaging.');
    const manifest = {
      candidate: { commit, tree: gitTree }, package: { name: pkg.name, version: pkg.version, license: pkg.license },
      builtWith: { node: process.version, npm: npmVersion, platform: process.platform, architecture: process.arch,
        libc: process.report.getReport().header.glibcVersionRuntime ?? null },
      installation: { command: 'node tools/release/prepare.js', productionOnly: true, lifecycleScripts: false,
        generatedNpmFilesExcluded: ['node_modules/.bin/**', 'node_modules/.package-lock.json'] },
      prerequisites: { node: pkg.engines.node, npm: 'npm bundled with Node.js; the supplied cache is verified with builtWith.npm',
        postgres: 'A prepared PostgreSQL instance with its matching identity, pinned envelope and portable mount contract.',
        mediaTools: 'External valid FFmpeg 4.4 or later and matching ffprobe; neither executable is bundled.',
        startup: 'npm start; choose MEDIAMANAGER_TARGET or the direct MEDIAMANAGER_INSTANCE/POSTGRES/POSTGRES_SCHEMA settings, with STORAGE when required by the persisted mounts.' },
      sourceOffers: sources.offers, knownMaterialLimitations: sources.limitations,
      unresolvedDeclaredDependencyLicenseTexts: dependencies.unavailableLicenseTexts,
      dependencies: dependencies.packages, installedFiles, files,
    };
    await writeJson(path.join(output, 'release.json'), manifest);
    await writeJson(output + '.receipt.json', { candidate: manifest.candidate, builtWith: manifest.builtWith,
      manifest: { path: 'release.json', ...await fileIdentity(path.join(output, 'release.json')) } });
    return manifest;
  } finally { await removeOwned(temporaryParent, work); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Build release packages in GitHub Actions.');
  if (process.argv.length !== 3) throw new Error('Usage: node tools/release/package.js NEW_OUTPUT_UNDER_TEST_OUTPUT');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await packageRelease(root, process.argv[2]);
}
