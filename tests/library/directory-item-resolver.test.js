import test from 'node:test';
import assert from 'node:assert/strict';
import { getNewItemId } from '../../src/core/identity.js';
import { nativeGuid } from '../../src/users/native.js';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const movieNativeType = 'MediaBrowser.Controller.Entities.Movies.Movie';
const videoNativeType = 'MediaBrowser.Controller.Entities.Video';
const trailerNativeType = 'MediaBrowser.Controller.Entities.Trailer';
const rootPath = 'Z:\\Library';

function candidate(name, kind = 'file') {
  return {
    identityPath: `${rootPath}\\${name}`,
    accessPath: `/library/${name.replaceAll('\\', '/')}`,
    entry: { kind, name }
  };
}

function movieClaim(primary, consumedPaths = [primary]) {
  const name = typeof primary === 'string' ? primary.split(/[\\/]/u).at(-1) : primary.entry.name;
  return {
    nativeType: movieNativeType,
    primary,
    consumedPaths,
    traversal: 'none',
    draft: {
      Name: name,
      IsFolder: false,
      MediaType: 'Video',
      SourceType: 'Library'
    }
  };
}

function resolver(id, methods, { priority = 0, nativeTypes = { [movieNativeType]: { isFolder: false } },
  productionMediaScope } = {}) {
  return { id, priority, nativeTypes, ...(productionMediaScope == null ? {} : { productionMediaScope }), ...methods };
}

function pipeline(resolvers, configuration = {}) {
  return new DirectoryItemResolverPipeline({ resolvers, programDataPath, configuration });
}

test('the internal Folder fallback resolver id is reserved', () => {
  assert.throws(() => pipeline([resolver('folder-fallback', { resolveFile() { return null; } })]), /reserved/u);
});

test('production media capabilities require a declared nonempty scope', () => {
  const generic = pipeline([resolver('generic', { resolveFile() { return null; } })]);
  assert.deepEqual(generic.capabilities, {
    resolvesProductionMediaFiles: false,
    productionMediaScopes: []
  });

  const production = pipeline([resolver('production', { resolveFile() { return null; } }, {
    productionMediaScope: 'ordinary-video-files'
  })]);
  assert.equal(production.capabilities.resolvesProductionMediaFiles, true);
  assert.deepEqual(production.capabilities.productionMediaScopes, ['ordinary-video-files']);
  assert.ok(Object.isFrozen(production.capabilities.productionMediaScopes));
  assert.throws(() => pipeline([resolver('empty-scope', { resolveFile() { return null; } }, {
    productionMediaScope: ''
  })]), /production media scope/u);
  assert.throws(() => pipeline([resolver('numeric-scope', { resolveFile() { return null; } }, {
    productionMediaScope: 1
  })]), /production media scope/u);
});

test('a multi winner hands only explicit extraFiles to singles and keeps consumedPaths independent', async () => {
  const first = candidate('Film-cd1.mkv');
  const second = candidate('Film-cd2.mkv');
  const withheld = candidate('Ignored.mkv');
  const loose = candidate('Loose.mkv');
  const calls = [];
  const subject = pipeline([
    resolver('never-multi', {
      resolveMultiple() {
        calls.push('never-multi');
        throw new Error('a later multi resolver must not run');
      }
    }, { priority: 30 }),
    resolver('single', {
      resolveFile({ candidate: current }) {
        calls.push(`single:${current.entry.name}`);
        return movieClaim(current);
      }
    }, { priority: 5 }),
    resolver('winner-multi', {
      resolveMultiple({ available }) {
        calls.push(`winner-multi:${available.map(value => value.entry.name).join(',')}`);
        return { items: [movieClaim(first, [first, second])], extraFiles: [loose] };
      }
    }, { priority: 20 }),
    resolver('empty-multi', {
      resolveMultiple({ available }) {
        calls.push(`empty-multi:${available.map(value => value.entry.name).join(',')}`);
        return { items: [], extraFiles: [] };
      }
    }, { priority: 10 })
  ]);

  const result = await subject.resolve({ candidates: [loose, withheld, second, first] });

  assert.deepEqual(calls, [
    'empty-multi:Loose.mkv,Ignored.mkv,Film-cd2.mkv,Film-cd1.mkv',
    'winner-multi:Loose.mkv,Ignored.mkv,Film-cd2.mkv,Film-cd1.mkv',
    'single:Loose.mkv'
  ]);
  assert.deepEqual(result.claims.map(claim => ({
    resolverId: claim.resolverId,
    path: claim.identityPath,
    consumedPaths: claim.consumedPaths
  })), [
    { resolverId: 'winner-multi', path: first.identityPath, consumedPaths: [first.identityPath, second.identityPath] },
    { resolverId: 'single', path: loose.identityPath, consumedPaths: [loose.identityPath] }
  ]);
  assert.deepEqual(result.passedToSingle, [loose.identityPath]);
  assert.deepEqual(result.withheldPaths, [withheld.identityPath]);
  assert.deepEqual(result.unclaimedPaths, [withheld.identityPath]);
  assert.equal(result.consumedPaths.size, 3);
});

test('local alternate claims are deterministic subordinate items without resolver-owned relationships', async () => {
  const primary = candidate('Film.mkv');
  const alternate = candidate('Film - 2160p.mkv');
  const subject = pipeline([resolver('versions', {
    resolveMultiple() {
      return {
        items: [{
          ...movieClaim(primary, [primary, alternate]),
          draft: { ...movieClaim(primary).draft, data: { LocalAlternateVersions: [alternate.identityPath] } },
          localAlternates: [{ primary: alternate, draft: movieClaim(alternate).draft }]
        }],
        extraFiles: []
      };
    }
  })]);

  const result = await subject.resolve({ candidates: [alternate, primary] });
  const [claim] = result.claims;
  assert.equal(claim.localAlternates.length, 1);
  const [owned] = claim.localAlternates;
  assert.equal(owned.Id, nativeGuid(getNewItemId(alternate.identityPath, movieNativeType, {
    programDataPath,
    enableCaseSensitiveItemIds: false
  })));
  assert.equal(owned.identityPath, alternate.identityPath);
  assert.equal(owned.nativeType, movieNativeType);
  assert.equal(owned.traversal, 'none');
  assert.deepEqual(owned.consumedPaths, [alternate.identityPath]);
  assert.deepEqual(claim.draft.data.LocalAlternateVersions, [alternate.identityPath]);
  assert.ok(Object.isFrozen(claim.localAlternates));
  assert.ok(Object.isFrozen(owned));
  assert.equal(Object.hasOwn(owned.draft, 'OwnerId'), false);
  assert.equal(Object.hasOwn(owned.draft, 'PrimaryVersionId'), false);
});

