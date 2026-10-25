import { parentPort, workerData } from 'node:worker_threads';
import { recordOracle } from '../../../../tools/validation/oracle.js';

try { parentPort.postMessage({ record: await recordOracle(workerData) }); }
catch (error) { parentPort.postMessage({ error: { name: error.name, message: error.message, stack: error.stack } }); }
finally { parentPort.close(); }
