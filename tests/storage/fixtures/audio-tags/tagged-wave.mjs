function syncSafe(value) {
  const bytes = Buffer.alloc(4);
  bytes[0] = value >>> 21 & 0x7f;
  bytes[1] = value >>> 14 & 0x7f;
  bytes[2] = value >>> 7 & 0x7f;
  bytes[3] = value & 0x7f;
  return bytes;
}

function frame(name, value, description) {
  const text = description == null
    ? Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')])
    : Buffer.concat([Buffer.from([3]), Buffer.from(description, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8')]);
  return Buffer.concat([Buffer.from(name, 'ascii'), syncSafe(text.length), Buffer.alloc(2), text]);
}

function chunk(name, value) {
  const padding = value.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const header = Buffer.alloc(8);
  header.write(name, 0, 4, 'ascii');
  header.writeUInt32LE(value.length, 4);
  return Buffer.concat([header, value, padding]);
}

export function taggedWave() {
  const tagFrames = [
    frame('TIT2', 'ATL title'),
    frame('TALB', 'ATL album'),
    frame('TPE1', 'Artist One\0Artist Two'),
    frame('TPE2', 'Album Artist'),
    frame('TCOM', 'Composer One'),
    frame('TCON', 'Rock\0Pop'),
    frame('TDRC', '2024-02-29'),
    frame('TRCK', '3/12'),
    frame('TPOS', '2/3'),
    frame('TXXX', '-7.25 dB', 'REPLAYGAIN_TRACK_GAIN'),
    frame('TXXX', '11111111-1111-1111-1111-111111111111', 'MUSICBRAINZ_TRACKID'),
    frame('TXXX', '22222222-2222-2222-2222-222222222222', 'MUSICBRAINZ_ALBUMID'),
  ];
  const body = Buffer.concat(tagFrames);
  const id3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'binary'), syncSafe(body.length), body]);
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(8000, 4);
  format.writeUInt32LE(16000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const chunks = Buffer.concat([chunk('fmt ', format), chunk('data', Buffer.alloc(1600)), chunk('ID3 ', id3)]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(chunks.length + 4, 4);
  header.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([header, chunks]);
}
