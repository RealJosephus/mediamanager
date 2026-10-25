import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentNativeReference } from '../../../../tools/compat/current-native-reference.js';
import { recordOracle } from '../../../../tools/validation/oracle.js';
import { validationOutputRoot } from '../../../../tools/validation/paths.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Fresh native captures replace missing historical execution inputs. The old
 * recording and its seal retain their original, independent identities. */
export async function captureShows(inputBytes) {
  const root = path.join(validationOutputRoot(), 'shows-current-' + randomUUID());
  await mkdir(root);
  const inputFile = path.join(root, 'input.json'); await writeFile(inputFile, inputBytes, { flag: 'wx' });
  const report = { kind: 'same-run-designated-shows-capture', inputSha256: sha256(inputBytes), receipts: [],
    phaseAcceptance: false, releaseAcceptance: false, consumerAcceptanceEstablishedByCaptureAlone: false };
  let current, failure, closing;
  const finish = () => closing ??= (async () => {
    try { await current?.finish(); report.protectedInputsUnchanged = current ? true : null; }
    catch (error) { report.protectedInputsUnchanged = false; failure ??= error; }
    report.captureComplete = report.receipts.length === 2 && !failure;
    if (failure) report.error = { name: failure.name, message: failure.message, stack: failure.stack };
    await writeFile(path.join(root, 'capture.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (failure) throw failure;
  })();
  try {
    current = await currentNativeReference(); report.preparation = current.preparation;
    const sourcePaths = JSON.parse(await readFile(new URL('./source-paths.json', import.meta.url), 'utf8'));
    report.sourceBindings = await current.sourceBindings(sourcePaths);
    const observations = [];
    for (let index = 0; index < 2; index++) {
      const output = path.join(root, 'native-' + (index + 1));
      const receipt = await recordOracle({ project: 'tests/http/fixtures/shows-current/Oracle.csproj', output,
        args: [inputFile, '{output}/native.json'], environment: current.environment });
      const bytes = await readFile(path.join(output, 'native.json')), observation = JSON.parse(bytes);
      assert.equal(receipt.passed, true); assert.equal(observation.inputSha256, report.inputSha256);
      assert.equal(receipt.outputs.find(entry => path.basename(entry.filename) === 'native.json').sha256, sha256(bytes));
      assert.ok(observation.runtimeAssemblies.some(entry => !entry.managed && entry.name === 'e_sqlite3'),
        'The supplied platform SQLite module must be loaded in the native process.');
      assert.equal(observation.nativeSqliteImportResolved, true,
        'Actual SQLitePCL imports must resolve through the supplied platform module.');
      for (const entry of observation.runtimeAssemblies) {
        const assembly = await readFile(entry.path); assert.equal(assembly.length, entry.bytes); assert.equal(sha256(assembly), entry.sha256);
      }
      report.receipts.push(receipt); observations.push(observation);
      await writeFile(path.join(root, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
    }
    assert.notEqual(report.receipts[0].process.args[0], report.receipts[1].process.args[0]);
    return { native: observations[0], repeat: observations[1], receipts: report.receipts,
      inputSha256: report.inputSha256, sourceBindings: report.sourceBindings, finish };
  } catch (error) { failure = error; await finish(); throw error; }
}
