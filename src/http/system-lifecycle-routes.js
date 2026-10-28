import { finished } from 'node:stream/promises';
import { BinaryResult } from './binary-result.js';
import { httpError } from './binding.js';
import { requestNetworkInfo } from '../network/http-request.js';
import { isDefaultLocalNetwork } from '../users/network.js';

export function registerSystemLifecycleRoutes(add, services) {
  const local = ({ request }) => {
    const info = services.network?.getRequestInfo(request) ?? requestNetworkInfo(request);
    return info.remoteEndPoint == null || (services.network
      ? services.network.isInLocalNetwork(info.remoteEndPoint)
      : (services.authentication?.isLocalNetwork ?? isDefaultLocalNetwork)(info.remoteEndPoint));
  };
  for (const [path, action] of [['Restart', 'restart'], ['Shutdown', 'shutdown']]) {
    add('POST', '/System/' + path, () => {
      if (!services.systemLifecycle) throw httpError(503, 'The application has no lifecycle owner.');
      const reservation = services.systemLifecycle.admit(action);
      return new BinaryResult(async (_request, response) => {
        try {
          const completed = finished(response, { cleanup: true });
          response.statusCode = 204; response.end();
          await completed;
          reservation.commit();
        } finally { reservation.cancel(); }
      });
    }, { policy: 'RequiresElevation', ...(action === 'restart' && { public: local }) });
  }
}