test('local alternate claims reject inconsistent paths, shapes and relationship injection', async t => {
  const primary = candidate('Film.mkv');
  const alternate = candidate('Film - 2160p.mkv');
  const outside = candidate('Outside.mkv');
  const run = (localAlternate, declaredPaths = [alternate.identityPath]) => pipeline([resolver('invalid-versions', {
    resolveMultiple() {
      return {
        items: [{
          ...movieClaim(primary, [primary, alternate]),
          draft: { ...movieClaim(primary).draft, data: { LocalAlternateVersions: declaredPaths } },
          localAlternates: [localAlternate]
        }],
        extraFiles: [outside]
      };
    }
  })]).resolve({ candidates: [outside, alternate, primary] });
  for (const [name, localAlternate, message, declaredPaths] of [
    ['outside consumed claim', { primary: outside, draft: movieClaim(outside).draft }, /outside its consumed sibling claim/u],
    ['relationship injection', { primary: alternate, draft: { ...movieClaim(alternate).draft, OwnerId: primary.identityPath } }, /unsupported relationship field OwnerId/u],
    ['folder shape', { primary: alternate, draft: { ...movieClaim(alternate).draft, IsFolder: true } }, /wrong folder shape/u],
    ['unsupported key', { primary: alternate, draft: movieClaim(alternate).draft, OwnerId: primary.identityPath }, /invalid local alternate version/u],
    ['mismatched declaration', { primary: alternate, draft: movieClaim(alternate).draft }, /inconsistent local alternate version paths/u, []]
  ]) await t.test(name, async () => {
    await assert.rejects(run(localAlternate, declaredPaths), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, message);
      return true;
    });
  });
});

test('owned-part claims bind deterministic Video identity and declared path order to one owner', async () => {
  const primary = candidate('Film cd1.mkv');
  const tenth = candidate('Film cd10.mkv');
  const second = candidate('Film cd2.mkv');
  const raw = {
    ...movieClaim(primary, [primary, tenth, second]),
    draft: { ...movieClaim(primary).draft, data: { AdditionalParts: [tenth.identityPath, second.identityPath] } },
    ownedParts: [tenth, second].map(part => ({
      primary: part,
      nativeType: videoNativeType,
      owner: primary,
      draft: movieClaim(part).draft
    }))
  };
  const subject = pipeline([resolver('owned-parts', {
    resolveMultiple() { return { items: [raw], extraFiles: [] }; }
  }, { nativeTypes: { [movieNativeType]: { isFolder: false }, [videoNativeType]: { isFolder: false } } })]);

  const strong = await subject.resolve({ candidates: [second, primary, tenth] });
  const [claim] = strong.claims;
  assert.equal(claim.ownsOwnedParts, true);
  assert.equal(claim.ownedPartsDeletionSafe, true);
  assert.deepEqual(claim.ownedParts.map(part => part.identityPath), [tenth.identityPath, second.identityPath]);
  assert.deepEqual(claim.ownedParts.map(part => part.Id), [tenth, second].map(part => nativeGuid(getNewItemId(
    part.identityPath, videoNativeType, { programDataPath, enableCaseSensitiveItemIds: false }))));
  assert.ok(claim.ownedParts.every(part => part.ownerId === claim.Id && part.nativeType === videoNativeType));
  assert.ok(Object.isFrozen(claim.ownedParts));
  assert.ok(claim.ownedParts.every(Object.isFrozen));

  const weak = await subject.resolve({ candidates: [second, primary, tenth], deletionSafe: false });
  assert.equal(weak.claims[0].ownedPartsDeletionSafe, false);
});

test('owned-part claims reject undeclared, unordered, injected and out-of-family plans', async t => {
  const primary = candidate('Film cd1.mkv');
  const second = candidate('Film cd2.mkv');
  const outside = candidate('Outside.mkv');
  const make = overrides => ({
    ...movieClaim(primary, [primary, second]),
    draft: { ...movieClaim(primary).draft, data: { AdditionalParts: [second.identityPath] } },
    ownedParts: [{
      primary: second,
      nativeType: videoNativeType,
      owner: primary,
      draft: movieClaim(second).draft,
      ...overrides
    }]
  });
  const run = (claim, nativeTypes = { [movieNativeType]: { isFolder: false }, [videoNativeType]: { isFolder: false } }) =>
    pipeline([resolver('invalid-owned-part', {
      resolveMultiple() { return { items: [claim], extraFiles: [outside] }; }
    }, { nativeTypes })]).resolve({ candidates: [outside, second, primary] });
  const cases = [
    ['outside consumed claim', make({ primary: outside }), /outside its consumed claim/u],
    ['unknown owner', make({ owner: outside }), /outside its consumed claim/u],
    ['undeclared native type', make({ nativeType: 'Plugin.Entities.Part' }), /undeclared owned part type/u],
    ['relationship injection', make({ draft: { ...movieClaim(second).draft, OwnerId: primary.identityPath } }), /unsupported relationship field OwnerId/u],
    ['unsupported key', { ...make({}), ownedParts: [{ ...make({}).ownedParts[0], unexpected: true }] }, /invalid owned part/u],
    ['mismatched declaration', { ...make({}), draft: { ...movieClaim(primary).draft, data: { AdditionalParts: [] } } }, /inconsistent additional-part paths/u]
  ];
  for (const [name, claim, message] of cases) await t.test(name, async () => {
    await assert.rejects(run(claim), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, message);
      return true;
    });
  });
});

test('owned-extra claims derive deterministic identity, owner and snapshot authority inside one consumed family', async () => {
  const primary = candidate('Film.mkv');
  const trailer = candidate('Film-trailer.mkv');
  const raw = {
    ...movieClaim(primary, [primary, trailer]),
    ownedExtras: [{
      primary: trailer,
      nativeType: trailerNativeType,
      extraType: 2,
      owner: primary,
      draft: { ...movieClaim(trailer).draft, Name: 'Trailer' }
    }]
  };
  const subject = pipeline([resolver('owned-extras', {
    resolveMultiple() { return { items: [raw], extraFiles: [] }; }
  }, { nativeTypes: { [movieNativeType]: { isFolder: false }, [trailerNativeType]: { isFolder: false } } })]);

  const strong = await subject.resolve({ candidates: [trailer, primary] });
  const [claim] = strong.claims;
  assert.equal(claim.ownsOwnedExtras, true);
  assert.equal(claim.ownedExtrasDeletionSafe, true);
  assert.equal(claim.ownedExtras.length, 1);
  const [owned] = claim.ownedExtras;
  assert.equal(owned.Id, nativeGuid(getNewItemId(trailer.identityPath, trailerNativeType, {
    programDataPath,
    enableCaseSensitiveItemIds: false
  })));
  assert.equal(owned.ownerId, claim.Id);
  assert.equal(owned.extraType, 2);
  assert.equal(owned.nativeType, trailerNativeType);
  assert.ok(Object.isFrozen(claim.ownedExtras));
  assert.ok(Object.isFrozen(owned));

  const weak = await subject.resolve({ candidates: [trailer, primary], deletionSafe: false });
  assert.equal(weak.claims[0].ownedExtrasDeletionSafe, false,
    'resolver output cannot promote a weak containing snapshot to authoritative');
});

