import assert from 'node:assert/strict';
import { PostgresDatabase } from '../../src/database/postgres.js';
import { discoverInstanceState } from '../../src/migration/instance-state.js';
import { createIsolatedOfflineCopyCaptureSession } from '../../src/migration/capture-session.js';
import { createStatePackage, restoreStatePackage } from '../../src/migration/state-package.js';

const [mode, instanceRoot, packageDirectory, destination, baseline] = process.argv.slice(2);
const notify = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
async function pause(message) {
  await notify(message);
  // Keep the actual operation suspended at its public callback boundary until
  // the parent kills this process. Parent loss also releases this owned child.
  await new Promise((_, reject) => process.once('disconnect', () => reject(new Error('Recovery test parent disconnected.'))));
}

let database;
try {
  if (mode === 'capture' || mode === 'capture-interrupted') {
    database = await PostgresDatabase.open({ connectionString: process.env.MEDIAMANAGER_TEST_POSTGRES,
      schema: process.env.MM_STATE_PROCESS_SCHEMA });
    const instanceState = await discoverInstanceState({ instanceRoot });
    const captureSession = createIsolatedOfflineCopyCaptureSession({ instanceState,
      ownerId: 'current-native-process-recovery', assertHeld: async phase => {
        assert.equal((await discoverInstanceState({ instanceRoot })).identity.digest, instanceState.identity.digest);
        if (phase === 'post' && mode === 'capture-interrupted') await pause({ event: 'capture-durable', pid: process.pid });
      } });
    const manifest = await createStatePackage({ database, instanceState, captureSession, baseline, destination: packageDirectory });
    await notify({ event: 'complete', generation: manifest.generation, pid: process.pid });
  } else {
    assert.ok(['restore', 'restore-interrupted', 'restore-preparation-interrupted'].includes(mode));
    let latestPreparation;
    const result = await restoreStatePackage(packageDirectory, destination, {
      onPreparation: async preparation => {
        latestPreparation = preparation;
        if (mode === 'restore-preparation-interrupted' && preparation.stage === 'database-opened') {
          await pause({ event: 'restore-preparation-durable', pid: process.pid, preparation });
        }
      },
      onProgress: async progress => {
        if (mode === 'restore-interrupted' && progress.completed === 1) await pause({ event: 'restore-durable', pid: process.pid, progress,
          preparation: latestPreparation });
      }
    });
    await notify({ event: 'complete', resumed: result.resumed, alreadyRestored: result.alreadyRestored,
      reusedFiles: result.reusedFiles, generation: result.manifest.generation, pid: process.pid,
      databaseProjection: result.databaseProjection, preparationRecovery: result.preparationRecovery });
  }
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
} finally {
  await database?.close();
  if (process.connected) process.disconnect();
}
