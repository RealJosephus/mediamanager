import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseConfigurationVersion } from '../core/configuration-xml.js';
import { backupFormat, legacyBackupFormat, payloadPath, publicManifest, stageBackupArchive, verifyStagedPayload, withBackupArchive, writeBackupArchive } from './backup-archive.js';
import { backupDestination, backupRoots, captureBackupFiles, captureStorageDefinition, restoreBackupFile, storageDefinitionKey, storageDefinitionTarget } from './backup-files.js';
import { captureBackupDatabase, restoreBackupDatabase, validateBackupDatabase } from './backup-database.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const backupEngineVersion = '1.0.0';
export class BackupRestored extends Error {}

export class SystemBackups {
  constructor({ paths, openStorage, storageConfigurationPath, withRestoreStorage, store, serverId, serverVersion }) {
    Object.assign(this, { paths, openStorage, storageConfigurationPath, withRestoreStorage, store, serverId, serverVersion });
    this.directory = path.join(paths.dataPath, 'backups');
    this.pending = path.join(this.directory, '.restore');
  }

  archivePath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw failure(400, 'An archive filename is required.');
    const name = path.win32.basename(value);
    if (!/\.zip$/iu.test(name) || /[:/\\]/u.test(name)) throw failure(404, 'Backup archive not found.');
    return path.join(this.directory, name);
  }

  async manifest(value) {
    const filename = this.archivePath(value);
    try { return await withBackupArchive(filename, archive => publicManifest(filename, archive.json('manifest.json'))); }
    catch (error) {
      if (error.code === 'ENOENT') throw failure(404, 'Backup archive not found.');
      if (error.code && !['invalid-archive', 'ERR_BUFFER_OUT_OF_BOUNDS', 'Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_BUFFER_TOO_LARGE'].includes(error.code)) throw error;
      return null;
    }
  }

  async list() {
    let entries;
    try { entries = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const entry of entries.filter(entry => entry.isFile() && /\.zip$/iu.test(entry.name))) {
      const manifest = await this.manifest(entry.name);
      if (manifest) result.push(manifest);
    }
    return result.sort((a, b) => Date.parse(b.DateCreated) - Date.parse(a.DateCreated));
  }

  async create(options) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stage = await fs.mkdtemp(path.join(this.directory, '.create-'));
    try {
      const filename = path.join(this.directory, 'jellyfin-backup-' + randomUUID() + '.zip');
      const manifest = { DateCreated: new Date().toISOString(), ServerVersion: this.serverVersion, BackupEngineVersion: backupEngineVersion, Options: options };
      const descriptor = { format: backupFormat, serverId: this.serverId, metadataPath: this.paths.metadataPath };
      const temporary = path.join(stage, 'archive');
      const storage = await this.openStorage();
      const roots = backupRoots(this.paths, options);
      await writeBackupArchive(temporary, stage, manifest, descriptor, async save => {
        let generation;
        try {
          await storage.withStableConfiguration(async () => {
            generation = storage.retainGeneration();
            await captureStorageDefinition(this.storageConfigurationPath, storage.configuration(), save);
            await captureBackupFiles(roots.filter(root => root.local), this.directory, save, this.storageConfigurationPath);
          });
          if (options.Database) {
            await this.store.transaction(db => captureBackupDatabase(db, save), { readOnly: true, isolation: 'repeatable-read' });
          }
          await captureBackupFiles(roots.filter(root => !root.local), this.directory, save, this.storageConfigurationPath, generation);
        } finally { generation?.close(); }
      });
      await fs.rename(temporary, filename);
      return publicManifest(filename, manifest);
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }

  #checkVersions(manifest) {
    const archived = parseConfigurationVersion(manifest.ServerVersion)?.split('.').map(Number);
    const running = parseConfigurationVersion(this.serverVersion)?.split('.').map(Number);
    if (!archived || !running) throw failure(422, 'Invalid backup or server version.');
    for (const [index, part] of archived.entries()) {
      // System.Version orders an omitted build or revision before zero.
      const current = running[index] ?? -1;
      if (part > current) throw failure(422, 'This backup requires a newer server version.');
      if (part < current) break;
    }
    if (parseConfigurationVersion(manifest.BackupEngineVersion) !== backupEngineVersion) {
      throw failure(422, 'Unsupported backup engine version.');
    }
  }

  #plan(stage, manifest, descriptor) {
    this.#checkVersions(manifest);
    const options = manifest.Options;
    if (![backupFormat, legacyBackupFormat].includes(descriptor.format) || descriptor.serverId !== this.serverId ||
      (options.Metadata && descriptor.metadataPath !== this.paths.metadataPath) || !Array.isArray(descriptor.files)) {
      throw failure(422, 'This backup is incompatible with the active instance or its metadata root.');
    }
    const roots = backupRoots(this.paths, options);
    const payloads = new Map(), destinations = new Map();
    const hasDefinition = descriptor.format === backupFormat;
    for (const [index, file] of descriptor.files.entries()) {
      const { key, size, sha256 } = file;
      if (typeof key !== 'string' || payloads.has(key) || !Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/u.test(sha256)) {
        throw failure(422, 'Invalid backup file inventory.');
      }
      payloads.set(key, payloadPath(stage, index));
      if (options.Database && /^Database\/(?:catalog\.json|(?:0|[1-9]\d*)\.ndjson)$/u.test(key)) continue;
      const target = hasDefinition && key === storageDefinitionKey
        ? storageDefinitionTarget(this.storageConfigurationPath) : backupDestination(roots, key);
      if (!target.local && (!hasDefinition || !/^[0-9a-f]{64}$/u.test(file.storageBinding))) {
        throw failure(422, 'This backup does not identify the original storage volume for ' + key + '.');
      }
      if (hasDefinition && key !== storageDefinitionKey && target.local && !path.relative(this.storageConfigurationPath, target.filename)) {
        throw failure(422, 'The selected storage configuration appears twice in the backup.');
      }
      if ((file.mode !== undefined && (!target.local || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777))
        || (file.mtimeMs !== undefined && (!target.local || !Number.isFinite(file.mtimeMs) || !Number.isFinite(new Date(file.mtimeMs).getTime())))) {
        throw failure(422, 'Invalid backup file attributes.');
      }
      const relative = target.api.relative(this.directory, target.filename);
      if (!relative || !target.api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + target.api.sep)) {
        throw failure(422, 'A backup entry overlaps the backup directory.');
      }
      destinations.set(key, target);
    }
    if (options.Database && !payloads.has('Database/catalog.json')) throw failure(422, 'The database catalog is missing.');
    if (descriptor.format === backupFormat && !payloads.has(storageDefinitionKey)) throw failure(422, 'The archived storage definition is missing.');
    return { payloads, destinations };
  }

  async #withRestoreFiles({ payloads, destinations }, descriptor, operation) {
    if (!payloads.has(storageDefinitionKey)) return operation(); // Legacy local files and database rows.
    const definition = JSON.parse(await fs.readFile(payloads.get(storageDefinitionKey), 'utf8'));
    return this.withRestoreStorage(definition, async (files, getStorageBinding) => {
      for (const file of descriptor.files) {
        const target = destinations.get(file.key);
        if (!target || target.local) continue;
        let actual;
        try { actual = await getStorageBinding(target.filename); }
        catch (cause) { throw Object.assign(failure(422, 'The archived volume is unavailable for ' + file.key + '.'), { cause }); }
        if (actual !== file.storageBinding) throw failure(422, 'The original storage volume does not match ' + file.key + '.');
      }
      return operation(files);
    });
  }

  async stageRestore(value, lifecycle) {
    const filename = this.archivePath(value);
    const manifest = await this.manifest(value);
    if (!manifest) throw failure(422, 'Invalid backup archive.');
    this.#checkVersions(manifest);
    if (!lifecycle) throw failure(503, 'The application has no lifecycle owner.');
    const reservation = lifecycle.admit('restart');
    let stage;
    try {
      stage = await fs.mkdtemp(path.join(this.directory, '.prepare-'));
      await withBackupArchive(filename, async archive => {
        const current = publicManifest(filename, archive.json('manifest.json'));
        if (!archive.directory.has('mediamanager.json')) throw failure(422, 'Unsupported backup database format.');
        const descriptor = archive.json('mediamanager.json');
        const plan = this.#plan(stage, current, descriptor);
        await stageBackupArchive(archive, stage, descriptor.files);
        await this.#withRestoreFiles(plan, descriptor, () => {});
        if (current.Options.Database) {
          const catalog = JSON.parse(await fs.readFile(plan.payloads.get('Database/catalog.json'), 'utf8'));
          await this.store.run(db => validateBackupDatabase(db, plan.payloads, catalog));
        }
        await fs.writeFile(path.join(stage, 'request.json'), JSON.stringify({ manifest: current, descriptor }), { flag: 'wx', mode: 0o600 });
      });
      try { await fs.rename(stage, this.pending); stage = null; }
      catch (error) {
        if (['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code) && await fs.stat(this.pending).catch(() => null)) {
          throw failure(409, 'Another backup restore is already pending.');
        }
        throw error;
      }
      return reservation;
    } catch (error) { reservation.cancel(); throw error; }
    finally { if (stage) await fs.rm(stage, { recursive: true, force: true }); }
  }

  async restorePending() {
    try { await fs.access(this.pending); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const { manifest, descriptor } = JSON.parse(await fs.readFile(path.join(this.pending, 'request.json'), 'utf8'));
    const plan = this.#plan(this.pending, publicManifest('', manifest), descriptor);
    const { payloads, destinations } = plan;
    for (const file of descriptor.files) await verifyStagedPayload(payloads.get(file.key), file);
    const catalog = manifest.Options.Database && JSON.parse(await fs.readFile(payloads.get('Database/catalog.json'), 'utf8'));
    // The listener is still closed. A failed file replacement rolls back SQL
    // and leaves the complete request available for an idempotent cold retry.
    await this.#withRestoreFiles(plan, descriptor, files => this.store.transaction(async db => {
      if (catalog) await restoreBackupDatabase(db, payloads, catalog);
      for (const file of descriptor.files) {
        const target = destinations.get(file.key);
        if (target) await restoreBackupFile(target, payloads.get(file.key), file, files);
      }
    }));
    const applied = path.join(this.directory, '.applied-' + randomUUID());
    await fs.rename(this.pending, applied);
    await fs.rm(applied, { recursive: true, force: true });
    throw new BackupRestored('Reload restored instance configuration before admitting requests.');
  }
}