for (const deletionSafe of [true, false]) test(`owned extras may use the separate sibling observation with deletion authority ${deletionSafe}`, async () => {
  const primary = candidate('Film.mkv'), trailer = candidate('theme.mp3');
  const subject = pipeline([resolver('separate-extra', {
    async resolveMultiple({ getExtraCandidates }) {
      assert.deepEqual(await getExtraCandidates(), [primary, trailer]);
      return { items: [{ ...movieClaim(primary), ownedExtras: [{ primary: trailer, nativeType: trailerNativeType,
        extraType: 8, owner: primary, draft: movieClaim(trailer).draft }] }], extraFiles: [] };
    }
  }, { nativeTypes: { [movieNativeType]: { isFolder: false }, [trailerNativeType]: { isFolder: false } } })]);
  const result = await subject.resolve({ candidates: [primary],
    getExtraCandidates: async () => ({ listing: { deletionSafe }, candidates: [primary, trailer] }) });
  const [claim] = result.claims;
  assert.deepEqual(claim.consumedPaths, [primary.identityPath]);
  assert.equal(claim.ownedExtras[0].identityPath, trailer.identityPath);
  assert.equal(claim.ownedExtrasDeletionSafe, deletionSafe);
  assert.deepEqual(result.passedToSingle, []);
});

test('a separate extra observation cannot bypass consumption of a regular resolver sibling', async () => {
  const primary = candidate('Film.mkv'), other = candidate('Other-trailer.mkv');
  const subject = pipeline([resolver('separate-extra', {
    async resolveMultiple({ getExtraCandidates }) {
      await getExtraCandidates();
      return { items: [{ ...movieClaim(primary), ownedExtras: [{ primary: other, nativeType: trailerNativeType,
        extraType: 2, owner: primary, draft: movieClaim(other).draft }] }], extraFiles: [other] };
    }
  }, { nativeTypes: { [movieNativeType]: { isFolder: false }, [trailerNativeType]: { isFolder: false } } })]);
  await assert.rejects(subject.resolve({ candidates: [primary, other],
    getExtraCandidates: async () => ({ listing: { deletionSafe: true }, candidates: [primary, other] }) }), /outside its consumed claim/);
});

test('a separate extra observation cannot become an ignored primary item', async () => {
  const primary = candidate('Film.mkv'), ignored = candidate('Hidden.mkv');
  const subject = pipeline([resolver('ignored-primary', {
    async resolveMultiple({ getExtraCandidates }) { await getExtraCandidates(); return { items: [movieClaim(ignored)], extraFiles: [] }; }
  })]);
  await assert.rejects(subject.resolve({ candidates: [primary],
    getExtraCandidates: async () => ({ listing: { deletionSafe: true }, candidates: [primary, ignored] }) }), /primary outside the sibling snapshot/);
});

for (const observation of ['peek', 'snapshot']) test(`a separate nested extra ${observation} cannot become a collapsed primary`, async () => {
  const directory = candidate('Film', 'directory');
  const ignored = candidate('Film\\.Hidden.mkv');
  const subject = pipeline([resolver('extra-only-nested-primary', {
    async resolveDirectory({ candidate: current, peekDirectory, getExtraCandidates }) {
      await peekDirectory(current);
      if (observation === 'peek') await peekDirectory(current, { forExtras: true });
      else await getExtraCandidates(current);
      return { ...movieClaim(current), itemSource: ignored };
    }
  })]);
  await assert.rejects(subject.resolve({ candidates: [directory],
    peekDirectory: async (_, options) => ({ listing: { deletionSafe: true }, candidates: options?.forExtras ? [ignored] : [] }),
    getExtraCandidates: async () => ({ listing: { deletionSafe: true }, candidates: [ignored] }) }), /outside the primary directory snapshot/);
});

test('extra observations reject cloned siblings and unknown directory provenance', async () => {
  const primary = candidate('Film.mkv'), outside = candidate('Outside', 'directory');
  const cloned = pipeline([resolver('cloned-extra', {
    async resolveMultiple({ getExtraCandidates }) { await getExtraCandidates(); return null; }
  })]);
  await assert.rejects(cloned.resolve({ candidates: [primary],
    getExtraCandidates: async () => ({ listing: { deletionSafe: true }, candidates: [{ ...primary }] }) }), /observations disagree/);
  let reads = 0;
  const unknown = pipeline([resolver('unknown-extra-directory', {
    async resolveMultiple({ getExtraCandidates }) { await getExtraCandidates(outside); return null; }
  })]);
  await assert.rejects(unknown.resolve({ candidates: [primary], getExtraCandidates: async () => { reads++; } }), /outside the directory observations/);
  assert.equal(reads, 0);
});

test('owned-extra claims reject relationship injection and paths outside strong consumed provenance', async t => {
  const primary = candidate('Film.mkv');
  const trailer = candidate('Film-trailer.mkv');
  const outside = candidate('Outside-trailer.mkv');
  const make = overrides => ({
    ...movieClaim(primary, [primary, trailer]),
    ownedExtras: [{
      primary: trailer,
      nativeType: trailerNativeType,
      extraType: 2,
      owner: primary,
      draft: movieClaim(trailer).draft,
      ...overrides
    }]
  });
  const run = (claim, nativeTypes = { [movieNativeType]: { isFolder: false }, [trailerNativeType]: { isFolder: false } }) =>
    pipeline([resolver('invalid-owned-extra', {
      resolveMultiple() { return { items: [claim], extraFiles: [outside] }; }
    }, { nativeTypes })]).resolve({ candidates: [outside, trailer, primary] });
  const cases = [
    ['outside consumed claim', make({ primary: outside }), /outside its consumed claim/u],
    ['unknown owner', make({ owner: outside }), /outside its consumed claim/u],
    ['invalid extra type', make({ extraType: 12 }), /invalid owned extra type/u],
    ['undeclared native type', make({ nativeType: 'Plugin.Entities.Extra' }), /undeclared owned extra type/u],
    ['relationship injection', make({ draft: { ...movieClaim(trailer).draft, OwnerId: primary.identityPath } }), /unsupported relationship field OwnerId/u],
    ['extra type injection', make({ draft: { ...movieClaim(trailer).draft, columns: { ExtraType: 2 } } }), /scanner-owned field ExtraType/u],
    ['unsupported key', { ...make({}), ownedExtras: [{ ...make({}).ownedExtras[0], unexpected: true }] }, /invalid owned extra/u]
  ];
  for (const [name, claim, message] of cases) await t.test(name, async () => {
    await assert.rejects(run(claim), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, message);
      return true;
    });
  });
});

