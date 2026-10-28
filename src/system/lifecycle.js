const unavailable = () => Object.assign(new Error('The application lifecycle is closing.'), { status: 503, code: 'closed' });

function failure(reasons) {
  if (reasons.length === 1) return reasons[0];
  const primary = reasons[0]; let message = 'Application startup and shutdown failed.';
  try { const value = primary?.message; if (typeof value === 'string') message = value; } catch { /* Preserve the actual failure. */ }
  const result = new AggregateError(reasons, message, { cause: primary });
  for (const name of ['code', 'status', 'statusCode']) {
    try { if (primary != null && Object.hasOwn(primary, name)) result[name] = primary[name]; } catch { /* Diagnostic getters cannot replace it. */ }
  }
  return result;
}

/** Owns the actual application factory and every close before a replacement.
 * HTTP reserves an action before sending its response and commits it only
 * after that response finishes. Existing reservations belong to their original
 * application, so a late response cannot restart a replacement application. */
export class SystemLifecycle {
  #start;
  #onReady;
  #running;
  #next;
  #current;
  #currentClose;
  #accepting = false;
  #shutdown = false;

  constructor({ start, onReady = () => {} }) {
    if (typeof start !== 'function' || typeof onReady !== 'function') throw new TypeError('Application lifecycle requires an application factory and ready callback.');
    this.#start = start; this.#onReady = onReady;
  }

  admit(action) {
    if (!['restart', 'shutdown'].includes(action)) throw new TypeError('An application restart or shutdown is required.');
    if (!this.#accepting) throw unavailable();
    const next = this.#next, owner = this; let completed = false;
    return Object.freeze({ commit() {
      if (completed) return;
      completed = true;
      if (action === 'shutdown') void owner.close().catch(() => {});
      else next.resolve(action);
    }, cancel() { completed = true; } });
  }

  #closeCurrent() {
    if (!this.#current) return Promise.resolve();
    return this.#currentClose ??= Promise.resolve().then(() => this.#current.close());
  }

  run() {
    return this.#running ??= Promise.resolve().then(async () => {
      try {
        while (!this.#shutdown) {
          this.#next = Promise.withResolvers(); this.#accepting = true; this.#currentClose = undefined;
          let primary, failed = false, action;
          try {
            const application = await this.#start({ systemLifecycle: this, onApplication: owner => {
              if (!owner || typeof owner.close !== 'function') throw new TypeError('The application factory must publish its real close owner.');
              this.#current = owner;
              if (this.#shutdown) void this.#closeCurrent().catch(() => {});
            } });
            if (!application || typeof application.close !== 'function') throw new TypeError('The application factory must return its real close owner.');
            this.#current = application;
            if (!this.#shutdown) await this.#onReady(application);
            action = this.#shutdown ? 'shutdown' : await this.#next.promise;
          } catch (error) { primary = error; failed = true; }
          this.#accepting = false;
          try { await this.#closeCurrent(); }
          catch (error) { throw failure(failed ? [primary, error] : [error]); }
          finally { this.#current = undefined; this.#currentClose = undefined; }
          if (failed) throw primary;
          if (action !== 'restart') break;
        }
      } finally { this.#accepting = false; this.#shutdown = true; }
    });
  }

  close() {
    this.#shutdown = true; this.#accepting = false; this.#next?.resolve('shutdown');
    // A factory may already own a runtime while startup is still waiting for
    // an encoder or listener. Its real close cancels and drains that startup.
    void this.#closeCurrent().catch(() => {});
    return this.#running ?? Promise.resolve();
  }
}
