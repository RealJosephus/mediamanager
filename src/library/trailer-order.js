import { readNativeTrailerRows } from '../database/native-relation-order.js';

export function readItemTrailerRows(db, itemId) {
  return readNativeTrailerRows(db, [itemId]);
}