test('a single resolver cannot consume siblings withheld by a multi winner', async () => {
  const primary = candidate('Primary.mkv');
  const extra = candidate('Extra.mkv');
  const withheld = candidate('Withheld.srt');
  const subject = pipeline([
    resolver('single', {
      resolveFile({ candidate: current }) {
        return movieClaim(current, [current, withheld]);
      }
    }, { priority: 0 }),
    resolver('multi', {
      resolveMultiple() {
        return { items: [movieClaim(primary)], extraFiles: [extra] };
      }
    }, { priority: 1 })
  ]);

  await assert.rejects(subject.resolve({ candidates: [withheld, extra, primary] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /outside the single-item handoff/u);
    return true;
  });
});

test('a multi winner can hand a directory extra to directory singles and Folder fallback', async () => {
  const primary = candidate('Primary.mkv');
  const directory = candidate('Shelf', 'directory');
  const subject = pipeline([resolver('multi', {
    resolveMultiple() {
      return { items: [movieClaim(primary)], extraFiles: [directory] };
    }
  })]);

  const result = await subject.resolve({ candidates: [directory, primary] });
  assert.deepEqual(result.passedToSingle, [directory.identityPath]);
  assert.deepEqual(result.claims.map(claim => [claim.identityPath, claim.resolverId]), [
    [primary.identityPath, 'multi'],
    [directory.identityPath, 'folder-fallback']
  ]);
});

test('file singles resolve files, directory media wins before Folder fallback, and unknown files remain unclaimed', async () => {
  const known = candidate('Known.mkv');
  const unknown = candidate('Unknown.bin');
  const disc = candidate('DVD', 'directory');
  const plain = candidate('Plain', 'directory');
  const fileCalls = [];
  const directoryCalls = [];
  const subject = pipeline([
    resolver('file-media', {
      resolveFile({ candidate: current }) {
        fileCalls.push(current.entry.name);
        return current === known ? movieClaim(current) : null;
      }
    }),
    resolver('directory-media', {
      resolveDirectory({ candidate: current }) {
        directoryCalls.push(current.entry.name);
        return current === disc ? movieClaim(current) : null;
      }
    })
  ]);

  const result = await subject.resolve({ candidates: [plain, unknown, disc, known] });
  const byPath = new Map(result.claims.map(claim => [claim.identityPath, claim]));

  assert.deepEqual(fileCalls, ['Unknown.bin', 'Known.mkv']);
  assert.deepEqual(directoryCalls, ['Plain', 'DVD']);
  assert.equal(byPath.get(known.identityPath).resolverId, 'file-media');
  assert.equal(byPath.get(known.identityPath).nativeType, movieNativeType);
  assert.equal(byPath.get(disc.identityPath).resolverId, 'directory-media');
  assert.equal(byPath.get(disc.identityPath).nativeType, movieNativeType);
  assert.equal(byPath.get(plain.identityPath).resolverId, 'folder-fallback');
  assert.equal(byPath.get(plain.identityPath).nativeType, folderNativeType);
  assert.equal(byPath.get(plain.identityPath).traversal, 'children');
  assert.equal(result.claims.filter(claim => claim.identityPath === disc.identityPath).length, 1,
    'a directory media claim does not also receive a Folder fallback');
  assert.deepEqual(result.unclaimedPaths, [unknown.identityPath]);
  assert.deepEqual(result.passedToSingle, [plain.identityPath, unknown.identityPath, disc.identityPath, known.identityPath]);
});

test('a strongly peeked direct file can supply nested identity while its directory remains the consumed scan anchor', async () => {
  const directory = candidate('Movie (2026)', 'directory');
  const nested = {
    identityPath: `${directory.identityPath}\\Movie (2026).mkv`,
    accessPath: `${directory.accessPath}/Movie (2026).mkv`,
    entry: { kind: 'file', name: 'Movie (2026).mkv', size: 17n }
  };
  const subject = pipeline([resolver('nested-movie', {
    async resolveDirectory({ candidate: current, peekDirectory }) {
      const snapshot = await peekDirectory(current);
      return {
        ...movieClaim(current),
        itemSource: snapshot.candidates[0],
        draft: { ...movieClaim(current).draft, Name: current.entry.name }
      };
    }
  })]);

  const result = await subject.resolve({
    candidates: [directory],
    peekDirectory: async current => {
      assert.equal(current, directory);
      return { listing: { deletionSafe: true }, candidates: [nested] };
    }
  });
  const [claim] = result.claims;
  assert.equal(claim.Id, nativeGuid(getNewItemId(nested.identityPath, movieNativeType, {
    programDataPath,
    enableCaseSensitiveItemIds: false
  })));
  assert.equal(claim.identityPath, nested.identityPath);
  assert.equal(claim.accessPath, nested.accessPath);
  assert.equal(claim.entry, nested.entry);
  assert.equal(claim.primary, directory);
  assert.deepEqual(claim.consumedPaths, [directory.identityPath]);
  assert.deepEqual(claim.replacementPaths, [directory.identityPath]);
  assert.ok(Object.isFrozen(claim.replacementPaths));
  assert.deepEqual(result.unclaimedPaths, []);
});

test('nested item sources fail closed without exact strong direct-peek provenance', async t => {
  const directory = candidate('Movie', 'directory');
  const otherDirectory = candidate('Other', 'directory');
  const nested = {
    identityPath: `${directory.identityPath}\\Movie.mkv`,
    accessPath: `${directory.accessPath}/Movie.mkv`,
    entry: { kind: 'file', name: 'Movie.mkv' }
  };
  const nestedDirectory = {
    ...nested,
    identityPath: `${directory.identityPath}\\Nested`,
    accessPath: `${directory.accessPath}/Nested`,
    entry: { kind: 'directory', name: 'Nested' }
  };
  const run = async ({ source = nested, deletionSafe = true, peek = true, peekParent = directory,
    rawReplacementPaths = false } = {}) => {
    const subject = pipeline([resolver('invalid-nested-source', {
      async resolveDirectory({ candidate: current, peekDirectory }) {
        if (current !== directory) return null;
        let selected = source;
        if (peek) {
          const snapshot = await peekDirectory(peekParent);
          selected = source === 'clone' ? { ...snapshot.candidates[0] } : snapshot.candidates[0];
        }
        return {
          ...movieClaim(current),
          itemSource: selected,
          ...(rawReplacementPaths ? { replacementPaths: [current.identityPath] } : {})
        };
      }
    })]);
    return subject.resolve({
      candidates: [directory, otherDirectory],
      peekDirectory: async current => ({
        listing: { deletionSafe },
        candidates: [current === directory ? source === nestedDirectory ? nestedDirectory : nested : {
          ...nested,
          identityPath: `${otherDirectory.identityPath}\\Other.mkv`,
          accessPath: `${otherDirectory.accessPath}/Other.mkv`
        }]
      })
    });
  };

  const cases = [
    ['unpeeked source', { peek: false }, /outside the primary directory snapshot/u],
    ['weak source', { deletionSafe: false }, /weak directory snapshot/u],
    ['cloned source', { source: 'clone' }, /outside the primary directory snapshot/u],
    ['directory source', { source: nestedDirectory }, /invalid item source/u],
    ['different peek parent', { peekParent: otherDirectory }, /outside the primary directory snapshot/u],
    ['resolver replacement override', { rawReplacementPaths: true }, /unsupported replacement path override/u]
  ];
  for (const [name, options, message] of cases) await t.test(name, async () => {
    await assert.rejects(run(options), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, message);
      return true;
    });
  });
});

