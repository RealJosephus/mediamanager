import { parentPort, workerData } from 'node:worker_threads';
import { recordOracle } from '../../../../tools/validation/oracle.js';

const failureValue = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(failureValue)
  : Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, failureValue(value[key])]));
// The producer's synchronous process runs off the browser/control event loop.
try { parentPort.postMessage({ failed: false, record: await recordOracle(workerData) }); }
catch (error) { parentPort.postMessage({ failed: true, failureType: typeof error, failure: failureValue(error) }); }
finally { parentPort.close(); }
