import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';
import { withBackupArchive } from '../../src/system/backup-archive.js';
import { BackupRestored } from '../../src/system/backups.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

test('archive and restore metadata under independent metadata prefix', async t => {
  const { request, runtime, programDataPath } = await createMetadataHttpFixture(t);
  const destination = path.join(validationOutputRoot(), 'review');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'routes.json'),JSON.stringify(runtime.implementedRoutes,null,2));
  const report = {};
  try {
    const metadata = runtime.applicationPaths.metadataPath;
    const logical = path.join(metadata, 'review-subtree');
    const backing = path.join(path.dirname(programDataPath), 'review-physical');
    await mkdir(backing);
    await mkdir(metadata, { recursive: true });
    const configuration = (await request('/Storage/Configuration')).body;
    configuration.instances.push({ id: 'review-meta', type: 'local', config: { root: backing, writable: true } });
    configuration.mounts.push({ path: '/review-meta', instanceId: 'review-meta', capabilities: { create: true, replace: true, delete: true, mkdir: true, rename: true } });
    configuration.prefixes.push({ identityRoot: logical, accessRoot: '/review-meta', purpose: 'metadata',
      style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'independent metadata volume' });
    const changed = await request('/Storage/Configuration', {method:'POST',body:configuration});
    report.configurationStatus = changed.status;
    assert.ok(changed.status >= 200 && changed.status < 300, JSON.stringify(changed.body));
    const control = path.join(metadata, 'review-control.txt'), child = path.join(logical, 'poster.txt');
    await writeFile(control, 'archived control');
    await writeFile(path.join(backing, 'poster.txt'), 'archived poster');
    report.before = [await runtime.fileSystem.readFile(control,'utf8'), await runtime.fileSystem.readFile(child,'utf8')];
    report.parentListsChild = (await runtime.fileSystem.readdir(metadata)).includes('review-subtree');
    const result = await request('/Backup/Create',{method:'POST',body:{Database:false,Metadata:true}});
    report.archiveStatus = result.status;
    assert.equal(result.status,200,JSON.stringify(result.body));
    report.metadataSelected = result.body.Options.Metadata;
    report.archiveEntries = await withBackupArchive(result.body.Path, archive =>
      [...archive.directory.keys()].filter(key => key.includes('review-') || key.includes('poster.txt')));
    await writeFile(control,'changed control');
    await writeFile(path.join(backing,'poster.txt'),'changed poster');
    await runtime.backups.stageRestore(result.body.Path,{admit:()=>({cancel(){}})});
    await assert.rejects(runtime.backups.restorePending(), BackupRestored);
    report.after = [await runtime.fileSystem.readFile(control,'utf8'),await runtime.fileSystem.readFile(child,'utf8')];
    assert.equal(report.after[0],'archived control');
  } finally {
    await writeFile(path.join(destination,'backup.json'),JSON.stringify(report,null,2));
  }
});

