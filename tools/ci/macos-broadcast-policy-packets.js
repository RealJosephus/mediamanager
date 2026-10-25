import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Decode captured wire evidence, not a simulated socket or PF text assertion.
// PKTAP common flags remain at offset36 for its two public header formats:
// https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/net/pktap.h
const sha = value => createHash('sha256').update(value).digest('hex');
const zeroText = value => value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)).toString('utf8');
const ipv4 = value => [...value].join('.');

export function policyPackets(bytes, pktapDatalink) {
  assert.ok(bytes.length >= 24 && bytes.length <= 16 * 1024 * 1024);
  const magic = bytes.subarray(0, 4).toString('hex');
  assert.ok(['d4c3b2a1', '4d3cb2a1', 'a1b2c3d4', 'a1b23c4d'].includes(magic), 'Original classic pcap is required.');
  const little = magic === 'd4c3b2a1' || magic === '4d3cb2a1';
  const u32 = (value, offset) => value[little ? 'readUInt32LE' : 'readUInt32BE'](offset);
  const datalink = u32(bytes, 20) & 0xffff;
  assert.equal(datalink, pktapDatalink, 'Original packet evidence must retain the actual SDK PKTAP metadata type.');
  const records = []; let offset = 24;
  while (offset < bytes.length) {
    assert.ok(offset + 16 <= bytes.length);
    const captured = u32(bytes, offset + 8), original = u32(bytes, offset + 12);
    assert.ok(captured <= original && offset + 16 + captured <= bytes.length);
    const raw = bytes.subarray(offset + 16, offset + 16 + captured);
    const record = { offset, capturedBytes: captured, originalBytes: original, sha256: sha(raw), rawHex: raw.toString('hex'),
      timestampSeconds: u32(bytes, offset), timestampFraction: u32(bytes, offset + 4), decoded: false };
    records.push(record); offset += 16 + captured;
    if (raw.length < 40) { record.reason = 'short-pktap'; continue; }
    const flags = u32(raw, 36), version2 = Boolean(flags & 0x80000);
    const headerBytes = version2 ? raw[0] : u32(raw, 0);
    const dataLink = version2 ? raw[little ? 'readUInt16LE' : 'readUInt16BE'](6) : u32(raw, 8);
    const nameOffset = version2 ? raw[3] : 12;
    if (headerBytes < 40 || headerBytes > raw.length || nameOffset <= 0 || nameOffset >= headerBytes) {
      record.reason = 'unparsed-pktap-header'; continue;
    }
    record.interface = zeroText(raw.subarray(nameOffset, Math.min(nameOffset + 24, headerBytes)));
    record.pktap = { version: version2 ? 2 : 1, headerBytes, dataLink, flags, directionOut: Boolean(flags & 2) };
    if (!version2 && u32(raw, 4) !== 1) { record.reason = 'non-packet-pktap'; continue; }
    let packet = raw.subarray(headerBytes), start;
    if (dataLink === 1) {
      if (packet.length < 14) { record.reason = 'short-ethernet'; continue; }
      start = 14; let etherType = packet.readUInt16BE(12);
      while ([0x8100, 0x88a8].includes(etherType) && start + 4 <= packet.length) { etherType = packet.readUInt16BE(start + 2); start += 4; }
      if (etherType !== 0x0800) { record.reason = 'not-ipv4'; continue; }
    } else if (dataLink === 0 || dataLink === 108) start = 4;
    else if ([12, 101, 228].includes(dataLink)) start = 0;
    else { record.reason = 'unparsed-linktype'; continue; }
    packet = packet.subarray(start);
    if (packet.length < 20 || packet[0] >> 4 !== 4) { record.reason = 'short-or-non-ipv4'; continue; }
    const header = (packet[0] & 15) * 4, length = packet.readUInt16BE(2);
    if (header < 20 || packet.length < length || length < header + 8 || packet[9] !== 17) { record.reason = 'not-complete-udp'; continue; }
    if (packet.readUInt16BE(6) & 0x3fff) { record.reason = 'fragmented-udp'; continue; }
    const udp = packet.subarray(header, length), udpBytes = udp.readUInt16BE(4);
    if (udpBytes < 8 || udpBytes > udp.length) { record.reason = 'invalid-udp-length'; continue; }
    record.decoded = true; record.source = ipv4(packet.subarray(12, 16)); record.destination = ipv4(packet.subarray(16, 20));
    record.sourcePort = udp.readUInt16BE(0); record.destinationPort = udp.readUInt16BE(2);
    record.payloadHex = udp.subarray(8, udpBytes).toString('hex');
    delete record.rawHex;
  }
  assert.equal(offset, bytes.length);
  return { bytes: bytes.length, sha256: sha(bytes), magic, datalink, records };
}

export function verifyPolicyPacketEvidence(capture, worker, scope) {
  const observations = [];
  for (const sample of worker.samples) {
    const matching = capture.records.filter(record => record.decoded && record.payloadHex === sample.nonceHex);
    const unknown = capture.records.filter(record => !record.decoded && record.capturedBytes > 0);
    assert.ok(!unknown.some(record => record.rawHex.includes(sample.nonceHex)), 'An owned nonce in an undecoded frame cannot establish interface isolation.');
    observations.push({ phase: sample.phase, kind: sample.kind, port: sample.port, nonceHex: sample.nonceHex,
      packetOffsets: matching.map(record => record.offset), interfaces: [...new Set(matching.map(record => record.interface))],
      unparsedPacketCount: unknown.length });
    if (sample.kind === 'loopback-control') {
      assert.ok(sample.replyReceived && matching.some(record => record.interface === 'lo0'), 'The capture must see a real concurrent loopback nonce.');
    } else if (sample.phase === 'alive') {
      assert.ok(sample.replyReceived && matching.some(record => [scope.interface, scope.peer].includes(record.interface)), 'The real broadcast must reach the owned link and return.');
      assert.ok(matching.every(record => [scope.interface, scope.peer, 'lo0'].includes(record.interface)), 'An owned broadcast nonce was observed on a foreign interface capture path.');
    } else {
      assert.equal(sample.phase, 'target-destroyed');
      assert.equal(sample.replyReceived, false);
      assert.equal(sample.requestReceived, false);
      assert.deepEqual(matching, [], 'A failed private target must not fall back to the foreign global broadcast route.');
    }
  }
  assert.equal(worker.allSocketsClosed, true);
  return { actualPacketEvidenceVerified: true, observations,
    evidenceBoundary: 'Owned nonce observations at PKTAP interface input/output capture paths; pinned BSD output path is after PF/route-to and before driver/hardware transmission.',
    hardwareWireAbsenceCertified: false,
    nativeDiscoveryExecuted: false, longRunDriftFixed: false, fullAcceptance: false, releaseAcceptance: false };
}
