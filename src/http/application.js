import { jsonProfile } from './json-profile.js';
import { createCoreLocalization } from '../core/i18n.js';
import { loadLocalizationData } from '../core/localization-data.js';
import { stringifyNativeJson } from '../core/json.js';
import { HttpResult, BindingError, readBody, queryValue } from './binding.js';
import { registerDomainRoutes } from './routes.js';
import { registerPlaybackRoutes } from './playback-routes.js';
import { BinaryResult } from './binary-result.js';
import { registerClientNetworkRoutes } from './client-network-routes.js';
import { registerClientDiscoveryRoutes } from './client-discovery-routes.js';
import { registerClientConfigurationPages } from './client-configuration-pages.js';
import { embyTextResponse, isEmbyClient as detectEmbyClient } from './client-protocol.js';
import { registerUserDataCopyRoutes } from './user-data-copy-routes.js';
import { registerSearchHistoryRoutes } from './search-history-routes.js';
import { registerEmbyHomeSectionRoutes } from './emby-home-section-routes.js';
import { registerConfigurationRoutes } from './configuration-routes.js';
import { registerFallbackFontRoutes } from './fallback-font-routes.js';
import { registerLiveTvTimerRoutes } from './live-tv-timer-routes.js';
import { registerLiveTvRecordingRoutes } from './live-tv-recording-routes.js';
import { registerLiveTvSourceRoutes } from './live-tv-source-routes.js';
import { registerSessionControlRoutes } from './session-control-routes.js';
import { registerMetadataRoutes } from './metadata-routes.js';
import { registerImageRoutes } from './image-routes.js';
import { createWebSocketServer } from './websocket.js';
import { baseUrlRedirect, requestIsLocal, requestNetworkInfo, requestPath, requestUrl } from '../network/http-request.js';
import { registerSyncPlayRoutes } from './syncplay-routes.js';
import { registerScheduledTaskRoutes } from './scheduled-task-routes.js';
import { registerPlaylistRoutes } from './playlist-routes.js';
import { registerMetadataEditorRoutes } from './metadata-editor-routes.js';
import { registerItemDeletionRoutes } from './item-deletion-routes.js';
import { registerBrandingRoutes } from './branding-routes.js';
import { registerCollectionRoutes } from './collection-routes.js';
import { registerLibraryStructureRoutes } from './library-structure-routes.js';
import { registerQuickConnectRoutes } from './quick-connect-routes.js';
import { registerPasswordResetRoutes } from './password-reset-routes.js';
import { registerDisplayPreferencesRoutes } from './display-preferences-routes.js';
import { registerStartupRoutes } from './startup-routes.js';
import { registerApiKeyRoutes } from './api-key-routes.js';
import { registerActivityLogRoutes } from './activity-log-routes.js';
import { registerMediaSegmentRoutes } from './media-segment-routes.js';
import { registerLyricRoutes } from '../lyrics/routes.js';
import { registerSystemLifecycleRoutes } from './system-lifecycle-routes.js';
import { registerEnvironmentRoutes } from './environment-routes.js';
import { registerClientLogRoutes } from './client-log-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { serverFriendlyName } from '../configuration.js';
import { applyCors } from './cors.js';

