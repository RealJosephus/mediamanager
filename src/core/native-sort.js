// Sort stable original indices using the native comparison call order. A
// path-dependent or overflowing comparer can make that order observable.
export function sortNative(items, comparer) {
  if (items.length < 2) return items;
  const original = [...items];
  const indices = original.map((_, index) => index);
  const compare = (a, b) => comparer(original[a], original[b]) || a - b;
  const swap = (a, b) => { [indices[a], indices[b]] = [indices[b], indices[a]]; };
  const orderPair = (a, b) => { if (compare(indices[a], indices[b]) > 0) swap(a, b); };
  const sift = (offset, parent, length) => {
    const value = indices[offset + parent - 1];
    while (parent <= (length >> 1)) {
      let child = parent * 2;
      if (child < length && compare(indices[offset + child - 1], indices[offset + child]) < 0) child++;
      if (compare(value, indices[offset + child - 1]) >= 0) break;
      indices[offset + parent - 1] = indices[offset + child - 1];
      parent = child;
    }
    indices[offset + parent - 1] = value;
  };
  const heap = (offset, length) => {
    for (let parent = length >> 1; parent >= 1; parent--) sift(offset, parent, length);
    for (let count = length; count > 1; count--) {
      swap(offset, offset + count - 1);
      sift(offset, 1, count - 1);
    }
  };
  const insert = (offset, length) => {
    for (let index = offset + 1; index < offset + length; index++) {
      const value = indices[index];
      let previous = index - 1;
      while (previous >= offset && compare(value, indices[previous]) < 0) {
        indices[previous + 1] = indices[previous];
        previous--;
      }
      indices[previous + 1] = value;
    }
  };
  const partition = (offset, length) => {
    const end = offset + length - 1;
    const middle = offset + ((length - 1) >> 1);
    orderPair(offset, middle); orderPair(offset, end); orderPair(middle, end);
    const pivot = indices[middle];
    swap(middle, end - 1);
    let left = offset, right = end - 1;
    while (left < right) {
      do {
        if (++left > end) throw new RangeError('Native sort comparison is inconsistent.');
      } while (compare(indices[left], pivot) < 0);
      do {
        if (--right < offset) throw new RangeError('Native sort comparison is inconsistent.');
      } while (compare(pivot, indices[right]) < 0);
      if (left >= right) break;
      swap(left, right);
    }
    if (left !== end - 1) swap(left, end - 1);
    return left - offset;
  };
  const intro = (offset, length, depth) => {
    while (length > 1) {
      if (length <= 16) {
        if (length === 2) orderPair(offset, offset + 1);
        else if (length === 3) {
          orderPair(offset, offset + 1); orderPair(offset, offset + 2); orderPair(offset + 1, offset + 2);
        } else insert(offset, length);
        return;
      }
      if (depth === 0) { heap(offset, length); return; }
      depth--;
      const pivot = partition(offset, length);
      intro(offset + pivot + 1, length - pivot - 1, depth);
      length = pivot;
    }
  };
  intro(0, items.length, 2 * (Math.floor(Math.log2(items.length)) + 1));
  for (let index = 0; index < items.length; index++) items[index] = original[indices[index]];
  return items;
}
