import { randomUUID, randomInt } from 'node:crypto';
import { utcTicks, formatUtcTicks } from './time.js';

export const emptyGuid = '00000000000000000000000000000000';
export const newGuid = () => randomUUID().replaceAll('-', '');
export const guidKey = value => String(value).replaceAll('-', '').toLowerCase();

export class SyncPlayQueue {
  constructor({ clock = utcTicks, createId = newGuid, choose = randomInt } = {}) {
    Object.assign(this, { clock, createId, choose });
    this.reset();
  }
  get playlist() { return this.shuffleMode === 'Shuffle' ? this.shuffled : this.sorted; }
  get current() { return this.playlist[this.index] ?? null; }
  get currentId() { return this.current?.PlaylistItemId ?? emptyGuid; }
  get itemId() { return this.current?.ItemId ?? emptyGuid; }
  get isPlaying() { return this.index !== -1; }
  changed() { this.lastChange = formatUtcTicks(this.clock()); }
  reset() {
    this.sorted = [];
    this.shuffled = [];
    this.index = -1;
    this.shuffleMode = 'Sorted';
    this.repeatMode = 'RepeatNone';
    this.changed();
  }
  createItems(ids) { return ids.map(id => ({ ItemId: guidKey(id), PlaylistItemId: this.createId() })); }
  shuffle(items) {
    for (let remaining = items.length; remaining > 1; remaining--) {
      const index = this.choose(remaining);
      [items[index], items[remaining - 1]] = [items[remaining - 1], items[index]];
    }
  }
  setPlaylist(ids) {
    this.sorted = this.createItems(ids);
    this.shuffled = [];
    if (this.shuffleMode === 'Shuffle') { this.shuffled = [...this.sorted]; this.shuffle(this.shuffled); }
    this.index = -1;
    this.changed();
  }
  setIndex(index) {
    this.index = index >= 0 && index < this.playlist.length ? index : -1;
    this.changed();
  }
  setItem(id, field = 'PlaylistItemId') {
    this.index = this.playlist.findIndex(item => item[field] === guidKey(id));
    this.changed();
    return this.index !== -1;
  }
  append(ids, next = false) {
    const items = this.createItems(ids);
    if (next) {
      const sortedIndex = this.shuffleMode === 'Shuffle' ? this.sorted.indexOf(this.current) : this.index;
      this.sorted.splice(sortedIndex + 1, 0, ...items);
      if (this.shuffleMode === 'Shuffle') this.shuffled.splice(this.index + 1, 0, ...items);
    } else {
      this.sorted.push(...items);
      if (this.shuffleMode === 'Shuffle') this.shuffled.push(...items);
    }
    this.changed();
  }
  clear(clearPlayingItem) {
    const current = this.current;
    this.sorted = [];
    this.shuffled = [];
    if (!clearPlayingItem && current) {
      this.sorted.push(current);
      if (this.shuffleMode === 'Shuffle') this.shuffled.push(current);
      this.index = 0;
    } else this.index = -1;
    this.changed();
  }
  remove(ids) {
    const keys = new Set(ids.map(guidKey));
    const current = this.current;
    const preceding = current ? this.playlist.slice(0, this.index).filter(item => keys.has(item.PlaylistItemId)).length : 0;
    this.sorted = this.sorted.filter(item => !keys.has(item.PlaylistItemId));
    this.shuffled = this.shuffled.filter(item => !keys.has(item.PlaylistItemId));
    this.changed();
    if (!current) return false;
    if (keys.has(current.PlaylistItemId)) {
      this.index -= preceding + 1;
      if (this.index < 0) this.index = this.playlist.length ? 0 : -1;
      return true;
    }
    this.setItem(current.PlaylistItemId);
    return false;
  }
  move(id, index) {
    const playlist = this.playlist;
    const oldIndex = playlist.findIndex(item => item.PlaylistItemId === guidKey(id));
    if (oldIndex < 0) return false;
    const current = this.current;
    const [item] = playlist.splice(oldIndex, 1);
    playlist.splice(Math.max(0, Math.min(index, playlist.length)), 0, item);
    this.index = playlist.indexOf(current);
    this.changed();
    return true;
  }
  setRepeat(mode) { this.repeatMode = mode; this.changed(); }
  setShuffle(mode) {
    if (mode === 'Shuffle') {
      const current = this.current;
      this.shuffled = this.isPlaying && this.shuffleMode === 'Shuffle' ? [...this.shuffled] : [...this.sorted];
      if (current) this.shuffled.splice(this.shuffled.indexOf(current), 1);
      this.shuffle(this.shuffled);
      if (current) { this.shuffled.unshift(current); this.index = 0; }
      this.shuffleMode = 'Shuffle';
    } else {
      if (this.isPlaying && this.shuffled.length) this.index = this.sorted.indexOf(this.shuffled[this.index]);
      this.shuffled = [];
      this.shuffleMode = 'Sorted';
    }
    this.changed();
  }
  advance(direction) {
    if (!this.playlist.length) return false;
    if (this.repeatMode === 'RepeatOne') { this.changed(); return true; }
    this.index += direction;
    if (this.index < 0 || this.index >= this.sorted.length) {
      if (this.repeatMode === 'RepeatAll') this.index = this.index < 0 ? this.sorted.length - 1 : 0;
      else { this.index = direction < 0 ? 0 : this.sorted.length - 1; return false; }
    }
    this.changed();
    return true;
  }
}
