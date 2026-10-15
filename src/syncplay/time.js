export const epochTicks = 621355968000000000n;
export const maximumDateTicks = 3155378975999999999n;
export const utcTicks = () => epochTicks + BigInt(Date.now()) * 10000n;
export const maxTicks = (left, right) => left > right ? left : right;
export const absoluteTicks = value => {
  if (value === -9223372036854775808n) throw new RangeError('Negating the minimum Int64 value is invalid.');
  return value < 0n ? -value : value;
};
export const addTicks = (left, right) => BigInt.asIntN(64, left + right);
export function addTimeSpanTicks(left, right) {
  const value = left + right;
  if (value < -9223372036854775808n || value > 9223372036854775807n) throw new RangeError('TimeSpan overflow.');
  return value;
}

export function formatUtcTicks(ticks) {
  if (ticks < 0n || ticks > maximumDateTicks) throw new RangeError('DateTime is outside the native range.');
  const seconds = new Date(Number(ticks / 10000000n * 1000n - epochTicks / 10000n)).toISOString().slice(0, 19);
  const fraction = String(ticks % 10000000n).padStart(7, '0');
  return `${seconds}.${Number(fraction.slice(0, 3)) ? fraction.replace(/0+$/, '') : fraction}Z`;
}
