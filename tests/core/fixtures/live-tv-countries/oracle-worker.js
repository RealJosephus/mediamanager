import { parentPort, workerData } from 'node:worker_threads';
import { recordOracle } from '../../../../tools/validation/oracle.js';
try { parentPort.postMessage({ ok: true, record: await recordOracle(workerData) }); }
catch (error) { parentPort.postMessage({ ok: false, error: { name: error.name, message: error.message, stack: error.stack } }); }
finally { parentPort.close(); }
