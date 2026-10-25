import { declareFileTestResource } from './file-test-resource.js';

/** Fixed-port Native consumers enter before their unchanged business timers. */
export function declareNativeHttpTestFile({ enabled }) {
  const resource = declareFileTestResource('native-filter-http-ports', { enabled });
  return operation => context => resource.run(() => operation(context), { signal: context.signal });
}
