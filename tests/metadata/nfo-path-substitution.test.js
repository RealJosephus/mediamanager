import { defaultNfoConfiguration } from '../../plugins/nfo/configuration.js';
import { testFileSystem } from '../storage/plugin-files.js';
import test, { after } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const spoolRoot=await mkdtemp(path.join(os.tmpdir(),'nfo-stream-tests-'));
after(()=>rm(spoolRoot,{recursive:true,force:true}));
import assert from 'node:assert/strict';
import oracle from '../library/fixtures/nfo-path-substitution-oracle.json' with { type: 'json' };
import { tryReplaceSubPath, substitutePath, substituteNfoImagePath } from '../../src/library/path-substitution.js';
import { serializeNfo as prepareNfo } from '../../plugins/nfo/saver.js';
async function serializeNfo(item,context={}) {const prepared=await prepareNfo(item,{fileSystem: testFileSystem, spoolRoot,...context});try {const chunks=[];for await(const chunk of prepared.stream())chunks.push(chunk);return Buffer.concat(chunks);}finally{await prepared.close();}}

test('path substitution matches the frozen Jellyfin DLL for path and image classification cases', async () => {
  for (const sample of oracle.PathCases) {
    const actual = tryReplaceSubPath(sample.Path, sample.From, sample.To);
    assert.equal(actual != null, sample.Matched, sample.Name);
    assert.equal(actual, sample.Result, sample.Name);
  }
  for (const sample of oracle.ImageCases) {
    const replacement = 'substituted::' + sample.Path;
    const actual = substituteNfoImagePath(sample.Path, [{ From: sample.Path, To: replacement }]);
    assert.equal(actual, sample.Result, sample.Path);
  }
});

test('path substitution keeps declaration order and ignores invalid mappings', async () => {
  const mappings = [
    { From: '', To: '/invalid' },
    { From: 'C:\\Media', To: '/first' },
    { From: 'c:\\media', To: '/second' },
  ];
  assert.equal(substitutePath('C:\\MEDIA\\Movie\\poster.jpg', mappings), '/first\\Movie\\poster.jpg');
  assert.equal(substitutePath('D:\\Media\\poster.jpg', mappings), 'D:\\Media\\poster.jpg');
});

test('NFO saver substitutes every local artwork field and does not consult the legacy NFO switch', async () => {
  const mappings = [{ From: 'Z:\\Media', To: '/kodi/media' }, { From: 'Z:\\People', To: '/kodi/people' }];
  const substituteImagePath = value => substituteNfoImagePath(value, mappings);
  const bytes = await serializeNfo({ Type: 'Movie', Name: 'Path fixture' }, {fileSystem: testFileSystem,
    getConfiguration: () => ({ ...defaultNfoConfiguration(), SaveImagePathsInNfo: true, EnablePathSubstitution: false }),
    substituteImagePath,
    images: [
      { Type: 'Primary', Path: 'Z:\\Media\\poster.jpg' },
      { Type: 'Backdrop', Path: 'Z:\\Media\\fanart-b.jpg' },
      { Type: 'Backdrop', Path: 'Z:\\Media\\fanart-a.jpg' },
      { Type: 'Backdrop', Path: 'https://images.invalid/fanart.jpg' },
    ],
    people: [
      { Name: 'Local actor', Type: 'Actor', ImagePath: 'Z:\\People\\actor.jpg' },
      { Name: 'Remote actor', Type: 'Actor', ImagePath: 'HTTP://images.invalid/actor.jpg' },
    ],
  });
  const xml = bytes.toString('utf8');
  assert.match(xml, /<poster>\/kodi\/media\\poster\.jpg<\/poster>/);
  assert.match(xml, /<fanart>\/kodi\/media\\fanart-a\.jpg<\/fanart>/);
  assert.match(xml, /<fanart>\/kodi\/media\\fanart-b\.jpg<\/fanart>/);
  assert.match(xml, /<fanart>https:\/\/images\.invalid\/fanart\.jpg<\/fanart>/);
  assert.match(xml, /<thumb>\/kodi\/people\\actor\.jpg<\/thumb>/);
  assert.match(xml, /<thumb>HTTP:\/\/images\.invalid\/actor\.jpg<\/thumb>/);

  const identity = (await serializeNfo({ Type: 'Movie', Name: 'Identity' }, {fileSystem: testFileSystem,  images: [{ Type: 'Primary', Path: 'Z:\\Media\\poster.jpg' }] })).toString('utf8');
  assert.match(identity, /<poster>Z:\\Media\\poster\.jpg<\/poster>/);
  const disabled = (await serializeNfo({ Type: 'Movie', Name: 'Disabled' }, {fileSystem: testFileSystem,  getConfiguration: () => ({ ...defaultNfoConfiguration(), SaveImagePathsInNfo: false }), substituteImagePath, images: [{ Type: 'Primary', Path: 'Z:\\Media\\poster.jpg' }], people: [{ Name: 'Actor', Type: 'Actor', ImagePath: 'Z:\\People\\actor.jpg' }] })).toString('utf8');
  assert.doesNotMatch(disabled, /<art>|<thumb>/);
});
