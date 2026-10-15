import { readNativeImageRows } from '../database/native-relation-order.js';

export function readItemImageRows(db, itemId) {
  return readNativeImageRows(db, [itemId]);
}
