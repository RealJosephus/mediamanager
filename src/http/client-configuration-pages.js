import { BinaryResult } from './binary-result.js';
import { BindingError, HttpResult, booleanValue, guidValue, queryValue } from './binding.js';
import { ordinalIgnoreCaseEquals } from '../storage/ordinal-comparer.js';
import { embyTextResponse } from './client-protocol.js';

export function registerClientConfigurationPages(add, { plugins }) {
  const pages = new Map();
  const activePages = () => {
    const active = new Set(plugins?.entries('route') ?? []);
    return [...pages].filter(([extension]) => active.has(extension)).map(([, page]) => page);
  };
  add('GET', '/web/ConfigurationPages', context => {
    let main, userMenu;
    try {
      main = booleanValue(queryValue(context.query, 'enableInMainMenu'), 'enableInMainMenu');
      if (context.embyClient) userMenu = booleanValue(queryValue(context.query, 'enableInUserMenu'), 'enableInUserMenu');
    } catch (error) {
      if (!(error instanceof BindingError) || !context.embyClient) throw error;
      const value = queryValue(context.query, Object.keys(error.errors)[0]);
      return embyTextResponse(500, `String '${value}' was not recognized as a valid Boolean.`);
    }
    if (context.embyClient) try { guidValue(queryValue(context.query, 'userId'), 'userId'); }
    catch (error) {
      if (!(error instanceof BindingError)) throw error;
      return embyTextResponse(500, 'Unrecognized Guid format.');
    }
    // Emby exposes page metadata to authenticated readers, including another
    // user's menu. Configuration changes are authorized by the plugin's API.
    return activePages().filter(page => (main === undefined || page.info.EnableInMainMenu === main)
      && (userMenu === undefined || page.enableInUserMenu === userMenu))
      .map(page => ({ ...page.info, ...(context.embyClient && { EnableInUserMenu: page.enableInUserMenu,
        ConfigurationPageType: page.isMainConfigPage ? 'PluginConfiguration' : 'None' }) }));
  }, { policy: context => context.embyClient ? 'Default' : 'RequiresElevation' });
  for (const method of ['GET', 'HEAD']) add(method, '/web/ConfigurationPage', context => {
    const name = queryValue(context.query, 'name');
    const page = name == null ? undefined : activePages().find(page => ordinalIgnoreCaseEquals(page.info.Name, name));
    return page ? BinaryResult.bytes(page.bytes, page.contentType) : new HttpResult(404);
  }, { public: true });
  return {
    install(extension) {
      const page = extension.configurationPage;
      if (page === undefined) return () => {};
      if (extension.method !== 'GET' || !page || typeof page !== 'object' || Array.isArray(page)
        || typeof page.name !== 'string' || !page.name.trim() || typeof page.content !== 'string'
        || Buffer.byteLength(page.content) > 32 * 1024 * 1024
        || ['enableInMainMenu', 'enableInUserMenu', 'isMainConfigPage'].some(name => page[name] !== undefined && typeof page[name] !== 'boolean')
        || ['displayName', 'menuSection', 'menuIcon'].some(name => page[name] != null && typeof page[name] !== 'string')
        || page.contentType !== undefined && !['text/html', 'application/javascript', 'application/x-javascript', 'text/css'].includes(page.contentType)
        || [...pages.values()].some(existing => ordinalIgnoreCaseEquals(existing.info.Name, page.name))) {
        throw new TypeError('Invalid or conflicting plugin configuration page.');
      }
      pages.set(extension, { info: { Name: page.name, EnableInMainMenu: page.enableInMainMenu ?? false,
        MenuSection: page.menuSection ?? null, MenuIcon: page.menuIcon ?? null, DisplayName: page.displayName ?? page.name, PluginId: null },
        enableInUserMenu: page.enableInUserMenu ?? false,
        isMainConfigPage: page.isMainConfigPage ?? false,
        bytes: Buffer.from(page.content), contentType: (page.contentType ?? 'text/html') + '; charset=utf-8' });
      return () => pages.delete(extension);
    }
  };
}
