/** One upstream read is shared with at most one queued chunk per consumer.
 * A paused consumer applies backpressure; no original bytes are written to disk. */
export class NativeHttpStream {
  constructor(response, closeUpstream) {
    if (!response.body) throw new TypeError('An original HTTP stream requires a response body.');
    this.reader = response.body.getReader(); this.closeUpstream = closeUpstream;
    this.consumers = new Set(); this.done = false; this.error = null; this.reading = null; this.closing = null;
  }
  lease(onClosed) {
    if (this.done || this.closing) throw new Error('The original HTTP input is unavailable.');
    const hub = this, state = { queued: null, waiting: null, closed: false }; this.consumers.add(state);
    let closing;
    const close = () => closing ??= (async () => {
      state.closed = true; state.queued = null; hub.consumers.delete(state);
      state.waiting?.resolve({ done: true }); state.waiting = null;
      try { if (!hub.consumers.size) await hub.close(); else hub.pump(); }
      finally { onClosed(); }
    })();
    return { stream: { [Symbol.asyncIterator]() { return this; },
      next() {
        if (state.closed) return Promise.resolve({ done: true });
        if (state.queued) { const value = state.queued; state.queued = null; hub.pump(); return Promise.resolve({ done: false, value }); }
        if (hub.error) return Promise.reject(hub.error);
        if (hub.done) return Promise.resolve({ done: true });
        if (state.waiting) return Promise.reject(new Error('A live stream lease supports one pending read.'));
        const completion = state.waiting = Promise.withResolvers(); hub.pump(); return completion.promise;
      },
      return: async () => { await close(); return { done: true }; },
    }, close };
  }
  pump() {
    if (this.reading || this.done || this.closing || !this.consumers.size
      || ![...this.consumers].some(state => state.waiting) || [...this.consumers].some(state => state.queued)) return;
    this.reading = this.reader.read().then(result => {
      this.done = result.done;
      for (const state of this.consumers) {
        const value = result.done ? result : { done: false, value: Buffer.from(result.value) };
        if (state.waiting) { state.waiting.resolve(value); state.waiting = null; }
        else if (!result.done) state.queued = value.value;
      }
    }, error => {
      this.error = error; this.done = true;
      for (const state of this.consumers) { state.waiting?.reject(error); state.waiting = null; }
    }).finally(() => { this.reading = null; this.pump(); });
  }
  close() {
    return this.closing ??= (async () => {
      this.done = true;
      for (const state of this.consumers) { state.waiting?.resolve({ done: true }); state.waiting = null; }
      const results = await Promise.allSettled([Promise.resolve().then(() => this.reader.cancel()),
        Promise.resolve().then(this.closeUpstream)]);
      if (this.reading) await this.reading;
      this.reader.releaseLock();
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'The original HTTP input failed to close.');
    })();
  }
}

/** Waiting opens and delivered leases share one upstream owner. One caller's
 * cancellation never aborts another consumer of that original source. */
export class NativeHttpInput {
  constructor(open, onClosed) {
    this.controller = new AbortController(); this.states = new Set(); this.closing = null;
    this.opening = Promise.resolve().then(() => { this.controller.signal.throwIfAborted(); return open(this.controller.signal); })
      .then(response => this.hub = new NativeHttpStream(response, () => { this.controller.abort(); onClosed(this); }));
    void this.opening.catch(() => { this.controller.abort(); onClosed(this); });
  }
  acquire(signal) {
    if (this.closing || this.hub?.closing || this.hub?.done) return Promise.reject(new Error('The original HTTP source is closing.'));
    const state = { completion: Promise.withResolvers(), lease: null, closed: false }; this.states.add(state);
    let closing;
    const abort = () => { state.completion.reject(signal.reason); void close().catch(() => {}); };
    const close = () => closing ??= (async () => {
      state.closed = true; this.states.delete(state); signal.removeEventListener('abort', abort);
      try { await state.lease?.close(); }
      finally { if (!this.states.size && !this.closing) await this.close(); }
    })();
    state.close = close;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.opening.then(hub => {
      if (state.closed) return;
      try {
        state.lease = hub.lease(() => {});
        state.completion.resolve({ stream: state.lease.stream, close });
      } catch (error) { state.completion.reject(error); void close().catch(() => {}); }
    }, error => { state.completion.reject(error); void close().catch(() => {}); });
    return state.completion.promise;
  }
  get enabled() { return !this.closing && !this.controller.signal.aborted && !!this.hub && !this.hub.done && !this.hub.closing && this.states.size > 0; }
  close() {
    if (this.closing) return this.closing;
    this.controller.abort();
    return this.closing = Promise.resolve().then(async () => {
      let hub; try { hub = await this.opening; } catch { /* Open failures have no delivered upstream owner. */ }
      for (const state of this.states) state.completion.reject(this.controller.signal.reason);
      const results = await Promise.allSettled([...this.states].map(state => state.close()).concat(hub ? [hub.close()] : []));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'The original HTTP input failed to drain.');
    });
  }
}

/** Native LiveStream.Open for URL protocols is a descriptor/reservation only.
 * Retaining that descriptor reserves no second tuner and never opens a socket. */
export class NativeReservationInput {
  constructor(onClosed) { this.onClosed = onClosed; this.states = new Set(); this.closing = null; }
  get enabled() { return !this.closing && this.states.size > 0; }
  acquire(signal) {
    signal.throwIfAborted();
    if (this.closing) throw new Error('The tuner reservation is closing.');
    let closing;
    const close = () => closing ??= Promise.resolve().then(async () => {
      this.states.delete(close); signal.removeEventListener('abort', aborted);
      if (!this.states.size && !this.closing) await this.close();
    });
    const aborted = () => { void close().catch(() => {}); };
    this.states.add(close); signal.addEventListener('abort', aborted, { once: true });
    return { close };
  }
  close() {
    return this.closing ??= Promise.resolve().then(async () => {
      try { await Promise.all([...this.states].map(close => close())); }
      finally { this.onClosed(this); }
    });
  }
}
