// Sequential TU-Q adaptation of BitFaster.Caching 2.6.1 (MIT, Alex Peck).
// See bounded-item-cache.LICENSE. Queue maintenance occurs only on insertion;
// this cache is bounded transient entity state, never a catalogue/query index.
class Queue {
  #head;
  #tail;
  size = 0;
  push(value) {
    const node = { value, next: undefined };
    if (this.#tail) this.#tail.next = node;
    else this.#head = node;
    this.#tail = node;
    this.size += 1;
  }
  shift() {
    const node = this.#head;
    if (!node) return undefined;
    this.#head = node.next;
    if (!this.#head) this.#tail = undefined;
    this.size -= 1;
    return node.value;
  }
}

export class BoundedItemCache {
  #items = new Map();
  #hot = new Queue();
  #warm = new Queue();
  #cold = new Queue();
  #warmed = false;
  #partition;

  constructor(capacity, { onRemove = () => {} } = {}) {
    this.onRemove = onRemove;
    if (!Number.isInteger(capacity) || capacity < 3 || capacity > 2147483647) {
      throw new RangeError('Capacity must be greater than or equal to 3.');
    }
    const warm = Math.trunc(capacity * 0.8), hot = Math.max(1, Math.trunc((capacity - warm) / 2));
    Object.defineProperty(this, 'capacity', { value: capacity, enumerable: true });
    this.#partition = { hot, warm: capacity - 2 * hot, cold: hot };
  }

  get size() { return this.#items.size; }
  get queueCounts() { return { hot: this.#hot.size, warm: this.#warm.size, cold: this.#cold.size }; }
  peek(key) { return this.#items.get(key)?.value; }
  get(key) {
    const entry = this.#items.get(key);
    if (entry) { entry.accessed = true; return entry.value; }
    return undefined;
  }
  set(key, value) {
    const existing = this.#items.get(key);
    // AddOrUpdate replaces the value without changing the access bit/order.
    if (existing) { if (existing.value !== value) this.onRemove(existing.value); existing.value = value; return this; }
    const entry = { key, value, accessed: false, removed: false };
    this.#items.set(key, entry);
    this.#hot.push(entry);
    this.#cycle();
    return this;
  }
  delete(key) {
    const entry = this.#items.get(key);
    if (!entry) return false;
    this.#items.delete(key);
    this.onRemove(entry.value);
    entry.removed = true; entry.accessed = false;
    return true;
  }
  clear() {
    for (const entry of this.#items.values()) this.onRemove(entry.value);
    this.#items.clear();
    this.#hot = new Queue(); this.#warm = new Queue(); this.#cold = new Queue();
    this.#warmed = false;
  }
  *[Symbol.iterator]() { for (const [key, entry] of this.#items) yield [key, entry.value]; }

  #move(entry, destination) {
    entry.accessed = false;
    if (destination === 'warm') { this.#warm.push(entry); return ['warm', this.#warm.size]; }
    if (destination === 'cold') { this.#cold.push(entry); return ['cold', this.#cold.size]; }
    if (this.#items.get(entry.key) === entry) this.delete(entry.key);
    return ['remove', 0];
  }
  #warmToCold() {
    const entry = this.#warm.shift();
    return entry ? this.#move(entry, entry.removed ? 'remove' : 'cold')[1] : 0;
  }
  #constrainCold(count) {
    if (count > this.#partition.cold) {
      const entry = this.#cold.shift();
      if (entry) this.#move(entry, 'remove');
    }
  }
  #cycleHot() {
    if (this.#hot.size <= this.#partition.hot) return ['remove', 0];
    const entry = this.#hot.shift();
    return entry ? this.#move(entry, entry.removed ? 'remove' : entry.accessed ? 'warm' : 'cold') : ['remove', 0];
  }
  #cycleWarm(count) {
    if (count <= this.#partition.warm) return ['remove', 0];
    const entry = this.#warm.shift();
    if (!entry || entry.removed) return ['remove', 0];
    return this.#move(entry, entry.accessed && this.#warm.size <= this.#partition.warm ? 'warm' : 'cold');
  }
  #cycleCold(count) {
    if (count <= this.#partition.cold) return ['remove', 0];
    const entry = this.#cold.shift();
    if (!entry) return ['cold', this.#cold.size];
    return this.#move(entry, entry.accessed && !entry.removed && this.#warm.size <= this.#partition.warm ? 'warm' : 'remove');
  }
  #cycle() {
    if (!this.#warmed) {
      if (this.#hot.size <= this.#partition.hot) return;
      const entry = this.#hot.shift();
      if (!entry || entry.removed) return;
      const [, count] = this.#move(entry, 'warm');
      if (count > this.#partition.warm) {
        this.#warmed = true;
        this.#constrainCold(this.#warmToCold());
      }
      return;
    }
    let [destination, count] = this.#cycleHot();
    for (let cycle = 0; cycle < 3 && destination !== 'remove'; cycle += 1) {
      [destination, count] = destination === 'warm' ? this.#cycleWarm(count) : this.#cycleCold(count);
    }
    if (destination !== 'remove') {
      if (destination === 'warm' && count > this.#partition.warm) count = this.#warmToCold();
      this.#constrainCold(count);
    }
  }
}
