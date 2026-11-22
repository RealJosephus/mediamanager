// Keep the lit pixels only when they form several separate, text-like rows on
// a dark field. A fade, a static title card or a single line of subtitles is
// insufficient to identify credits.
function textFrame(pixels, width, height) {
  const words = width / 32;
  const mask = new Uint32Array(words * height);
  const counts = new Uint16Array(height);
  let lit = 0,
    dark = 0,
    bands = 0,
    inBand = false;
  for (let y = 0; y < height; y++) {
    let length = 0,
      strokes = 0;
    for (let x = 0; x < width; x++) {
      const luma = pixels[y * width + x];
      if (luma < 64) dark++;
      if (luma >= 140) {
        length++;
        mask[y * words + (x >>> 5)] |= 1 << (x & 31);
        counts[y]++;
      } else {
        if (length > 0 && length <= 12) strokes++;
        length = 0;
      }
    }
    lit += counts[y];
    const text = strokes >= 3 && counts[y] >= 6;
    if (text && !inBand) bands++;
    inBand = text || (inBand && counts[y] >= 3);
  }
  const area = width * height;
  return dark >= area * 0.76 && lit >= area * 0.009 && lit <= area * 0.22 && bands >= 4
    ? { mask, counts }
    : null;
}

function bitCount(word) {
  word -= (word >>> 1) & 0x55555555;
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
  return (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Compare shifts in both directions and at rest over the same part of the
// frame. Requiring an upward shift to beat both alternatives rejects still
// text and cuts between successive captions.
function upwardShift(before, after, words, height) {
  if (!before || !after) return 0;
  const reach = Math.floor(height / 8);
  let upward = 0,
    alternative = 0,
    best = 0;
  for (let dy = -reach; dy <= reach; dy++) {
    let common = 0,
      total = 0;
    for (let y = reach; y < height - reach; y++) {
      total += before.counts[y + dy] + after.counts[y];
      for (let x = 0; x < words; x++)
        common += bitCount(before.mask[(y + dy) * words + x] & after.mask[y * words + x]);
    }
    const score = (2 * common) / Math.max(1, total);
    if (dy <= 0) alternative = Math.max(alternative, score);
    else if (score > upward) {
      upward = score;
      best = dy;
    }
  }
  return upward >= 0.58 && upward - alternative >= 0.1 ? best : 0;
}

export function rollingCredits({ pixels, width, height, fps }, windowStart, runtime) {
  const size = width * height,
    count = pixels.length / size;
  const ranges = [],
    history = [];
  let first = -1,
    last = -1,
    speeds = [];
  function finish() {
    if (first < 0) return;
    const duration = (last - first) / fps;
    if (duration >= 20 && speeds.length >= (last - first - fps + 1) * 0.85) {
      const sorted = speeds.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (sorted.filter((speed) => Math.abs(speed - median) <= 2).length >= sorted.length * 0.85) {
        const ticks = (index) => BigInt(Math.round((windowStart + index / fps) * 1e7));
        // The last decoded sample covers the fractional final frame. A scene
        // following the roll keeps its own playback time, including at EOF.
        const reachesEnd = last === count - 1 && ticks(count) >= runtime;
        ranges.push({ Type: 4, StartTicks: ticks(first), EndTicks: reachesEnd ? runtime : ticks(last) });
      }
    }
    first = -1;
    speeds = [];
  }
  for (let i = 0; i < count; i++) {
    const frame = textFrame(pixels.subarray(i * size, (i + 1) * size), width, height);
    const shift = upwardShift(history[i % fps], frame, width / 32, height);
    history[i % fps] = frame;
    if (shift) {
      if (first < 0) first = i - fps;
      last = i;
      speeds.push(shift);
    } else if (first >= 0 && i - last >= fps) finish();
  }
  finish();
  return ranges;
}
