import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createBookItemResolver, DirectoryItemResolverPipeline } from '../../src/library/index.js';
import { bookInput, captureBook, recordBookCandidate } from '../metadata/fixtures/book-current/capture.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
const input = await bookInput('directory');
let native;
before(async () => { native = (await captureBook('directory')).native; });
const root = 'Z:\\Books', type = 'MediaBrowser.Controller.Entities.Book';
const candidate = (relative, kind) => ({ identityPath: path.win32.join(root, relative), accessPath: '/books/' + relative.replaceAll('\\', '/'),
  entry: { name: path.win32.basename(relative), kind } });

test('extension-named Book directory observations bind repeated current native filesystem resolution', async () => {
  assert.equal((await captureBook('directory')).report.independentNativeCapturesAgree, true);
  assert.equal(native.results.length, 3);
  assert.deepEqual(native.results.map(value => value.name), input.resolvers.map(value => value.name));
});

for (const sample of input.resolvers) test('Book directory pipeline matches native ' + sample.name, async () => {
  const entries = [...sample.directories.map(value => candidate(value, 'directory')),
    ...sample.files.map(value => candidate(value, 'file'))];
  const target = entries.find(value => value.identityPath === path.win32.join(root, sample.target));
  const pipeline = new DirectoryItemResolverPipeline({ resolvers: [createBookItemResolver()], programDataPath: 'C:\\State' });
  const result = await pipeline.resolve({ candidates: [target], collectionContext: { collectionType: 'books' },
    peekDirectory: async () => ({ listing: { deletionSafe: true }, candidates: entries.filter(value => path.win32.dirname(value.identityPath) === target.identityPath) }) });
  const claim = result.claims[0], expected = native.results.find(value => value.name === sample.name).resolved;
  await recordBookCandidate('directory', sample.name, { nativeType: claim.nativeType, draft: claim.draft,
    path: claim.identityPath.replace(root, '$MEDIA').replaceAll('\\', '/'), consumedPaths: claim.consumedPaths });
  if (!expected) { assert.equal(claim.nativeType, 'MediaBrowser.Controller.Entities.Folder'); return; }
  assert.equal(claim.nativeType, expected.type); assert.equal(claim.draft.IsFolder, expected.IsFolder);
  assert.equal(claim.draft.Name, expected.name); assert.equal(claim.draft.MediaType, expected.mediaType);
  assert.equal(claim.identityPath.replace(root, '$MEDIA').replaceAll('\\', '/'), expected.path);
  assert.deepEqual(claim.directoryParts, []); assert.deepEqual(claim.ownedParts, []);
  assert.equal(claim.draft.columns.IsInMixedFolder, expected.IsInMixedFolder);
  assert.deepEqual(claim.consumedPaths, [target.identityPath, claim.identityPath]);
});

for (const mode of ['unobserved', 'foreign', 'weak', 'directory-part', 'owned-extra', 'folder-shape']) {
  test('Book directory source cannot bypass ' + mode + ' boundary', async () => {
    const primary = candidate('Novel', 'directory'), source = candidate('Novel\\chapter.epub', 'directory');
    const foreign = candidate('Elsewhere\\chapter.epub', 'directory');
    const sibling = candidate('Novel\\part.epub', 'directory');
    const resolver = { id: 'book-source-boundary', priority: 1, nativeTypes: { [type]: { isFolder: mode === 'folder-shape' } },
      async resolveDirectory({ peekDirectory }) {
        if (mode !== 'unobserved') await peekDirectory(primary);
        return { nativeType: type, primary, itemSource: mode === 'foreign' ? foreign : source,
          consumedPaths: mode === 'directory-part' ? [primary, source, sibling] : [primary, mode === 'foreign' ? foreign : source],
          ...(mode === 'directory-part' ? { directoryParts: [sibling] } : {}),
          ...(mode === 'owned-extra' ? { ownedExtras: [] } : {}),
          draft: { Name: 'Novel', IsFolder: mode === 'folder-shape', MediaType: 'Book', SourceType: 'Library' } };
      } };
    const pipeline = new DirectoryItemResolverPipeline({ resolvers: [resolver], programDataPath: 'C:\\State' });
    // Path resolution observes children before a plugin runs. An unobserved
    // source must be absent from that host snapshot as well.
    await assert.rejects(pipeline.resolve({ candidates: [primary], peekDirectory: async () => ({ listing: { deletionSafe: mode !== 'weak' },
      candidates: mode === 'unobserved' ? [] : mode === 'directory-part' ? [source, sibling] : [source] }) }), error => error.code === 'invalid-response');
    await recordBookCandidate('directory', 'invalid-source-' + mode, { errorCode: 'invalid-response' });
  });
}
