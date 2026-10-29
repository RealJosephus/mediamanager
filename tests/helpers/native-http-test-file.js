import { declareFileTestResource } from './file-test-resource.js';

/** Admit the actual HTTP port before business timers and retain it through file cleanup. */
export function declareNativeHttpTestFile({ enabled, port = 19000 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError('A Native HTTP file requires a valid loopback port.');
  const resource = declareFileTestResource(port === 19000 ? 'native-filter-http-ports' : `native-http-${port}`, { enabled });
  return operation => context => resource.run(() => operation(context, port), { signal: context.signal });
}