test('nested directory item sources are restricted to strong disc stacks with exact directory parts', async t => {
  const directory = candidate('Movie', 'directory');
  const disc = name => ({
    identityPath: `${directory.identityPath}\\${name}`,
    accessPath: `${directory.accessPath}/${name}`,
    entry: { kind: 'directory', name }
  });
  const first = disc('Movie Disc 1'), second = disc('Movie Disc 2');
  const file = {
    identityPath: `${directory.identityPath}\\notes.txt`,
    accessPath: `${directory.accessPath}/notes.txt`,
    entry: { kind: 'file', name: 'notes.txt' }
  };
  const claim = overrides => ({
    ...movieClaim(directory, [directory, first, second]),
    itemSource: first,
    directoryParts: [second],
    draft: {
      ...movieClaim(directory).draft,
      data: { VideoType: 'Dvd', AdditionalParts: [second.identityPath] }
    },
    ...overrides
  });
  const run = (raw, { deletionSafe = true, nested = [first, second] } = {}) => pipeline([resolver('directory-stack', {
    async resolveDirectory({ candidate: current, peekDirectory }) {
      await peekDirectory(current);
      return raw;
    }
  })]).resolve({
    candidates: [directory],
    peekDirectory: async () => ({ listing: { deletionSafe }, candidates: nested })
  });

  const resolved = await run(claim());
  const [actual] = resolved.claims;
  assert.equal(actual.identityPath, first.identityPath);
  assert.deepEqual(actual.directoryParts.map(part => part.identityPath), [second.identityPath]);
  assert.deepEqual(actual.draft.data.AdditionalParts, [second.identityPath]);
  assert.ok(Object.isFrozen(actual.directoryParts));
  assert.ok(actual.directoryParts.every(Object.isFrozen));

  for (const [name, raw, options, message] of [
    ['missing parts', claim({ directoryParts: [] }), {}, /invalid item source/u],
    ['ordinary directory video', claim({ draft: { ...claim().draft,
      data: { VideoType: 'VideoFile', AdditionalParts: [second.identityPath] } } }), {}, /unsupported directory item source/u],
    ['weak source', claim(), { deletionSafe: false }, /weak directory snapshot/u],
    ['cloned part', claim({ directoryParts: [{ ...second }] }), {}, /outside the sibling snapshot/u],
    ['part outside snapshot', claim({ directoryParts: [disc('Movie Disc 3')] }), {}, /outside the sibling snapshot/u],
    ['source omitted from consumption', claim({ consumedPaths: [directory, second] }), {}, /invalid multi-disc directory claim/u],
    ['unrelated file consumed', claim({ consumedPaths: [directory, first, second, file] }),
      { nested: [first, second, file] }, /outside the sibling snapshot/u],
    ['owned family injected', claim({ ownedParts: [] }), {}, /invalid multi-disc directory claim/u],
    ['mismatched declaration', claim({ draft: { ...claim().draft,
      data: { VideoType: 'Dvd', AdditionalParts: [] } } }), {}, /inconsistent additional-part paths/u]
  ]) await t.test(name, async () => {
    await assert.rejects(run(raw, options), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, message);
      return true;
    });
  });
});

test('collapsed movie families consume only exact strong direct members of their primary directory', async t => {
  const directory = candidate('Film', 'directory'), other = candidate('Other', 'directory');
  const member = name => ({ identityPath: `${directory.identityPath}\\${name}`,
    accessPath: `${directory.accessPath}/${name}`, entry: { kind: 'file', name } });
  const primary = member('Film cd1.mkv'), part = member('Film cd2.mkv'), alternate = member('Film - 1080p.mkv');
  const run = async ({ selected = part, observation = 'normal', deletionSafe = true, observedParent = directory } = {}) => {
    const subject = pipeline([resolver('nested-family', {
      async resolveDirectory({ candidate: current, peekDirectory, getExtraCandidates }) {
        if (current !== directory) return null;
        await peekDirectory(current);
        if (observation === 'extra') await peekDirectory(observedParent, { forExtras: true });
        else if (observation === 'extra-snapshot') await getExtraCandidates(observedParent);
        else await peekDirectory(observedParent, { members: true });
        return { ...movieClaim(current), itemSource: primary,
          consumedPaths: [current, primary, selected, alternate],
          draft: { ...movieClaim(current).draft, data: { AdditionalParts: [part.identityPath], LocalAlternateVersions: [alternate.identityPath] } },
          ownedParts: [{ primary: selected, nativeType: movieNativeType, owner: primary,
            draft: movieClaim(selected).draft }],
          localAlternates: [{ primary: alternate, draft: movieClaim(alternate).draft }] };
      }
    })]);
    return subject.resolve({ candidates: [directory, other],
      peekDirectory: async (current, options) => ({ listing: { deletionSafe: options?.members ? deletionSafe : true },
        candidates: options?.members || options?.forExtras ? [part, alternate] : [primary, alternate] }),
      getExtraCandidates: async () => ({ listing: { deletionSafe }, candidates: [part, alternate] }) });
  };
  const result = await run();
  assert.deepEqual(result.claims[0].consumedPaths, [directory, primary, part, alternate].map(value => value.identityPath));
  assert.equal(result.claims[0].ownedParts[0].identityPath, part.identityPath);
  assert.equal(result.claims[0].localAlternates[0].identityPath, alternate.identityPath);
  for (const [name, options] of [
    ['cloned member', { selected: { ...part } }],
    ['path-only member', { selected: part.identityPath }],
    ['weak member', { deletionSafe: false }],
    ['extra-only peek', { observation: 'extra' }],
    ['extra-only snapshot', { observation: 'extra-snapshot' }],
    ['different directory', { observedParent: other }]
  ]) await t.test(name, async () => { await assert.rejects(run(options), error => error.code === 'invalid-response'); });
});

test('withhold is terminal for a candidate, suppresses Folder fallback, and remains explicitly unclaimed', async () => {
  const file = candidate('Blocked.mkv');
  const directory = candidate('Blocked', 'directory');
  const calls = [];
  const subject = pipeline([
    resolver('withholder', {
      resolveFile({ candidate: current }) {
        calls.push(`withhold:${current.entry.name}`);
        return { withhold: true };
      },
      resolveDirectory({ candidate: current }) {
        calls.push(`withhold:${current.entry.name}`);
        return { withhold: true };
      }
    }),
    resolver('later', {
      resolveFile({ candidate: current }) {
        calls.push(`later:${current.entry.name}`);
        return movieClaim(current);
      },
      resolveDirectory({ candidate: current }) {
        calls.push(`later:${current.entry.name}`);
        return movieClaim(current);
      }
    }, { priority: 1 })
  ]);

  const result = await subject.resolve({ candidates: [directory, file] });
  assert.deepEqual(calls, ['withhold:Blocked', 'withhold:Blocked.mkv']);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.withheldPaths, [directory.identityPath, file.identityPath]);
  assert.deepEqual(result.unclaimedPaths, [directory.identityPath, file.identityPath]);
  assert.deepEqual(result.passedToSingle, [directory.identityPath, file.identityPath]);
  assert.equal(result.consumedPaths.size, 0);
});

