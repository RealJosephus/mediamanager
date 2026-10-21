/** One upstream read is shared with at most one queued chunk per consumer.
 * A paused consumer applies backpressure; no original bytes are written to disk. */
export class NativeHttpStream {
  constructor(response, closeUpstream) {
    if (!response.body) throw new TypeError('An original HTTP stream requires a response body.');
    this.reader = response.body.getReader(); this.closeUpstream = closeUpstream;
    this.consumers = new Set(); this.done = false; this.error = null; this.reading = null; this.closing = null;
    this.initialChunk = null;
  }
  async prime() {
    this.priming = true;
    try {
      while (true) {
        const result = await this.reader.read();
        if (result.done) {
          this.done = true;
          throw Object.assign(new Error('Zero bytes copied from stream SharedHttpStream'), { nativeException: 'EndOfStreamException', code: 'unexpected-eof' });
        }
        if (result.value.length) { this.initialChunk = Buffer.from(result.value); return; }
      }
    } catch (cause) { this.error = cause; this.done = true; throw cause; }
    finally { this.priming = false; }
  }
  lease(onClosed) {
    if (this.done || this.closing) throw new Error('The original HTTP input is unavailable.');
    const hub = this, state = { queued: this.initialChunk && Buffer.from(this.initialChunk), waiting: null, closed: false }; this.consumers.add(state);
    let closing;
    const close = () => closing ??= (async () => {
      state.closed = true; state.queued = null; hub.consumers.delete(state);
      state.waiting?.resolve({ done: true }); state.waiting = null;
      try { hub.pump(); }
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
    this.initialChunk = null;
    this.reading = this.reader.read().then(result => {
      this.done = result.done;
      // An already requested read can finish after its last byte consumer
      // closes. Keep that one chunk for a later reader; never read ahead.
      if (!result.done && !this.consumers.size) this.initialChunk = Buffer.from(result.value);
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
      this.done = true; this.initialChunk = null;
      for (const state of this.consumers) { state.waiting?.resolve({ done: true }); state.waiting = null; }
      const results = await Promise.allSettled([Promise.resolve().then(() => this.reader.cancel()).catch(cause => { if (cause !== this.error) throw cause; }),
        Promise.resolve().then(this.closeUpstream)]);
      if (this.reading) await this.reading;
      this.reader.releaseLock();
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'The original HTTP input failed to close.');
    })();
  }
}

/** Each acquisition owns the upstream independently of reading bytes. Only a
 * first next() registers a byte consumer and participates in backpressure. */
export class NativeHttpInput {
  constructor(open, onClosed, { primeFirstBytes = false } = {}) {
    this.controller = new AbortController(); this.states = new Set(); this.closing = null;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; onClosed(this); } };
    this.opening = Promise.resolve().then(() => { this.controller.signal.throwIfAborted(); return open(this.controller.signal); })
      .then(response => {
        this.hub = new NativeHttpStream(response, () => { this.controller.abort(); });
        if (primeFirstBytes && (this.closing || this.controller.signal.aborted)) {
          return this.hub.close().then(() => { throw this.controller.signal.reason ?? new DOMException('The original input was closed.', 'AbortError'); });
        }
        return primeFirstBytes ? this.hub.prime().then(() => this.hub, cause => { throw this.controller.signal.aborted ? this.controller.signal.reason : cause; }) : this.hub;
      });
    this.finish = finish;
    void this.opening.catch(() => {
      this.controller.abort();
      if (this.hub) void this.close().catch(() => {});
      else finish();
    });
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
        if (hub.done || hub.closing) throw new Error('The original HTTP input is unavailable.');
        let reading = false;
        const stream = { [Symbol.asyncIterator]() { return this; }, async next() {
          if (state.closed) return { done: true };
          if (reading) throw new Error('A live stream lease supports one pending read.');
          reading = true;
          try {
            if (hub.error) throw hub.error;
            if (hub.done) { await close(); return { done: true }; }
            state.lease ??= hub.lease(() => {});
            const result = await state.lease.stream.next();
            if (result.done) await close();
            return result;
          } catch (cause) {
            try { await close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], cause.message, { cause }); }
            throw cause;
          } finally { reading = false; }
        }, async return(value) { await close(); return { done: true, value }; } };
        state.completion.resolve({ stream, close });
      } catch (error) { state.completion.reject(error); void close().catch(() => {}); }
    }, error => { state.completion.reject(error); void close().catch(() => {}); });
    return state.completion.promise;
  }
  get enabled() { return !this.closing && !this.controller.signal.aborted && !!this.hub && !this.hub.done && !this.hub.closing && this.states.size > 0; }
  close() {
    if (this.closing) return this.closing;
    // An opened reader owns shutdown: cancel it before aborting its fetch.
    // Aborting first can turn a normal concurrent lease close into AbortError.
    if (!this.hub) this.controller.abort();
    else if (this.hub.priming) void this.hub.close().catch(() => {});
    return this.closing = Promise.resolve().then(async () => {
      let hub; try { hub = await this.opening; } catch { /* Open failures have no delivered upstream owner. */ }
      hub ??= this.hub;
      for (const state of this.states) state.completion.reject(this.controller.signal.reason);
      const results = await Promise.allSettled([...this.states].map(state => state.close()).concat(hub ? [hub.close()] : []));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'The original HTTP input failed to drain.');
    }).finally(this.finish);
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
