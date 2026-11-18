import { BindingError, HttpResult, queryValue } from './binding.js';
import { binaryStreamResult } from './binary-result.js';
import { clrTrim } from '../metadata/whitespace.js';
import { findServerLog, getServerLogs, openServerLog } from '../system/server-logs.js';
import { getSystemStorage } from '../system/storage-info.js';

export function registerSystemInformationRoutes(add, services, localization) {
  const policy = 'RequiresElevation';
  const logDirectory = () => services.applicationPaths?.logDirectoryPath;
  add('GET', '/System/Info/Storage', ({ signal }) => getSystemStorage(services, signal), { policy });
  add('GET', '/System/Logs', ({ signal }) => getServerLogs(logDirectory(), localization.context.culture, signal), { policy });
  add('GET', '/System/Logs/Log', async ({ queryInput }) => {
    const filename = await findServerLog(logDirectory(), queryInput);
    return filename ? binaryStreamResult(options => openServerLog(filename, options), {
      ranges: false, contentType: 'text/plain; charset=utf-8',
    }) : new HttpResult(404, 'Log file not found.', { text: true });
  }, { policy, bindQuery(query) {
    const name = queryValue(query, 'name');
    if (!clrTrim(name ?? '')) throw new BindingError('name', 'The name field is required.');
    return name;
  } });
}