test('a later candidate cannot consume a sibling that was withheld', async () => {
  const withheld = candidate('Alpha.mkv');
  const claimant = candidate('Beta.mkv');
  const subject = pipeline([
    resolver('withholder', {
      resolveFile({ candidate: current }) {
        return current === withheld ? { withhold: true } : null;
      }
    }),
    resolver('sibling-claimant', {
      resolveFile({ candidate: current }) {
        return movieClaim(current, [withheld, current]);
      }
    }, { priority: 1 })
  ]);

  await assert.rejects(subject.resolve({ candidates: [claimant, withheld] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /attempted to claim a withheld sibling path/u);
    return true;
  });
});

test('a lower-priority earlier candidate cannot consume a later sibling before it is withheld', async () => {
  const claimant = candidate('Alpha.mkv');
  const withheld = candidate('Zulu.mkv');
  const calls = [];
  const subject = pipeline([
    resolver('withholder', {
      resolveFile({ candidate: current }) {
        calls.push(`withholder:${current.entry.name}`);
        return current === withheld ? { withhold: true } : null;
      }
    }),
    resolver('sibling-claimant', {
      resolveFile({ candidate: current }) {
        calls.push(`claimant:${current.entry.name}`);
        return current === claimant ? movieClaim(current, [current, withheld]) : null;
      }
    }, { priority: 1 })
  ]);

  await assert.rejects(subject.resolve({ candidates: [claimant, withheld] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /attempted to claim a withheld sibling path/u);
    return true;
  });
  assert.deepEqual(calls, [
    'withholder:Alpha.mkv',
    'claimant:Alpha.mkv',
    'withholder:Zulu.mkv'
  ]);
});

test('a lower-priority file claim cannot consume a directory before its higher-priority withhold', async () => {
  const file = candidate('Alpha.mkv');
  const directory = candidate('Zulu', 'directory');
  const calls = [];
  const subject = pipeline([
    resolver('directory-withholder', {
      resolveDirectory({ candidate: current }) {
        calls.push(`withholder:${current.entry.name}`);
        return { withhold: true };
      }
    }),
    resolver('file-claimant', {
      resolveFile({ candidate: current }) {
        calls.push(`claimant:${current.entry.name}`);
        return movieClaim(current, [current, directory]);
      }
    }, { priority: 1 })
  ]);

  await assert.rejects(subject.resolve({ candidates: [file, directory] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /attempted to claim a withheld sibling path/u);
    return true;
  });
  assert.deepEqual(calls, ['claimant:Alpha.mkv', 'withholder:Zulu']);
});

test('passedToSingle preserves the explicit multi handoff when an extra claims another sibling', async () => {
  const primary = candidate('Primary.mkv');
  const first = candidate('Alpha.mkv');
  const second = candidate('Zulu.mkv');
  const subject = pipeline([
    resolver('multi', {
      resolveMultiple() {
        return { items: [movieClaim(primary)], extraFiles: [second, first] };
      }
    }),
    resolver('single', {
      resolveFile({ candidate: current }) {
        return current === first ? movieClaim(current, [current, second]) : null;
      }
    }, { priority: 1 })
  ]);

  const result = await subject.resolve({ candidates: [second, primary, first] });
  assert.deepEqual(result.passedToSingle, [second.identityPath, first.identityPath]);
  assert.deepEqual(result.claims.map(claim => claim.resolverId), ['multi', 'single']);
});

test('withhold results require the exact object shape', async t => {
  const primary = candidate('Primary.mkv');
  const arrayResult = [];
  arrayResult.withhold = true;
  const cases = [
    { name: 'false sentinel', result: { withhold: false }, message: /invalid withhold result/u },
    { name: 'extra key', result: { withhold: true, reason: 'unsupported' }, message: /invalid withhold result/u },
    { name: 'array impostor', result: arrayResult, message: /invalid withhold result/u },
    { name: 'bare false', result: false, message: /invalid claim/u }
  ];

  for (const entry of cases) await t.test(entry.name, async () => {
    const subject = pipeline([resolver('invalid-withholder', {
      resolveFile() { return entry.result; }
    })]);
    await assert.rejects(subject.resolve({ candidates: [primary] }), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, entry.message);
      return true;
    });
  });
});

test('claims fail closed for overlapping, out-of-snapshot, missing-primary, and undeclared native-type results', async t => {
  const primary = candidate('Primary.mkv');
  const sibling = candidate('Sibling.mkv');
  const outside = candidate('Outside.mkv');
  outside.identityPath = 'Z:\\Elsewhere\\Outside.mkv';

  const cases = [
    {
      name: 'duplicate path within one claim',
      result: { items: [movieClaim(primary, [primary, primary])], extraFiles: [] },
      message: /overlapping sibling claim/u
    },
    {
      name: 'overlapping claims',
      result: {
        items: [movieClaim(primary, [primary, sibling]), movieClaim(sibling, [sibling])],
        extraFiles: []
      },
      message: /overlapping sibling claim/u
    },
    {
      name: 'path outside the sibling snapshot',
      result: { items: [movieClaim(primary, [primary, outside])], extraFiles: [] },
      message: /outside the sibling snapshot/u
    },
    {
      name: 'claim has no primary',
      result: { items: [{ ...movieClaim(primary), primary: undefined }], extraFiles: [] },
      message: /primary outside the sibling snapshot/u
    },
    {
      name: 'claim omits its primary',
      result: { items: [movieClaim(primary, [sibling])], extraFiles: [] },
      message: /did not consume its primary path/u
    },
    {
      name: 'claim omits consumedPaths',
      result: { items: [{ ...movieClaim(primary), consumedPaths: undefined }], extraFiles: [] },
      message: /nonempty consumedPaths array/u
    },
    {
      name: 'claim returns null consumedPaths',
      result: { items: [{ ...movieClaim(primary), consumedPaths: null }], extraFiles: [] },
      message: /nonempty consumedPaths array/u
    },
    {
      name: 'claim returns scalar consumedPaths',
      result: { items: [{ ...movieClaim(primary), consumedPaths: primary }], extraFiles: [] },
      message: /nonempty consumedPaths array/u
    },
    {
      name: 'claim uses an undeclared native type',
      result: {
        items: [{ ...movieClaim(primary), nativeType: 'Plugin.Entities.UndeclaredMovie' }],
        extraFiles: []
      },
      message: /undeclared native type/u
    },
    {
      name: 'claim attempts an identity key override',
      result: {
        items: [{ ...movieClaim(primary), identityKey: primary.identityPath }],
        extraFiles: []
      },
      message: /unsupported identity key override/u
    }
  ];

  for (const entry of cases) await t.test(entry.name, async () => {
    const subject = pipeline([resolver('invalid-multi', {
      resolveMultiple() {
        return entry.result;
      }
    })]);
    await assert.rejects(subject.resolve({ candidates: [primary, sibling] }), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, entry.message);
      return true;
    });
  });
});

