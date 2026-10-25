import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeBuild } from '../../../../tools/validation/native-build-inputs.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { validationOutputRoot, assertValidationOutputChild } from '../../../../tools/validation/paths.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'postgres'];
const root = new URL('./', import.meta.url);
const inputFile = new URL('input.json', root);
const inputBytes = await readFile(inputFile);
export const input = JSON.parse(inputBytes);
const profile = JSON.parse(await readFile(new URL('current-profile.json', root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idKey = value => value.replaceAll('-', '').toLowerCase();

function cases(native) {
  return native.results.map(result => {
    const observation = result.observation;
    return { name: result.Name, input: input.find(sample => sample.Name === result.Name),
      nativeCaseRoot: result.caseRoot, nativeProgramDataPath: result.programDataPath, nativeMediaRoot: result.mediaRoot,
      window: { start: Date.parse(result.startedAt), end: Date.parse(result.finishedAt) },
      exception: observation.Exception, cancelled: observation.Cancelled, scanRunning: observation.ScanRunning, roots: observation.Roots,
      columns: observation.Sql.result.BaseItems,
      relations: Object.fromEntries(Object.entries(observation.Sql.result).filter(([table]) => table !== 'BaseItems')),
      trace: observation.Trace, warmupException: result.warmup?.Exception ?? null,
      resolverTypes: observation.ResolverTypes, metadataServiceTypes: observation.MetadataServiceTypes };
  });
}

// Fresh media roots produce fresh path-derived IDs and actual filesystem clocks.
// Candidate comparisons retain their complete original values; only this
// independent repeat comparison gives each persisted identity a path/type label.
function repeatProjection(native) {
  return cases(native).map(sample => {
    const normalizePath = value => value.replaceAll(sample.nativeCaseRoot, '$CASE')
      .replaceAll(sample.nativeCaseRoot.replaceAll('\\', '/'), '$CASE').replaceAll('\\', '/');
    const identities = sample.columns.map(row => [idKey(row.Id), row.Type + ':' + normalizePath(row.Path ?? '')]);
    const project = (value, key = '') => {
      if (Array.isArray(value)) return value.map(entry => project(entry, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([name]) => !['ordinal', 'sequence', 'actualFrames'].includes(name))
        .map(([name, entry]) => [name, project(entry, name)]));
      if (typeof value !== 'string') return value;
      if (key === 'Data') return project(JSON.parse(value));
      if (/^Date(?:Created|Modified|LastSaved|LastRefreshed)$/u.test(key)) {
        if (/^0001-01-01[ T]/u.test(value)) return '$MIN_CLOCK';
        const timestamp = Date.parse(value.endsWith('Z') || /[+-]\d\d:\d\d$/u.test(value) ? value : value.replace(' ', 'T') + 'Z');
        assert.ok(Number.isFinite(timestamp) && timestamp >= sample.window.start - 1000 && timestamp <= sample.window.end + 1000,
          key + ': native filesystem/save time belongs to its actual operation');
        return '$' + key;
      }
      value = normalizePath(value);
      for (const [id, label] of identities) {
        const dashed = id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
        value = value.replaceAll(new RegExp(dashed + '|' + id, 'giu'), () => '$ITEM:' + label);
      }
      return value;
    };
    const phases = new Set(['monitor-Stop', 'monitor-Start', 'post-task-begin', 'post-task-end',
      'inherited-cleanup-begin', 'inherited-cleanup-committed', 'injected-fault']);
    const projected = project({ name: sample.name, failed: sample.exception != null, cancelled: sample.cancelled,
      scanRunning: sample.scanRunning, columns: sample.columns, relations: sample.relations,
      phases: sample.trace.filter(event => phases.has(event.action)).map(event => ({ action: event.action,
        name: event.detail?.name ?? null,
        ...(event.action === 'injected-fault' ? { kind: event.detail.kind, path: event.detail.path, occurrence: event.detail.occurrence } : {})
      })) });
    projected.columns.sort((a, b) => a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0);
    for (const rows of Object.values(projected.relations)) rows.sort((a, b) => {
      const key = row => JSON.stringify(Object.entries(row).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });
    return projected;
  });
}

let pending;
export function captureCurrentNative() { return pending ??= capture(); }

async function capture() {
  const output = assertValidationOutputChild(path.join(validationOutputRoot(), 'global-scan-current-' + randomUUID()));
  await mkdir(output);
  const report = { schemaVersion: 1, inputSha256: hash(inputBytes), scope: profile.scope,
    captures: [], sourceBindings: [], phaseAcceptance: false, releaseAcceptance: false };
  try {
    for (const entry of profile.inputs) {
      const actual = await describeFile(fileURLToPath(new URL(entry.filename, root)));
      assert.equal(actual.bytes, entry.bytes, entry.filename); assert.equal(actual.sha256, entry.sha256, entry.filename);
    }
    const build = await verifyNativeBuild();
    report.build = { identitySha256: build.identitySha256, runtimeEntriesSha256: build.runtimeEntriesSha256,
      receipt: await describeFile(path.join(build.root, 'receipts/build-receipt.json')) };
    const sources = JSON.parse(await readFile(path.join(build.root, 'source-offer/jellyfin-source-manifest.json')));
    for (const relativePath of profile.sourcePaths) {
      const pinned = sources.files.find(entry => entry.path === relativePath); assert.ok(pinned, relativePath);
      const source = await describeFile(path.join(build.root, 'source', relativePath));
      assert.equal(source.sha256, pinned.sha256, relativePath); report.sourceBindings.push({ relativePath, source });
    }
    let first;
    for (const label of ['native-first', 'native-repeat']) {
      const directory = path.join(output, label);
      const record = await recordOracle({ project: 'tests/library/fixtures/global-scan-current/Oracle.csproj', output: directory,
        args: [fileURLToPath(inputFile), '{output}/native.json', '{output}/cases'] });
      const filename = path.join(directory, 'native.json'), bytes = await readFile(filename), native = JSON.parse(bytes);
      report.captures.push({ label, record, observation: await describeFile(filename) });
      assert.equal(record.passed, true); assert.equal(native.actualGlobalScan, true);
      assert.equal(record.outputs.find(entry => entry.filename === filename)?.sha256, hash(bytes));
      assert.equal(native.inputSha256, hash(inputBytes));
      assert.deepEqual(native.results.map(sample => sample.Name), input.map(sample => sample.Name));
      for (const assembly of native.assemblies) {
        const runtime = build.manifest.files.find(entry => entry.path === assembly.name + '.dll');
        const relative = path.relative(build.sdkRoot, assembly.path).replaceAll('\\', '/');
        const sdk = build.sdkAfter.files.find(entry => entry.path === relative);
        const expected = assembly.name === 'Oracle' ? record.oracleAssembly : runtime ?? sdk;
        assert.ok(expected, assembly.name); assert.equal(assembly.sha256, expected.sha256, assembly.name);
        assert.equal((await describeFile(assembly.path)).sha256, expected.sha256, assembly.name);
      }
      assert.equal(native.sqlite.actualResolverUsed, true);
      const sqlite = build.manifest.files.find(entry => entry.path === 'runtimes/' + native.sqlite.rid + '/native/' + path.basename(native.sqlite.filename));
      assert.ok(sqlite); assert.equal(native.sqlite.sha256, sqlite.sha256);
      assert.equal(native.reader.actualBaseItemRepositoryReader, true); assert.equal(native.reader.actualSqliteSource, true);
      assert.equal(native.readerDatabase.beforeSha256, native.readerDatabase.afterSha256);
      for (const sample of cases(native)) {
        assert.ok(sample.window.end >= sample.window.start);
        assert.ok(sample.columns.every(row => Object.keys(row).length === 72));
        assert.equal(sample.trace.filter(event => event.action === 'injected-fault').length, sample.input.Fault ? 1 : 0);
      }
      if (first) assert.deepEqual(repeatProjection(native), repeatProjection(first), 'Independent complete native scan effects agree');
      else first = native;
    }
    const finalBuild = await verifyNativeBuild(); assert.equal(finalBuild.identitySha256, build.identitySha256);
    report.independentNativeCapturesAgree = true; await mkdir(path.join(output, 'candidate'));
    return { native: { ...first, cases: cases(first) }, reader: first.reader, output };
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }; throw error;
  } finally {
    await writeFile(path.join(output, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}

export async function recordCandidate(name, observation) {
  const { output } = await captureCurrentNative();
  assert.match(name, /^[a-z0-9-]+$/u);
  await writeFile(path.join(output, 'candidate', name + '.json'), JSON.stringify(observation, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
}
