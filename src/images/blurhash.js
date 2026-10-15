const f = Math.fround;
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const linear = Float32Array.from({ length: 256 }, (_, value) => value < 11 ? value / 3294.6 : ((value + 14.025) / 269.025) ** 2.4);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function base83(value, length) { let result = ''; for (let i = 0; i < length; i++) { result = alphabet[value % 83] + result; value = Math.trunc(value / 83); } return result; }
function srgb(value) { value = clamp(value, 0, 1); return value <= f(0.0031308) ? Math.trunc(f(f(f(3294.6) * value) + 0.5)) : Math.trunc(f(f(f(269.025) * f(value ** f(1 / f(2.4)))) - f(13.525))); }
function cosines(length, component) { const offset = f(f(f(Math.PI) * component) / length), values = new Float32Array(length); let angle = 0; for (let i = 0; i < length; i++) { values[i] = Math.cos(angle); angle = f(angle + offset); } return values; }
export function blurhashComponents(width, height) { const x = f(Math.sqrt(f(f(16 * width) / height))), y = f(f(x * height) / width); return [Math.min(Math.trunc(x) + 1, 9), Math.min(Math.trunc(y) + 1, 9)]; }
export function encodeBlurhash(pixels, width, height, xComponents, yComponents) {
  if (width <= 0 || height <= 0) return '';
  if (xComponents < 1 || xComponents > 9 || yComponents < 1 || yComponents > 9) throw new RangeError('Invalid BlurHash component count.');
  const factors = new Float32Array(xComponents * yComponents * 3);
  for (let yc = 0; yc < yComponents; yc++) {
    const cy = cosines(height, yc);
    for (let xc = 0; xc < xComponents; xc++) {
      const cx = cosines(width, xc), sums = [0, 0, 0];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const basis = f(cx[x] * cy[y]), offset = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) sums[channel] = f(sums[channel] + f(basis * linear[pixels[offset + channel]]));
      }
      const scale = f((xc === 0 && yc === 0 ? 1 : 2) / (width * height)), index = (yc * xComponents + xc) * 3;
      for (let channel = 0; channel < 3; channel++) factors[index + channel] = f(sums[channel] * scale);
    }
  }
  let maximum = 0; for (let i = 3; i < factors.length; i++) maximum = Math.max(maximum, Math.abs(factors[i]));
  const quantized = factors.length > 3 ? clamp(Math.trunc(f(f(maximum * 166) - 0.5)), 0, 82) : 0;
  const maximumValue = factors.length > 3 ? f((quantized + 1) / 166) : 1;
  let result = base83(xComponents - 1 + (yComponents - 1) * 9, 1) + base83(quantized, 1) + base83((srgb(factors[0]) << 16) + (srgb(factors[1]) << 8) + srgb(factors[2]), 4);
  const ac = value => { const ratio = f(value / maximumValue); return clamp(Math.trunc(f(f(9 * f(Math.sign(ratio) * f(Math.sqrt(Math.abs(ratio))))) + 9.5)), 0, 18); };
  for (let i = 3; i < factors.length; i += 3) result += base83(361 * ac(factors[i]) + 19 * ac(factors[i + 1]) + ac(factors[i + 2]), 2);
  return result;
}
