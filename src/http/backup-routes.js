import { BindingError, httpError, member, noContent, queryValue, requireMember } from './binding.js';
import { lifecycleResponse } from './system-lifecycle-routes.js';

export function registerBackupRoutes(add, services) {
  const policy = 'RequiresElevation';
  const backups = () => {
    if (!services.backups) throw httpError(503, 'The application has no backup directory.');
    return services.backups;
  };
  add('GET', '/Backup', () => backups().list(), { policy });
  add('GET', '/Backup/Manifest', async ({ query }) => {
    const name = requireMember({ path: queryValue(query, 'path') }, 'path');
    return await backups().manifest(name) ?? noContent();
  }, { policy });
  add('POST', '/Backup/Create', ({ body }) => {
    const options = {};
    for (const key of ['Database', 'Metadata', 'Subtitles', 'Trickplay']) {
      const value = member(body, key);
      if (value !== undefined && typeof value !== 'boolean') throw new BindingError(key, 'A boolean is required.');
      options[key] = value ?? (key === 'Database');
    }
    if (services.libraryScanLifecycle?.isScanRunning) throw httpError(409, 'A library scan is in progress.');
    return backups().create(options);
  }, { policy, body: true, optionalBody: true });
  add('POST', '/Backup/Restore', async ({ body }) => {
    const reservation = await backups().stageRestore(requireMember(body, 'ArchiveFileName'), services.systemLifecycle);
    return lifecycleResponse(reservation, { durable: true });
  }, { policy, body: true });
}
