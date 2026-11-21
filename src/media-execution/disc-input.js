import { createHash } from 'node:crypto';
import { readBlurayDiscInfo, verifyBlurayDiscInfo } from '../storage/bluray-disc-info.js';
import { getDvdMediaFiles, verifyDvdMediaFiles } from '../storage/dvd-media-files.js';
import { StorageError } from '../storage/errors.js';
import { probeRaw } from '../storage/ffprobe.js';
import { normalizeProbe } from '../storage/probe-normalizer.js';

export async function resolveDiscInput(vfs, videoType, virtualPath, signal) {
  const dvd = videoType === 'Dvd';
  const playlist = dvd ? undefined : await readBlurayDiscInfo(vfs, virtualPath, { signal });
  const files = dvd ? await getDvdMediaFiles(vfs, virtualPath, { signal }) : playlist?.files;
  if (!files?.length) throw new StorageError('invalid-response', 'The disc has no playable files.');
  const version = files.every(file => vfs.capabilities(file.virtualPath).reliableVersion && file.version != null)
    ? createHash('sha256').update(JSON.stringify(files.map(file => [file.virtualPath, file.version]))).digest('hex') : null;
  const verify = signal => dvd ? verifyDvdMediaFiles(vfs, virtualPath, files, { signal })
    : verifyBlurayDiscInfo(vfs, playlist, { signal });
  return { files, version, verify };
}

function seconds(ticks) {
  const fraction = String(ticks % 10000000n).padStart(7, '0').replace(/0+$/u, '');
  const whole = String(ticks / 10000000n);
  return fraction ? `${whole}.${fraction}` : whole;
}

export async function leaseDiscInput(bridge, disc, encoder, { signal, expiresInMs, concatProtocol = false }) {
  const leases = [], lines = [];
  const release = async () => {
    const results = await Promise.allSettled(leases.map(lease => lease.release()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Disc input leases could not finish.');
  };
  try {
    for (const file of disc.files) {
      const version = file.version ?? undefined;
      let duration;
      if (!concatProtocol) {
        const { raw } = await probeRaw(bridge, file.virtualPath, { executable: encoder.probePath, environment: encoder.environment,
          threads: encoder.probeThreads, version, signal });
        const ticks = normalizeProbe(raw).RunTimeTicks;
        if (ticks == null || ticks < 0n) throw new StorageError('invalid-response', 'A disc segment has no usable duration.');
        duration = seconds(ticks);
      }
      const lease = await bridge.lease(file.virtualPath, { version, signal, expiresInMs });
      leases.push(lease);
      if (duration !== undefined) lines.push(`file '${lease.url}'`, `duration ${duration}`);
    }
    await disc.verify(signal);
    if (!concatProtocol) leases.push(await bridge.leaseBuffer(Buffer.from(lines.join('\n') + '\n'), { signal, expiresInMs }));
    const url = concatProtocol && leases.length > 1 ? `concat:${leases.map(lease => lease.url).join('|')}` : leases.at(-1).url;
    const redact = text => leases.reduce((value, lease) => value.replaceAll(lease.url, '[private source]'), text);
    return { url, release, redact };
  } catch (error) {
    try { await release(); }
    catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], error.message, { cause: error }), { code: error.code }); }
    throw error;
  }
}
