import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableDefinition } from '../../src/database/model.js';
import { describeFile } from '../../tools/validation/inventory.js';
import { verifyNativeBuild } from '../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../tools/validation/oracle.js';
import { assertValidationOutputChild, validationOutputRoot } from '../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const root = new URL('./fixtures/movie-similar/', import.meta.url);
const inputFile = new URL('current/input.json', root), profileFile = new URL('current-profile.json', root);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
export const id = value => `14000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) + '\n';
export const blank = table => Object.fromEntries(tableDefinition(table).columns.filter(column => !column.generated).map(column => {
  const type = column.clrType.replace('?', '');
  return [column.name, type === 'DateTime' ? '2026-10-09 00:00:00' : column.nullable ? null
    : type === 'bool' ? false : column.type === 'TEXT' ? '' : ['long', 'uint'].includes(type) ? 0n : 0];
}));
export const typeNames = { Movie: 'MediaBrowser.Controller.Entities.Movies.Movie', Trailer: 'MediaBrowser.Controller.Entities.Trailer',
  Series: 'MediaBrowser.Controller.Entities.TV.Series', LiveTvProgram: 'MediaBrowser.Controller.LiveTv.LiveTvProgram' };

export async function seedCandidate(database) {
  for (const key of [80, 81]) await database.insert('Users', {
    ...blank('Users'), Id: id(key), Username: `movie-${key}`, NormalizedUsername: `MOVIE-${key}`,
  });
  for (const row of [...input.items, ...input.liveTv.items]) await database.insert('BaseItems', {
    ...blank('BaseItems'), Id: id(row.id), Type: typeNames[row.type], Data: '{}',
    Name: row.name, CleanName: row.name, SortName: `reverse-${String(1000 - row.id).padStart(4, '0')}`,
    PresentationUniqueKey: Object.hasOwn(row, 'puk') ? row.puk : `puk-${row.id}`,
    TopParentId: id(row.top ?? 90), PrimaryVersionId: row.primary ? id(row.primary) : null,
    OwnerId: row.owner ? id(row.owner) : null, ExtraType: row.extraType ?? null,
    IsMovie: row.isMovie ?? true, IsFolder: row.type === 'Series', MediaType: 'Video',
    Genres: row.genres?.join('|') ?? null, Tags: row.tags?.join('|') ?? null,
  });
  for (const value of [...input.values, ...input.liveTv.values]) {
    await database.insert('ItemValues', { ItemValueId: id(value.id), Type: value.type, Value: value.value, CleanValue: value.clean });
    for (const item of value.items) await database.insert('ItemValuesMap', { ItemId: id(item), ItemValueId: id(value.id) });
  }
  for (const person of input.people) {
    await database.insert('Peoples', { Id: id(person.id), Name: person.name, PersonType: person.type });
    for (const [list, rows] of [[0, person.items], [1, person.duplicateItems ?? []]]) for (const item of rows) {
      await database.insert('PeopleBaseItemMap', { ItemId: id(item), PeopleId: id(person.id),
        ListOrder: list, SortOrder: list, Role: `role-${list}` });
    }
  }
  for (const key of input.played) await database.insert('UserData', {
    ...blank('UserData'), ItemId: id(key), UserId: id(80), CustomDataKey: `puk-${key}`, Played: true, PlayCount: 1,
  });
}

let pending;
export const currentMovieSimilar = () => pending ??= capture();
async function capture() {
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  const output = path.join(validationOutputRoot(), 'movie-similar-current-' + randomUUID());
  assertValidationOutputChild(output); await mkdir(output);
  const report = { schemaVersion: 1, scope: profile.scope, inputSha256: sha(inputBytes), inputs: [], sourceBindings: [],
    nativeExecutionRecorded: false, phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const expected of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(expected.filename, root)));
      assert.equal(actual.available, true, expected.filename); assert.equal(actual.bytes, expected.bytes, expected.filename);
      assert.equal(actual.sha256, expected.sha256, expected.filename); report.inputs.push({ role: expected.role, ...actual });
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const manifest = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json'), 'utf8'));
    for (const relative of profile.sourcePaths) {
      const expected = manifest.files.find(entry => entry.path === relative); assert.ok(expected, relative);
      const source = await describeFile(path.join(build.root, 'source', relative)); assert.equal(source.sha256, expected.sha256, relative);
      report.sourceBindings.push({ relativePath: relative, source });
    }
    const nativeRoot = path.join(output, 'native');
    const project = fileURLToPath(new URL(profile.inputs.find(entry => entry.role === 'oracleProject').filename, root));
    const record = await recordOracle({ project, output: nativeRoot, args: [fileURLToPath(inputFile), '{output}/native.json'] });
    const filename = path.join(nativeRoot, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
    report.capture = { record, observation: await describeFile(filename) };
    assert.equal(record.passed, true); assert.equal(record.build.status, 0); assert.equal(record.process.status, 0);
    assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, sha(bytes));
    assert.equal(native.actualExecution, true); assert.equal(native.inputSha256, sha(inputBytes));
    for (const assembly of native.assemblies) {
      const actual = await describeFile(path.join(build.runtime, assembly.name + '.dll'));
      assert.equal(actual.available, true, assembly.name); assert.equal(actual.sha256, assembly.sha256, assembly.name);
    }
    const sqlite = await describeFile(path.join(build.runtime, 'runtimes', native.nativeSqlite.runtimeIdentifier, 'native', native.nativeSqlite.name));
    assert.equal(sqlite.available, true); assert.equal(sqlite.sha256, native.nativeSqlite.sha256);
    assert.equal(native.nativeSqlite.resolverObserved, true);
    assert.deepEqual(native.results.map(result => result.name), input.cases.map(sample => sample.name));
    assert.deepEqual(native.identifierScopes.map(result => result.name), input.identifierScopes.map(sample => sample.name));
    assert.deepEqual(native.liveTv.map(result => result.name), input.liveTv.cases.map(sample => sample.name));
    assert.deepEqual(native.tmdbMovie.cases.map(result => result.name), input.tmdb.cases.map(sample => sample.name));
    report.nativeExecutionRecorded = true;
    await mkdir(path.join(output, 'candidate'));
    return { native, output, report };
  } catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally { await writeFile(path.join(output, 'capture-report.json'), json(report), { flag: 'wx' }); }
}

export async function recordCandidate(name, observation) {
  assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
  const { output } = await currentMovieSimilar();
  await writeFile(path.join(output, 'candidate', name + '.json'), json(observation), { flag: 'wx' });
}