test('multi results and explicit extraFiles are validated strictly', async t => {
  const primary = candidate('Primary.mkv');
  const extra = candidate('Extra.mkv');
  const directory = candidate('Directory', 'directory');
  const outside = candidate('Outside.mkv');
  outside.identityPath = 'Z:\\Elsewhere\\Outside.mkv';
  const cases = [
    { name: 'bare item array', result: [movieClaim(primary)], message: /invalid multi-item result/u },
    { name: 'missing extraFiles', result: { items: [movieClaim(primary)] }, message: /invalid multi-item result/u },
    { name: 'extra without winner', result: { items: [], extraFiles: [extra] }, message: /without a multi-item winner/u },
    { name: 'outside extra', result: { items: [movieClaim(primary)], extraFiles: [outside] }, message: /outside the sibling snapshot/u },
    { name: 'duplicate extra', result: { items: [movieClaim(primary)], extraFiles: [extra, extra] }, message: /duplicate extra file/u },
    { name: 'consumed extra', result: { items: [movieClaim(primary, [primary, extra])], extraFiles: [extra] }, message: /already consumed/u }
  ];

  for (const entry of cases) await t.test(entry.name, async () => {
    const subject = pipeline([resolver('invalid-multi-result', {
      resolveMultiple() { return entry.result; }
    })]);
    await assert.rejects(subject.resolve({ candidates: [primary, extra, directory] }), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, entry.message);
      return true;
    });
  });
});

test('resolver drafts cannot set unsupported relationship fields', async t => {
  const primary = candidate('Primary.mkv');
  for (const field of ['OwnerId', 'PrimaryVersionId', 'SeriesId', 'SeasonId']) {
    for (const location of ['draft', 'columns', 'initialColumns', 'data']) await t.test(`${location}.${field}`, async () => {
      const claim = movieClaim(primary);
      if (location === 'draft') claim.draft[field] = '11111111-1111-1111-1111-111111111111';
      else claim.draft[location] = { [field]: '11111111-1111-1111-1111-111111111111' };
      const subject = pipeline([resolver('relationship-writer', {
        resolveFile() { return claim; }
      })]);
      await assert.rejects(subject.resolve({ candidates: [primary] }), error => {
        assert.equal(error.code, 'invalid-response');
        assert.match(error.message, new RegExp(field, 'u'));
        return true;
      });
    });
  }
  for (const field of ['CanDelete', 'ExtraType']) {
    for (const location of ['draft', 'columns', 'initialColumns', 'data']) await t.test(`${location}.${field}`, async () => {
      const claim = movieClaim(primary);
      if (location === 'draft') claim.draft[field] = field === 'CanDelete' ? false : 2;
      else claim.draft[location] = { [field]: field === 'CanDelete' ? false : 2 };
      const subject = pipeline([resolver('ownership-writer', {
        resolveFile() { return claim; }
      })]);
      await assert.rejects(subject.resolve({ candidates: [primary] }), error => {
        assert.equal(error.code, 'invalid-response');
        assert.match(error.message, new RegExp(field, 'u'));
        return true;
      });
    });
  }
});

test('initial columns are normalized separately and cannot overlap persistent columns', async t => {
  const primary = candidate('Primary.mkv');
  const valid = movieClaim(primary);
  valid.draft.columns = { IsInMixedFolder: true };
  valid.draft.initialColumns = { ProductionYear: 2026 };
  const result = await pipeline([resolver('initial-values', {
    resolveFile() { return valid; }
  })]).resolve({ candidates: [primary] });
  assert.deepEqual(result.claims[0].draft.columns, { IsInMixedFolder: true });
  assert.deepEqual(result.claims[0].draft.initialColumns, { ProductionYear: 2026 });
  assert.ok(Object.isFrozen(result.claims[0].draft.initialColumns));

  await t.test('invalid scalar', async () => {
    const claim = movieClaim(primary);
    claim.draft.initialColumns = 2026;
    await assert.rejects(pipeline([resolver('invalid-initial-values', {
      resolveFile() { return claim; }
    })]).resolve({ candidates: [primary] }), /invalid item draft initialColumns/u);
  });

  await t.test('overlap', async () => {
    const claim = movieClaim(primary);
    claim.draft.columns = { ProductionYear: 2025 };
    claim.draft.initialColumns = { ProductionYear: 2026 };
    await assert.rejects(pipeline([resolver('overlapping-initial-values', {
      resolveFile() { return claim; }
    })]).resolve({ candidates: [primary] }), /overlapping persistent and initial columns/u);
  });
});

test('resolver drafts cannot create non-library scanner ownership', async t => {
  const primary = candidate('Primary.mkv');
  const direct = movieClaim(primary);
  direct.draft.SourceType = 'Channel';
  const data = movieClaim(primary);
  delete data.draft.SourceType;
  data.draft.data = { SourceType: 'Channel' };
  for (const [name, claim] of [['draft SourceType', direct], ['data SourceType', data]]) await t.test(name, async () => {
    const subject = pipeline([resolver('source-writer', {
      resolveFile() { return claim; }
    })]);
    await assert.rejects(subject.resolve({ candidates: [primary] }), error => {
      assert.equal(error.code, 'invalid-response');
      assert.match(error.message, /unsupported item source type/u);
      return true;
    });
  });
});

test('case-insensitive resolution uses canonical listing paths and rejects ambiguous case-only siblings', async () => {
  const canonical = candidate('Movie.mkv');
  const subject = pipeline([resolver('case-insensitive-file', {
    resolveFile({ candidate: current }) {
      return movieClaim(current.identityPath.toLowerCase(), [current.identityPath.toLowerCase()]);
    }
  })]);

  const result = await subject.resolve({ candidates: [canonical] });
  assert.equal(result.claims[0].identityPath, canonical.identityPath);
  assert.deepEqual(result.claims[0].consumedPaths, [canonical.identityPath]);

  const duplicateCase = { ...candidate('movie.mkv'), identityPath: canonical.identityPath.toLowerCase() };
  await assert.rejects(subject.resolve({ candidates: [canonical, duplicateCase] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /ambiguous resolver paths/u);
    return true;
  });
});

