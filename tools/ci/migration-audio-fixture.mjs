const rate = 11025;
export function music(id, opening, gain = 1, themeId = 19, length = 66) {
  const pcm = Buffer.alloc(length * rate * 2 + 44);
  pcm.write('RIFF');
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24);
  pcm.writeUInt32LE(rate * 2, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(pcm.length - 44, 40);
  for (let i = 0; i < length * rate; i++) {
    const t = i / rate,
      theme = t >= opening && t < opening + 28,
      clock = theme ? t - opening : t;
    const step = Math.floor(clock * 3),
      seed = theme ? themeId : id;
    const note =
      Math.abs((Math.imul(step + seed, 1597334677) ^ Math.imul(seed + step * step, 747796405)) >> 4) % 34;
    const angle = clock * 2 * Math.PI * 123.47 * 2 ** (note / 12);
    const chord = Math.sin(angle) + 0.46 * Math.sin(angle * 1.498) + 0.25 * Math.sin(angle * 2.51);
    pcm.writeInt16LE(Math.round(10000 * gain * chord), 44 + i * 2);
  }
  return pcm;
}
