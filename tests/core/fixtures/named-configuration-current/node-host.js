import { NamedConfigurationStore } from '../../../../src/core/named-configuration-store.js';
import { defaultConfiguration } from '../../../../src/core/configuration-xml.js';
import { AuthenticationService } from '../../../../src/users/authentication-service.js';
import { createTestApplication } from '../../../helpers/application.js';

// Only credential resolution is supplied by the fixture. Routing, authorization,
// typed body binding, output formatting and persistence use the application.
export async function namedComponentHost({ configurationDirectoryPath, onError, onFailure, fileSystem }) {
  const store = new NamedConfigurationStore({ configurationDirectoryPath, onError, ...(fileSystem && { fileSystem }) });
  const authentication = new AuthenticationService({ store: {}, users: {}, serverId: 'named-component', isLocalNetwork: () => true });
  authentication.authenticate = async request => {
    const identity = request.headers['x-identity'] ?? 'admin';
    const authenticated = !['anonymous', 'invalid'].includes(identity);
    return { IsAuthenticated: authenticated, IsAdministrator: authenticated && identity !== 'regular', IsApiKey: identity === 'apiKey',
      UserId: 'f82b0000000000000000000000000001', User: { Id: 'f82b0000000000000000000000000001',
        Policy: { EnableRemoteAccess: true, IsAdministrator: false }, AccessSchedules: [] } };
  };
  const application = await createTestApplication({
    configuration: { ...defaultConfiguration('server'), IsStartupWizardCompleted: true }, authentication, namedConfiguration: store,
    onError(error, { request, phase }) {
      onFailure?.({ method: request.method, url: request.url, phase, error });
      onError(error);
    },
  });
  return { store, server: application.server, async close() {
    application.beginClose();
    await application.drainRequests();
    try { if (application.server.listening) await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve())); }
    finally { await store.close(); }
  } };
}