test('Windows native paths reject case-only siblings independently of item ID casing', async () => {
  const upper = candidate('Movie.mkv');
  const lower = candidate('movie.mkv');
  const subject = pipeline([resolver('case-sensitive-file', {
    resolveFile({ candidate: current }) {
      return movieClaim(current);
    }
  })], { EnableCaseSensitiveItemIds: true });

  await assert.rejects(subject.resolve({ candidates: [lower, upper] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /ambiguous resolver paths/u);
    return true;
  });

  const canonical = await subject.resolve({ candidates: [upper] });
  assert.equal(canonical.claims.length, 1);
  assert.equal(canonical.claims[0].identityPath, upper.identityPath);
});

test('POSIX native path casing is ordinal while item ID casing remains configurable', async () => {
  const upper = { ...candidate('Movie.mkv'), identityPath: '/library/Movie.mkv' };
  const lower = { ...candidate('movie.mkv'), identityPath: '/library/movie.mkv' };
  const make = configuration => pipeline([resolver('posix-file', {
    resolveFile({ candidate: current }) { return movieClaim(current); }
  })], configuration);

  await assert.rejects(make().resolve({ candidates: [lower, upper] }), error => {
    assert.equal(error.code, 'invalid-response');
    assert.match(error.message, /duplicate deterministic item identity/u);
    return true;
  });

  const result = await make({ EnableCaseSensitiveItemIds: true }).resolve({ candidates: [lower, upper] });
  assert.deepEqual(new Set(result.claims.map(claim => claim.identityPath)), new Set([upper.identityPath, lower.identityPath]));
  assert.equal(new Set(result.claims.map(claim => claim.Id)).size, 2);
});

test('native ResolvePaths preserves caller enumeration order for multi and single dispatch', async () => {
  const candidates = [
    candidate('Zulu.mkv'),
    candidate('alpha.mkv'),
    candidate('Zoo', 'directory'),
    candidate('beta', 'directory')
  ];
  const run = async listing => {
    const calls = [];
    const subject = pipeline([resolver('observer', {
      resolveMultiple({ available }) {
        calls.push(`multi:${available.map(value => value.entry.name).join(',')}`);
        return { items: [], extraFiles: [] };
      },
      resolveFile({ candidate: current }) {
        calls.push(`file:${current.entry.name}`);
        return null;
      },
      resolveDirectory({ candidate: current }) {
        calls.push(`directory:${current.entry.name}`);
        return null;
      }
    })]);
    const result = await subject.resolve({ candidates: listing });
    return {
      calls,
      claims: result.claims.map(claim => [claim.identityPath, claim.nativeType]),
      passedToSingle: result.passedToSingle,
      unclaimedPaths: result.unclaimedPaths
    };
  };

  const forward = await run(candidates);
  const reversed = await run([...candidates].reverse());

  assert.deepEqual(forward.calls, [
    'multi:Zulu.mkv,alpha.mkv,Zoo,beta',
    'file:Zulu.mkv',
    'file:alpha.mkv',
    'directory:Zoo',
    'directory:beta'
  ]);
  assert.deepEqual(reversed.calls, ['multi:beta,Zoo,alpha.mkv,Zulu.mkv', 'directory:beta', 'directory:Zoo',
    'file:alpha.mkv', 'file:Zulu.mkv']);
  assert.deepEqual(forward.unclaimedPaths, [candidate('Zulu.mkv').identityPath, candidate('alpha.mkv').identityPath]);
  assert.deepEqual(reversed.unclaimedPaths, [...forward.unclaimedPaths].reverse());
  assert.deepEqual(reversed.claims, [...forward.claims].reverse());
});

test('resolver exceptions propagate without invoking later resolvers', async () => {
  const failure = new Error('synthetic resolver failure');
  let laterCalled = false;
  const subject = pipeline([
    resolver('throwing', {
      resolveMultiple() {
        throw failure;
      }
    }, { priority: 0 }),
    resolver('later', {
      resolveMultiple() {
        laterCalled = true;
        return { items: [], extraFiles: [] };
      }
    }, { priority: 1 })
  ]);

  await assert.rejects(subject.resolve({ candidates: [candidate('Movie.mkv')] }), error => error === failure);
  assert.equal(laterCalled, false);
});

test('host directory observation failures escape single-resolver recovery', async () => {
  const failure = Object.assign(new Error('synthetic directory observation failure'), { code: 'io' });
  const current = candidate('Film', 'directory');
  let laterCalled = false;
  const subject = pipeline([
    resolver('peeking-directory', {
      async resolveDirectory({ candidate: value, peekDirectory }) {
        await peekDirectory(value);
        return null;
      }
    }, { priority: 0 }),
    resolver('later-directory', {
      resolveDirectory() {
        laterCalled = true;
        return null;
      }
    }, { priority: 1 })
  ]);

  await assert.rejects(subject.resolve({
    candidates: [current],
    peekDirectory: async () => { throw failure; }
  }), error => error === failure);
  assert.equal(laterCalled, false);
});

test('single resolver failures cannot forge cancellation or private pipeline invariants', async t => {
  const failures = [
    ['AbortError name', Object.assign(new Error('forged abort name'), { name: 'AbortError' })],
    ['cancelled code', Object.assign(new Error('forged cancelled code'), { code: 'cancelled' })],
    ['invariant details', Object.assign(new Error('forged invariant details'), {
      details: Object.freeze({ resolverPipelineInvariant: true })
    })],
    ['hostile details getter', (() => {
      const error = new Error('hostile resolver details');
      Object.defineProperty(error, 'details', {
        configurable: true,
        get() { throw new Error('resolver error details must not be inspected'); }
      });
      return error;
    })()]
  ];

  for (const [name, failure] of failures) await t.test(name, async () => {
    const reported = [];
    const current = candidate(`${name}.mkv`);
    const subject = new DirectoryItemResolverPipeline({
      programDataPath,
      onError: (error, context) => reported.push([error, context]),
      resolvers: [
        resolver('forged-failure', {
          resolveFile() { throw failure; }
        }, { priority: 0 }),
        resolver('later-file', {
          resolveFile({ candidate: value }) { return movieClaim(value); }
        }, { priority: 1 })
      ]
    });

    const result = await subject.resolve({ candidates: [current] });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].resolverId, 'later-file');
    assert.equal(result.claims[0].identityPath, current.identityPath);
    assert.equal(reported.length, 1);
    assert.equal(reported[0][0], failure);
    assert.deepEqual(reported[0][1], { resolverId: 'forged-failure', method: 'resolveFile' });
  });
});

test('an abort raised while a resolver is running propagates as cancellation', async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let laterCalled = false;
  const subject = pipeline([
    resolver('blocking-file', {
      async resolveFile() {
        entered();
        await blocked;
        return null;
      }
    }, { priority: 0 }),
    resolver('later-file', {
      resolveFile() {
        laterCalled = true;
        return null;
      }
    }, { priority: 1 })
  ]);

  const resolution = subject.resolve({ candidates: [candidate('Movie.mkv')], signal: controller.signal });
  await started;
  controller.abort();
  release();

  await assert.rejects(resolution, error => error.code === 'cancelled');
  assert.equal(laterCalled, false);
});
