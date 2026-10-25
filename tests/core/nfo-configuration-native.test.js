import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { currentNfoConfiguration, nfoInput } from '../metadata/nfo-configuration-current.js';
import { candidateNfoConfiguration } from '../metadata/fixtures/nfo-configuration-current/node-cases.js';
import { namedCoreProjection, namedDiskProjection, namedError } from './named-configuration-current.js';
import { configurationJson } from './fixtures/configuration/observations.js';
import { localStateStorage } from '../helpers/local-state-storage.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { nativeGuid } from '../../src/users/native.js';
import { namedFailurePayload } from './named-configuration-current.js';
import { child, readXml, textOf } from '../../src/core/xml.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll'];
test('NFO named current owner matches actual factory/events/aliases, keeps original XML and cold known values', {
  skip: !process.env.MEDIAMANAGER_JELLYFIN_DLL, timeout: 300000,
}, async () => {
  const captured = await currentNfoConfiguration();
  const report = { scope: captured.report.scope, nativeCapture: captured.output, comparisons: [], failures: [],
    phaseAcceptance: false, releaseAcceptance: false };
  try {
    const saved = [];
    for (const [index, sample] of nfoInput.core.entries()) {
      const reference = captured.native.core[index], repeat = captured.repeat.core[index];
      assert.deepEqual(namedCoreProjection(repeat), namedCoreProjection(reference), sample.name + ': independent Native');
      const actual = await candidateNfoConfiguration(sample, path.join(captured.output, 'node-core-' + index));
      report.comparisons.push({ sample: sample.name, actual, reference, repeat });
      assert.deepEqual(namedCoreProjection(actual), namedCoreProjection(reference), sample.name + ': public current/persistence prefix');
      if (['missing-get-does-not-create-file', 'malformed-get-preserves-original-bytes'].includes(sample.name)) {
        assert.equal(actual.after.disk.bytes, sample.xml === undefined ? null : Buffer.from(sample.xml).toString('base64'));
      }
      if (sample.name === 'unknown-xml-live-alias-and-cold-known-values') {
        const bytes = await fs.readFile(actual.filename), text = bytes.toString();
        assert.match(text, /<Future\b[^>]*xmlns="urn:nfo:future"[^>]*note="preserve"[^>]*>before<Child\s*\/>after<\/Future>/u);
        report.nodeUnknownXmlPreserved = { filename: actual.filename, bytesBase64: bytes.toString('base64') };
        // Native itself rewrites modeled fields and drops this unknown subtree.
        assert.doesNotMatch(Buffer.from(reference.after.disk.bytes, 'base64').toString(), /urn:nfo:future/u);
      }
      if (actual.after.disk.bytes && actual.after.disk.accepted) saved.push({ name: sample.name, root: 'xbmcmetadata', filename: actual.filename });
    }
    const consumed = await captured.consume(saved, 'node-files-native-cold'); report.nativeColdRead = consumed;
    for (const row of consumed.native.consumed) {
      const actual = report.comparisons.find(value => value.sample === row.name).actual;
      assert.deepEqual(namedDiskProjection(row.disk, 'xbmcmetadata'), namedDiskProjection(actual.after.disk, 'xbmcmetadata'), row.name);
    }
    report.folderCases = [];
    const scenario = nfoInput.consumers[0], expected = captured.native.consumers[0].folderCases, repeated = captured.repeat.consumers[0].folderCases;
    const projection = row => ({ name: row.name, failed: row.failed, title: row.title, beforeBase64: row.beforeBase64,
      ...(row.failed && { afterBase64: row.afterBase64 }), nfo: row.nfo });
    for (const [index, sample] of scenario.folderUserIds.entries()) {
      const reference = expected[index]; assert.deepEqual(projection(repeated[index]), projection(reference));
      const root = path.join(captured.output, 'node-folder-' + index); await fs.mkdir(root);
      const storage = await localStateStorage(root), directory = path.join(root, 'season'), target = path.join(directory, 'season.nfo'), spoolRoot = path.join(root, 'spool');
      let actual, primary;
      try {
        await storage.fileSystem.mkdir(directory); await storage.fileSystem.mkdir(spoolRoot);
        const original = Buffer.from(scenario.previousFolderNfo); await storage.fileSystem.writeFile(target, original);
        const configuration = { ...defaultConfiguration('xbmcmetadata'), UserId: sample.userId };
        const plugin = createNfoPlugin({ vfs: storage.fileSystem.vfs, fileSystem: storage.fileSystem, spoolRoot, getConfiguration: () => configuration });
        const item = { Id: '20000000-0000-0000-0000-000000000004', Type: 'Season', Path: directory, Name: 'Folder fixture', IsFolder: true,
          IsFileProtocol: true, SupportsLocalMetadata: true, DateCreated: '2025-01-02T03:04:05Z', IndexNumber: 1 };
        let failure = null;
        try { await plugin.save(item, { accessPath: '/state/season', people: [], images: [], mediaStreams: [],
          getUserData: async (current, userId) => {
            const exists = scenario.before.UserId === userId || scenario.after.UserId === userId;
            if (!exists || current.IsFolder) return null;
            throw new Error('Folder play state is unavailable.');
          } }); }
        catch (error) { failure = namedError(error); }
        const bytes = await storage.fileSystem.readFile(target), xml = readXml(bytes.toString());
        const nfo = { premiered: textOf(xml, 'premiered') ?? null, aired: textOf(xml, 'aired') ?? null,
          playcount: textOf(xml, 'playcount') ?? null, watched: textOf(xml, 'watched') ?? null,
          position: child(xml, 'resume') ? textOf(child(xml, 'resume'), 'position') ?? null : null,
          total: child(xml, 'resume') ? textOf(child(xml, 'resume'), 'total') ?? null : null,
          poster: child(xml, 'art') ? textOf(child(xml, 'art'), 'poster') ?? null : null };
        actual = { name: sample.name, failed: failure !== null, failure, beforeBase64: original.toString('base64'), afterBase64: bytes.toString('base64'), title: textOf(xml, 'title'), nfo };
        report.folderCases.push({ actual, reference, repeat: repeated[index] });
        assert.deepEqual(projection(actual), projection(reference), sample.name);
        if (reference.failed) {
          assert.deepEqual(bytes, original, 'An invalid configured UserId fails before replacing the actual folder NFO.');
          let expectedFailure; try { nativeGuid(sample.userId); } catch (error) { expectedFailure = namedError(error); }
          assert.deepEqual(namedFailurePayload(failure.cause), namedFailurePayload(expectedFailure));
          assert.deepEqual(namedFailurePayload(failure), { message: 'NFO user data configuration is invalid.', cause: namedFailurePayload(expectedFailure) });
          assert.equal(failure.status ?? failure.statusCode ?? 500, 500, 'An internal NFO configuration save error retains server-error classification.');
        }
        assert.deepEqual(await fs.readdir(spoolRoot), [], 'The actual prepared XML spool closes on success and failure.');
        const handle = await fs.open(target, 'r+'); await handle.close();
      } catch (error) { primary = error; throw error; }
      finally {
        try { await storage.close(); }
        catch (cleanup) { throw new AggregateError(primary ? [primary, cleanup] : [cleanup], 'Folder NFO resources failed to close.', { cause: primary ?? cleanup }); }
      }
    }
  } catch (error) { report.failures.push(namedError(error)); throw error; }
  finally { await fs.writeFile(path.join(captured.output, 'node-core-comparison.json'), configurationJson(report), { flag: 'wx' }); }
});
