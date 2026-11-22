// FFmpeg's Chromaprint algorithm 1 (TEST2) advances by 1365 samples at 11025 Hz.
export const secondsPerHash = 1365 / 11025;
const second = 10000000n;
const introName =
  /^(?:op(?:ening)?(?: theme| sequence)?|intro(?:duction)?|opening credits|title sequence|main titles|片头(?:曲)?|片頭(?:曲)?|オープニング)(?:[\s:：#_.-]*\d+)?$/iu;
const creditsName =
  /^(?:ed|ending(?: theme| credits)?|outro|(?:end|closing) credits|credits|片尾(?:曲|字幕)?|エンディング)(?:[\s:：#_.-]*\d+)?$/iu;

export function chapterIntervals(chapters, runtime) {
  const points = [...chapters].sort((a, b) =>
    a.StartPositionTicks < b.StartPositionTicks ? -1 : a.StartPositionTicks > b.StartPositionTicks ? 1 : 0,
  );
  const segments = [];
  for (const [index, chapter] of points.entries()) {
    const name = chapter.Name?.normalize('NFKC').trim() ?? '';
    const type = introName.test(name) ? 5 : creditsName.test(name) ? 4 : null;
    const start = chapter.StartPositionTicks;
    const end = points[index + 1]?.StartPositionTicks ?? runtime;
    if (
      !type ||
      start == null ||
      end == null ||
      start < 0n ||
      end <= start ||
      (runtime != null && end > runtime)
    )
      continue;
    // A chapterless remainder named "Opening" is insufficient evidence to skip an entire film.
    if (type === 5 && index + 1 === points.length) continue;
    if (start === 0n && end === runtime) continue;
    segments.push({ Type: type, StartTicks: start, EndTicks: end });
  }
  return segments;
}

function hamming(a, b) {
  let v = (a ^ b) >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Index two independent halves of each fingerprint. Very frequent keys (silence,
// drones and station idents) carry little information about temporal alignment.
function offsets(left, right) {
  const anchors = new Map(),
    votes = new Map();
  for (let i = 0; i < right.length; i++) {
    for (const k of [right[i] & 65535, 65536 + (right[i] >>> 16)]) {
      const hits = anchors.get(k);
      if (!hits) anchors.set(k, [i]);
      else if (hits.length <= 12) hits.push(i);
    }
  }
  for (let i = 0; i < left.length; i += 2) {
    for (const k of [left[i] & 65535, 65536 + (left[i] >>> 16)]) {
      const hits = anchors.get(k);
      if (!hits || hits.length > 12) continue;
      for (const j of hits) votes.set(i - j, (votes.get(i - j) ?? 0) + 1);
    }
  }
  return [...votes]
    .filter(([, count]) => count >= 8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([d]) => d);
}

// Score full 32-bit fingerprints along each candidate offset. Isolated noisy
// hashes are tolerated; a sustained mismatch ends the interval.
export function matchingIntervals(left, right, maxSeconds) {
  const candidates = [];
  for (const delta of offsets(left, right)) {
    const first = Math.max(0, delta),
      limit = Math.min(left.length, right.length + delta);
    let start = -1,
      last = -1,
      good = 0,
      misses = 0;
    const finish = () => {
      const length = last - start + 1;
      if (
        start >= 0 &&
        length * secondsPerHash >= 15 &&
        length * secondsPerHash <= maxSeconds &&
        good >= length * 0.85 &&
        new Set(left.slice(start, last + 1)).size >= length * 0.12 &&
        !(start <= first + 2 && last >= limit - 3)
      ) {
        candidates.push({ start, end: last + 1, score: good });
      }
      start = -1;
      good = 0;
      misses = 0;
    };
    for (let i = first; i < limit; i++) {
      if (hamming(left[i], right[i - delta]) <= 7) {
        if (start < 0) start = i;
        last = i;
        good++;
        misses = 0;
      } else if (start >= 0 && ++misses > 4) finish();
    }
    finish();
  }
  return candidates.sort((a, b) => b.score - a.score);
}

export function recurringInterval(window, peers, type) {
  const matches = [];
  for (const peer of peers) {
    const candidates = matchingIntervals(window.hashes, peer.hashes, type === 5 ? 180 : 300);
    const best = candidates[0];
    if (!best) continue;
    const another = candidates.some(
      (c) => (c.end < best.start || c.start > best.end) && c.score >= best.score * 0.8,
    );
    if (!another) matches.push(best);
  }
  if (!matches.length) return null;
  // With multiple references require two episodes to support the same range.
  const agree = matches
    .map((m) => matches.filter((n) => Math.abs(m.start - n.start) < 24 && Math.abs(m.end - n.end) < 24))
    .sort((a, b) => b.length - a.length)[0];
  if (peers.length > 1 && agree.length < 2) return null;
  const start = window.start + Math.max(...agree.map((m) => m.start)) * secondsPerHash;
  const end = window.start + Math.min(...agree.map((m) => m.end)) * secondsPerHash;
  if (end <= start) return null;
  return {
    Type: type,
    StartTicks: BigInt(Math.round(start * Number(second))),
    EndTicks: BigInt(Math.round(end * Number(second))),
  };
}
