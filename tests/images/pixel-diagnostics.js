export function pixelDifference(actual, expected) {
  const result = { actualBytes: actual.length, expectedBytes: expected.length, differentRgbBytes: 0, differentAlphaBytes: 0, firstDifferences: [] };
  for (let offset = 0; offset < Math.min(actual.length, expected.length); offset++) if (actual[offset] !== expected[offset]) {
    if (offset % 4 === 3) result.differentAlphaBytes++;
    else result.differentRgbBytes++;
    if (result.firstDifferences.length < 16) result.firstDifferences.push({ offset, actual: actual[offset], expected: expected[offset] });
  }
  return result;
}
