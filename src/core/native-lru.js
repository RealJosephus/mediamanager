// Sequential TU-Q policy of BitFaster.Caching 2.6.1 FastConcurrentLru.
// See resources/native-lru-license.txt for the upstream MIT notice.
class Queue {
  values = [];
  head = 0;
  get length() { return this.values.length - this.head; }
  push(value) { this.values.push(value); }
  shift() {
    if (!this.length) return undefined;
    const value = this.values[this.head++];
    if (this.head >= 64 && this.head * 2 >= this.values.length) {
      this.values = this.values.slice(this.head); this.head = 0;
    }
    return value;
  }
  clear() { this.values = []; this.head = 0; }
}

export class NativeLruCache {
  #items = new Map();
  #hot = new Queue();
  #warm = new Queue();
  #cold = new Queue();
  #isWarm = false;

  constructor(capacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 3) throw new RangeError('Native cache capacity must be at least three.');
    this.capacity = capacity;
    const warm = Math.trunc(capacity * 0.8);
    this.hotCapacity = this.coldCapacity = Math.max(1, Math.trunc((capacity - warm) / 2));
    this.warmCapacity = capacity - this.hotCapacity - this.coldCapacity;
  }

  get size() { return this.#items.size; }
  get hotCount() { return this.#hot.length; }
  get warmCount() { return this.#warm.length; }
  get coldCount() { return this.#cold.length; }
  *entries() { for (const item of this.#items.values()) yield [item.key, item.value]; }
  get(key) {
    const item = this.#items.get(key);
    if (!item) return undefined;
    item.accessed = true; return item.value;
  }
  set(key, value) {
    const existing = this.#items.get(key);
    // Native updates change the value without marking the entry as accessed.
    if (existing) { existing.value = value; return this; }
    const item = { key, value, accessed: false, removed: false };
    this.#items.set(key, item); this.#hot.push(item); this.#cycle();
    return this;
  }
  delete(key) {
    const item = this.#items.get(key);
    if (!item) return false;
    this.#items.delete(key); item.accessed = false; item.removed = true;
    // Removed nodes remain in their queue until a later cycle.
    return true;
  }
  clear() {
    this.#items.clear(); this.#hot.clear(); this.#warm.clear(); this.#cold.clear(); this.#isWarm = false;
  }
  clone() {
    const cache = new NativeLruCache(this.capacity), copies = new Map();
    const copy = item => {
      if (!copies.has(item)) copies.set(item, { ...item });
      return copies.get(item);
    };
    for (const [source, target] of [[this.#hot, cache.#hot], [this.#warm, cache.#warm], [this.#cold, cache.#cold]]) {
      for (const item of source.values.slice(source.head)) target.push(copy(item));
    }
    for (const [key, item] of this.#items) cache.#items.set(key, copy(item));
    cache.#isWarm = this.#isWarm;
    return cache;
  }

  #move(item, destination) {
    item.accessed = false;
    if (destination === 'warm') { this.#warm.push(item); return this.warmCount; }
    if (destination === 'cold') { this.#cold.push(item); return this.coldCount; }
    if (this.#items.get(item.key) === item) this.delete(item.key);
    return 0;
  }
  #hotCycle() {
    const item = this.#hot.shift();
    if (!item) return ['remove', 0];
    const destination = item.removed ? 'remove' : item.accessed ? 'warm' : 'cold';
    return [destination, this.#move(item, destination)];
  }
  #warmCycle() {
    const item = this.#warm.shift();
    if (!item || item.removed) return ['remove', 0];
    const destination = item.accessed && this.warmCount <= this.warmCapacity ? 'warm' : 'cold';
    return [destination, this.#move(item, destination)];
  }
  #coldCycle() {
    const item = this.#cold.shift();
    if (!item) return ['cold', this.coldCount];
    const destination = item.accessed && !item.removed && this.warmCount <= this.warmCapacity ? 'warm' : 'remove';
    return [destination, this.#move(item, destination)];
  }
  #lastWarmToCold() {
    const item = this.#warm.shift();
    return item ? this.#move(item, item.removed ? 'remove' : 'cold') : 0;
  }
  #constrainCold(count) {
    if (count > this.coldCapacity) {
      const item = this.#cold.shift();
      if (item) this.#move(item, 'remove');
    }
  }
  #cycle() {
    if (!this.#isWarm) {
      if (this.hotCount <= this.hotCapacity) return;
      const item = this.#hot.shift();
      if (!item || item.removed) return;
      if (this.#move(item, 'warm') > this.warmCapacity) {
        this.#isWarm = true; this.#constrainCold(this.#lastWarmToCold());
      }
      return;
    }
    let [destination, count] = this.hotCount > this.hotCapacity ? this.#hotCycle() : ['remove', 0];
    for (let cycle = 0; cycle < 3 && destination !== 'remove'; cycle++) {
      [destination, count] = destination === 'warm'
        ? count > this.warmCapacity ? this.#warmCycle() : ['remove', 0]
        : count > this.coldCapacity ? this.#coldCycle() : ['remove', 0];
    }
    if (destination !== 'remove') {
      if (destination === 'warm' && count > this.warmCapacity) count = this.#lastWarmToCold();
      this.#constrainCold(count);
    }
  }
}
