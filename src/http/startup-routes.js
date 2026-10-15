import { BindingError, HttpResult, noContent, notFound } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';

const string = { type: 'string', clrType: 'System.String', nullable: true };
const definitions = {
  StartupConfigurationDto: { defaults: { ServerName: null, UICulture: null, MetadataCountryCode: null, PreferredMetadataLanguage: null },
    fields: { ServerName: string, UICulture: string, MetadataCountryCode: string, PreferredMetadataLanguage: string } },
  StartupRemoteAccessDto: { defaults: { EnableRemoteAccess: false },
    fields: { EnableRemoteAccess: { type: 'boolean', clrType: 'System.Boolean', nullable: false } } },
  StartupUserDto: { defaults: { Name: null, Password: null }, fields: { Name: string, Password: string } }
};
function bodyOptions(name, parameter) {
  const root = { type: 'object', reference: name, clrType: 'Jellyfin.Api.Models.StartupDtos.' + name };
  return { body: true, bodyType: root.clrType, bodyParameter: parameter, bindBody: (body, source) => {
    if (body == null) throw new BindingError('', 'A non-empty request body is required.');
    return bindJsonModel(body, { schema: { definitions }, root, source });
  } };
}

export function registerStartupRoutes(add, { startup }) {
  if (!startup) return;
  const policy = 'FirstTimeSetupOrElevated';
  add('GET', '/Startup/Configuration', () => startup.getConfiguration(), { policy });
  add('POST', '/Startup/Configuration', async ({ body }) => { await startup.updateConfiguration(body); return noContent(); },
    { policy, ...bodyOptions('StartupConfigurationDto', 'startupConfiguration') });
  add('POST', '/Startup/RemoteAccess', async ({ body }) => { await startup.updateRemoteAccess(body); return noContent(); },
    { policy, ...bodyOptions('StartupRemoteAccessDto', 'startupRemoteAccessDto') });
  add('POST', '/Startup/Complete', async () => { await startup.complete(); return noContent(); }, { policy });
  add('GET', ['/Startup/User', '/Startup/FirstUser'], () => startup.getUser(), { policy });
  add('POST', '/Startup/User', async ({ body }) => {
    const result = await startup.updateUser(body);
    if (result === 'missing') return notFound();
    if (result === 'configured') return new HttpResult(403);
    if (result === 'empty-password') return new HttpResult(400, 'Password must not be empty');
    return noContent();
  }, { policy, ...bodyOptions('StartupUserDto', 'startupUserDto') });
}
