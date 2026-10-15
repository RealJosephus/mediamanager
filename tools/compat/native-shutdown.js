import { once } from 'node:events';

/** Reclaim an owned oracle process; forced or unsuccessful shutdown never verifies a write barrier. */
export async function stopNativeReference(child, requestShutdown, record, { timeoutMilliseconds = 10000 } = {}) {
  let shutdownStatus = null, forced = false, failure;
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit');
    ended.catch(() => {});
    try { shutdownStatus = await requestShutdown(); } catch (error) { failure = error; }
    const timeout = setTimeout(() => { forced = true; child.kill(); }, timeoutMilliseconds);
    timeout.unref();
    try { await ended; } catch (error) { failure ??= error; }
    finally { clearTimeout(timeout); }
  }
  const outcome = { pid: child.pid, shutdownStatus, forced, exitCode: child.exitCode, signalCode: child.signalCode,
    stopped: child.exitCode !== null || child.signalCode !== null };
  await record(outcome);
  if (failure || shutdownStatus !== 204 || forced || child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error('Native reference did not complete an HTTP 204 shutdown with exit code 0.', { cause: failure });
  }
  return outcome;
}
