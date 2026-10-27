import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileIdentity, inside, json, tree } from '../materials.js';

export async function recombinationInputs(root) {
  const directory = path.join(root, 'tools/release/source-materials');
  const own = path.join(root, 'tools/release/native-recombination-linux');
  const offer = await json(path.join(directory, 'source-offer.json'));
  const profile = await json(path.join(own, 'profile.json'));
  const pins = [];
  async function pinned(pin, base = directory) {
    inside(base, path.join(base, pin.path));
    const actual = await fileIdentity(path.join(base, pin.path));
    assert.deepEqual(actual, { bytes: pin.bytes, sha256: pin.sha256 }, 'A supplied recombination source input changed: ' + pin.path);
    pins.push({ path: path.relative(root, path.join(base, pin.path)).split(path.sep).join('/'), ...actual });
    return readFile(path.join(base, pin.path));
  }
  const catalog = JSON.parse(await pinned(offer.nativeFullSources));
  const recipes = JSON.parse(await pinned(offer.recipeFragments));
  const source = catalog.sources.find(value => value.name === profile.source);
  assert.ok(source && source.version === profile.version, 'The recombination source differs from the actual supplied version.');
  const recipe = recipes.sources.find(value => value.id === catalog.recipe.sourceId);
  const buildPin = recipe.files.find(value => value.upstreamPath === catalog.recipe.buildFile);
  const versionPin = recipe.files.find(value => value.upstreamPath === catalog.recipe.versionFile);
  const originalPatch = recipes.patches.find(value => value.path === profile.originalPatch);
  assert.ok(buildPin && versionPin && originalPatch, 'The original native build inputs are incomplete.');
  const build = (await pinned(buildPin)).toString('utf8');
  const versions = (await pinned(versionPin)).toString('utf8');
  assert.ok(versions.split(/\r?\n/u).includes(source.versionVariable + '=' + source.version), 'The source version differs from its actual producer selection.');
  assert.ok(build.includes(source.modifications.posix.originalRegion), 'The original libvips build region changed.');
  assert.deepEqual(source.modifications.posix.patches.map(value => value.path), [profile.originalPatch]);
  await pinned(originalPatch);
  await pinned(source.archive);
  const members = JSON.parse(await pinned(source.members));
  // This complete source release contains only regular files and directories.
  // Refuse a changed container before tar gets permission to extract it.
  assert.ok(members.length && new Set(members.map(value => value.path)).size === members.length, 'The complete source membership is invalid.');
  for (const member of members) {
    assert.ok(['file', 'directory'].includes(member.kind) && !member.path.includes('\\')
      && !member.path.includes('\0') && !member.path.includes('\n') && !member.path.includes('\r')
      && !member.path.split('/').some(value => ['', '.', '..'].includes(value))
      && (member.path === source.root.slice(0, -1) || member.path.startsWith(source.root)), 'Unsafe or unsupported original source member.');
  }
  const ownInputs = ['profile.json', 'png-red-bias.patch', 'inputs.js', 'build.js', 'consumer.js', 'verify.js'];
  for (const name of ownInputs) pins.push({ path: 'tools/release/native-recombination-linux/' + name, ...await fileIdentity(path.join(own, name)) });
  return { profile, source, members, recipe: { candidate: recipe.candidate, build: buildPin, versions: versionPin, patch: originalPatch }, pins };
}

export function replaceOnce(text, before, after, description) {
  assert.equal(text.split(before).length, 2, 'The original source edit is no longer unique: ' + description);
  return text.replace(before, after);
}

export function originalPatchForExecution(original) {
  const appendLf = original.at(-1) !== 0x0a;
  return { bytes: appendLf ? Buffer.concat([original, Buffer.from('\n')]) : Buffer.from(original),
    transformation: appendLf ? 'append-one-terminal-LF' : 'none' };
}

export async function pristineSourceSnapshot(sourceRoot, members, archiveRoot) {
  const actual = await tree(sourceRoot);
  const expected = members.filter(value => value.kind === 'file').map(value => ({ path: value.path.slice(archiveRoot.length), bytes: value.bytes, sha256: value.sha256 }));
  const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  // tree traverses directories before their dotted sibling files; the archive
  // membership is independent of that traversal order. Bind every complete
  // member and its bytes using the same path ordering on both sides.
  assert.deepEqual(actual.toSorted(byPath), expected.toSorted(byPath),
    'Extracted complete libvips files differ from the supplied pristine archive.');
  return actual;
}

export function originalInlineEdits(files) {
  return {
    'libvips/meson.build': replaceOnce(replaceOnce(files['libvips/meson.build'], "library('vips'", "static_library('vips'", 'static C aggregate'),
      '    version: library_version,\n    darwin_versions: darwin_versions,\n', '', 'static C version removal'),
    'cplusplus/meson.build': replaceOnce(files['cplusplus/meson.build'], "    gnu_symbol_visibility: 'hidden',\n",
      "    gnu_symbol_visibility: 'hidden',\n    link_args: nodelete_link_args,\n", 'Linux nodelete'),
    'meson.build': replaceOnce(files['meson.build'], "subdir('man')\nsubdir('po')\nsubdir('tools')\nsubdir('test')\nsubdir('fuzz')\n", '', 'producer excluded tools and tests'),
  };
}
