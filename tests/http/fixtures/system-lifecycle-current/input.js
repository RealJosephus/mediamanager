export const userId = 'cf790000000000000000000000000001';
export function makeInput() {
  const requests = [];
  const add = (action, identity, remote, expectedStatus, options = {}) => requests.push({
    name: [action, identity, remote, options.name].filter(Boolean).join('-'),
    path: '/System/' + action, method: 'POST', identity, remote, expectedStatus, ...options,
  });
  for (const action of ['Restart', 'Shutdown']) {
    for (const identity of ['anonymous', 'invalid', 'regular', 'admin', 'apiKey']) {
      add(action, identity, '127.0.0.1', action === 'Restart' || ['admin', 'apiKey'].includes(identity) ? 204 : identity === 'regular' ? 403 : 401);
      add(action, identity, '203.0.113.10', ['admin', 'apiKey'].includes(identity) ? 204 : identity === 'regular' ? 403 : 401);
    }
    add(action, 'regular', '10.44.0.3', action === 'Restart' ? 204 : 403);
    add(action, 'anonymous', '10.44.0.3', action === 'Restart' ? 204 : 401);
    add(action, 'admin', '203.0.113.10', 204, { name: 'unbound-json-body', body: '{bad', contentType: 'application/json' });
    add(action, 'admin', '203.0.113.10', 204, { name: 'unbound-content-type', body: 'unused', contentType: 'application/octet-stream' });
    add(action, 'anonymous', '203.0.113.10', 405, { name: 'wrong-method', method: 'GET' });
  }
  return { userId, localNetworks: ['127.0.0.0/8', '10.44.0.0/24'], requests };
}