export async function createApplication(services = {}) {
  const { authentication, serverId, serverName = 'MediaManager', serverVersion = '13.0.0', baseUrl = '', publicAddress, onError = () => {} } = services;
  const getNetworkConfiguration = services.getNetworkConfiguration ?? (() => ({ BaseUrl: baseUrl }));
  if (!services.configuration || !authentication) throw new TypeError('Configuration and authentication services are required.');
  const localization = services.localization ?? await createCoreLocalization({ serverCulture: services.configuration.UICulture || 'en-US' });
  const data = await loadLocalizationData();
  const routes = [];
  function add(method, paths, run, { policy = 'Default', public: isPublic = false, body = false, allowForm = false, optionalBody = false, bindBody, bindQuery, bodyParameter, bodyType, bodyDocument = false, constraints = {} } = {}) {
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      const names = [];
      const expression = path.split(/(\{\w+\})/).map(part => {
        if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([^/]+)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      routes.push({ method, path, pattern: new RegExp(`^${expression}/?$`, 'i'), names, run, policy, isPublic, body, allowForm, optionalBody, bindBody, bindQuery, bodyParameter, bodyType, bodyDocument, constraints });
    }
  }
  for (const method of ['GET', 'POST']) add(method, '/System/Ping', () => new HttpResult(200, 'MediaManager', { text: true }), { public: true });
  const isEmbyClient = context => detectEmbyClient(authentication, context);
  const clientSystemVersion = context => isEmbyClient(context) ? '4.9.5.0' : serverVersion;
  const publicSystemInfo = context => ({ LocalAddress: services.getSmartApiUrl ? services.getSmartApiUrl(context.request) : publicAddress || `http://${context.request.headers.host}${baseUrl}`,
    ServerName: serverFriendlyName(services.configuration, serverName), Version: clientSystemVersion(context), ProductName: 'MediaManager', Id: serverId,
    StartupWizardCompleted: Boolean(services.configuration.IsStartupWizardCompleted) });
  add('GET', '/System/Info/Public', publicSystemInfo, { public: true });
  registerClientNetworkRoutes(add, services);
  registerClientDiscoveryRoutes(add, services);
  const configurationPages = registerClientConfigurationPages(add, services);
  // SystemController.GetSystemInfo permits session validation outside parental
  // schedules. Its SystemManager DTO reports the current application's state.
  add('GET', '/System/Info', async context => ({ ...publicSystemInfo(context),
    HasPendingRestart: services.networkHost?.hasPendingRestart ?? false, IsShuttingDown: closing, CompletedInstallations: [],
    WebSocketPortNumber: services.networkHost?.httpPort ?? 8096,
    SupportsLibraryMonitor: Boolean(services.libraryMonitor),
    CastReceiverApplications: services.configuration.CastReceiverApplications ?? [],
    ProgramDataPath: services.applicationPaths?.programDataPath ?? null,
    ItemsByNamePath: services.applicationPaths?.metadataPath ?? null,
    InternalMetadataPath: services.applicationPaths?.metadataPath ?? null,
    CachePath: services.applicationPaths?.cachePath ?? null,
    TranscodingTempPath: services.encodingPaths && services.applicationPaths?.cachePath
      ? await services.encodingPaths.getTranscodePath() : null,
    // Web files are supplied by a separate static server.
    WebPath: null, LogPath: services.applicationPaths?.logDirectoryPath ?? null, PackageName: null
  }), { policy: 'FirstTimeSetupOrIgnoreParentalControl' });
  for (const [name, run] of Object.entries({ Cultures: () => data.cultures(localization.context.culture), Countries: () => data.countries,
    ParentalRatings: () => data.parentalRatings(services.configuration.MetadataCountryCode || 'US'), Options: () => data.options })) {
    add('GET', `/Localization/${name}`, run, { policy: 'FirstTimeSetupOrDefault' });
  }
  registerQuickConnectRoutes(add, services);
  registerConfigurationRoutes(add, services);
  registerFallbackFontRoutes(add, services);
  registerLiveTvTimerRoutes(add, services);
  registerLiveTvRecordingRoutes(add, services);
  registerLiveTvSourceRoutes(add, services);
  registerPasswordResetRoutes(add, services);
  registerDisplayPreferencesRoutes(add, services);
  registerStartupRoutes(add, services);
  registerApiKeyRoutes(add, services);
  registerActivityLogRoutes(add, services);
  registerMediaSegmentRoutes(add, services);
  registerLyricRoutes(add, services);
  registerSystemLifecycleRoutes(add, services);
  registerClientLogRoutes(add, services, localization);
  registerEnvironmentRoutes(add, { ...services, localization });
  registerUserDataCopyRoutes(add, services);
  registerSearchHistoryRoutes(add, services);
  registerEmbyHomeSectionRoutes(add, services);
  registerPluginRoutes(add, services);
  registerDomainRoutes(add, services);
  registerPlaybackRoutes(add, services);
  registerSessionControlRoutes(add, services);
  registerMetadataRoutes(add, services);
  registerImageRoutes(add, services);
  registerBrandingRoutes(add, services);
  registerSyncPlayRoutes(add, services);
  registerScheduledTaskRoutes(add, services);
  registerPlaylistRoutes(add, services);
  registerCollectionRoutes(add, services);
  registerLibraryStructureRoutes(add, services);
  registerItemDeletionRoutes(add, services);
  registerMetadataEditorRoutes(add, services);
  if (services.plugins) await services.plugins.bind('route', extension => {
    if (!['GET','POST','PUT','DELETE'].includes(extension.method) || typeof extension.path !== 'string'
      || !extension.path.startsWith('/') || typeof extension.handle !== 'function'
      || routes.some(route => route.method === extension.method && route.path.toLowerCase().replace(/\{[^}]+\}/g,'{}') === extension.path.toLowerCase().replace(/\{[^}]+\}/g,'{}'))) {
      throw new TypeError('Invalid or conflicting plugin HTTP route.');
    }
    const removePage = configurationPages.install(extension);
    const first = routes.length;
    add(extension.method, extension.path, context => extension.handle(context), { policy: extension.policy ?? 'Default', body: extension.body === true });
    const registered = routes.slice(first);
    return () => {
      removePage();
      for (const route of registered) { const index=routes.indexOf(route); if(index>=0)routes.splice(index,1); }
    };
  });
  let closing = false;
  let activeRequests = 0;
  let idle;
  const shutdown = new AbortController();
  const beginClose = () => { closing = true; shutdown.abort(); };
  const drainRequests = async () => {
    while (activeRequests) { idle ??= Promise.withResolvers(); await idle.promise; }
  };
  const runInContext = services.runWithContext ?? (operation => operation());
  const handler = async (request, response) => {
    let phase = 'admission';
    if (closing) { response.writeHead(503); response.end(); return; }
    activeRequests++;
    try {
    await runInContext(async () => {
    const locale = localization.negotiate({ url: request.url, headers: request.headers });
    await localization.run(locale, async () => {
      response.setHeader('Content-Language', 'en-US');
      const send = value => {
        const result = value instanceof HttpResult ? value : new HttpResult(200, value);
        response.statusCode = result.status;
        if (result.body === undefined || result.status === 204) { response.end(); return; }
        const accept = request.headers.accept ?? '';
        const json = !result.text || accept.includes('application/json');
        const profile = jsonProfile(accept);
        response.setHeader('Content-Type', json ? 'application/json' + (profile ? '; profile="' + profile + '"' : '') + '; charset=utf-8' : 'text/plain; charset=utf-8');
        const body = json ? stringifyNativeJson(result.body, { camel: profile === 'CamelCase' }) : result.body;
        if (!json) response.setHeader('Content-Length', Buffer.byteLength(body));
        if (request.method !== 'HEAD') response.write(body);
        response.end();
      };
      try {
        phase = 'routing';
        const url = requestUrl(request);
        let path = requestPath(request);
        if (/%00/iu.test(url.pathname)) { send(new HttpResult(400)); return; }
        phase = 'base-url-redirect';
        const redirect = baseUrlRedirect(request, getNetworkConfiguration().BaseUrl);
        if (redirect !== null) { response.setHeader('Location', redirect); send(new HttpResult(302)); return; }
        phase = 'routing';
        const requestInfo = services.network?.getRequestInfo(request) ?? requestNetworkInfo(request);
        const blocked = () => services.network && !requestIsLocal(requestInfo)
          && !services.network.shouldAllowServerAccess(requestInfo.remoteEndPoint);
        const prefix = baseUrl;
        if (prefix) {
          if (path.toLowerCase() !== prefix.toLowerCase() && !path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) { send(new HttpResult(404)); return; }
          path = path.slice(prefix.length) || '/';
        }
        const applicationPath = path;
        const embyPath = /^\/(?:emby|mediabrowser)(?=\/|$)/iu.test(path);
        path = path.replace(/^\/(?:emby|mediabrowser)(?=\/|$)/iu, '') || '/';
        if (applyCors(request, response, services.configuration)) return;
        const httpsRedirect = services.networkHost?.httpsRedirect(request, requestInfo);
        if (httpsRedirect) { response.setHeader('Location', httpsRedirect); send(new HttpResult(307)); return; }
        const startupBlocked = () => {
          if (!services.networkHost || services.networkHost.coreStartupHasCompleted || applicationPath.toLowerCase() === '/system/ping') return false;
          response.writeHead(503, { 'Content-Type': 'text/html' });
          response.end(localization.text('StartupEmbyServerIsLoading'));
          return true;
        };
        if (/^\/System\/Info(?:\/Public)?\/?$/iu.test(path)) {
          response.appendHeader('Vary', 'Authorization, X-Emby-Authorization, X-Emby-Client, X-Emby-Token, X-MediaBrowser-Token');
        }
        const matching = routes.filter(route => {
          const match = route.pattern.exec(path);
          return match && route.names.every((name, index) => !route.constraints[name] || route.constraints[name](match[index + 1]));
        });
        const route = matching.find(route => route.method === request.method);
        if (!route) {
          if (blocked()) { send(new HttpResult(503)); return; }
          if (startupBlocked()) return;
          if (matching.length) response.setHeader('Allow', [...new Set(matching.map(route => route.method))].join(', '));
          send(new HttpResult(matching.length ? 405 : 404)); return;
        }
        const values = route.pattern.exec(path).slice(1);
        const params = Object.fromEntries(route.names.map((name, index) => [name, values[index]]));
        const remoteEndPoint = requestInfo.remoteEndPoint;
        let auth;
        phase = 'authentication';
        try { auth = await authentication.authenticate(request); }
        catch (error) { if (error?.status !== 401) throw error; auth = { ...authentication.read(request), IsAuthenticated: false }; }
        const embyClient = isEmbyClient({ request, auth, embyPath });
        const isPublic = typeof route.isPublic === 'function' ? route.isPublic({ request, query: url.searchParams, params }) : route.isPublic;
        if (!isPublic) {
          phase = 'authorization';
          try {
            const policy = typeof route.policy === 'function' ? route.policy({ request, auth, embyClient, url, params }) : route.policy;
            authentication.authorize(auth, { policy, remoteEndPoint, startupWizardCompleted: Boolean(services.configuration.IsStartupWizardCompleted) });
          }
          catch (error) {
            if (![401, 403].includes(error?.status)) throw error;
            if (embyClient && error.status === 401) await embyTextResponse(401, 'Access token is invalid or expired.').send(request, response);
            else send(new HttpResult(error.status));
            return;
          }
        }
        phase = 'network-access';
        if (blocked()) { send(new HttpResult(503)); return; }
        if (startupBlocked()) return;
        let body, queryInput, queryError;
        if (route.bindQuery) {
          phase = 'query-binding';
          try { queryInput = route.bindQuery(url.searchParams, params); }
          catch (error) { if (!(error instanceof BindingError)) throw error; queryError = error; }
        }
        if (route.body) {
          phase = 'body-binding';
          const abortBody = () => request.destroy();
          shutdown.signal.addEventListener('abort', abortBody, { once:true });
          try {
            shutdown.signal.throwIfAborted();
            body = await readBody(request, { allowForm: route.allowForm, optional: route.optionalBody,
              bind: route.bindBody && ((body, source) => route.bindBody(body, source, { embyClient })), objectType: route.bodyType,
              document: route.bodyDocument,
              allowTextJson: embyClient && /^json$/iu.test(queryValue(url.searchParams, 'reqformat') ?? '') });
          }
          catch (error) {
            if (route.bodyParameter && error instanceof BindingError && !error.modelValidated && !Object.hasOwn(error.errors, route.bodyParameter)) {
              error.errors[route.bodyParameter] = [`The ${route.bodyParameter} field is required.`];
            }
            if (queryError && error instanceof BindingError) error.errors = { ...queryError.errors, ...error.errors };
            throw error;
          }
          finally { shutdown.signal.removeEventListener('abort', abortBody); }
        }
        if (queryError) throw queryError;
        phase = 'action';
        const result = await route.run({ request, requestInfo, url, query: url.searchParams, queryInput, params, auth, embyPath, embyClient, remoteEndPoint, body, signal: shutdown.signal });
        if (result instanceof BinaryResult) {
          phase = 'response-stream';
          const abortStream = () => response.destroy();
          shutdown.signal.addEventListener('abort', abortStream, { once:true });
          try {
            if (shutdown.signal.aborted) abortStream();
            else await result.send(request, response);
          } finally { shutdown.signal.removeEventListener('abort', abortStream); }
        }
        else send(result);
      } catch (error) {
        if (error instanceof HttpResult) { send(error); return; }
        if (error instanceof BindingError) { send(new HttpResult(400, error.problem())); return; }
        onError(error, { request, phase });
        if (response.headersSent) { if (!response.writableEnded) response.destroy(error); return; }
        if (phase === 'base-url-redirect') { response.writeHead(500); response.end(); return; }
        response.writeHead(error?.status ?? error?.statusCode ?? 500, { 'Content-Type': 'text/plain' });
        response.end('Error processing request.');
      }
    });
    });
    } catch (error) {
      onError(error, { request, phase });
      if (!response.headersSent) { response.writeHead(500); response.end('Error processing request.'); }
      else if (!response.writableEnded) response.destroy(error);
    } finally {
      if (--activeRequests === 0) { idle?.resolve(); idle = undefined; }
    }
  };
  const webSockets = services.sessions ? createWebSocketServer({ ...services, get configuration() { return services.configuration; }, localization }) : undefined;
  return { handler, localization, webSockets, beginClose, drainRequests,
    get implementedRoutes() { return routes.map(route => `${route.method} ${route.path}`); } };
}
