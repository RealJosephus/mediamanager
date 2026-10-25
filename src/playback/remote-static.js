import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { MIMEType } from 'node:util';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { BinaryResult } from '../http/binary-result.js';

const redirectStatuses = new Set([300, 301, 302, 303, 307, 308]);
const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
const maxInt64 = 9223372036854775807n;

function contentRange(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^([!#$%&'*+.^_`|~\w-]+) (?:(\d+)-(\d+)\/(\d+|\*)|\*\/(\d+))$/u.exec(value);
  if (!match) return undefined;
  const [, , first, last, complete, unsatisfied] = match;
  const numbers = [first, last, complete === '*' ? undefined : complete, unsatisfied]
    .filter(number => number !== undefined).map(BigInt);
  if (numbers.some(number => number > maxInt64)) return undefined;
  if (first !== undefined && (BigInt(first) > BigInt(last) || (complete !== '*' && BigInt(last) >= BigInt(complete)))) return undefined;
  return value;
}

function contentType(value) {
  if (typeof value !== 'string') return 'application/octet-stream';
  try { new MIMEType(value); return value; }
  catch { return 'application/octet-stream'; }
}

function get(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method: 'GET', headers, signal }, resolve);
    request.once('error', reject);
    request.end();
  });
}

async function getWithRetry(url, headers, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await get(url, headers, signal); }
    catch (error) {
      // SocketsHttpHandler retries a safe GET when the peer closes before
      // sending response headers, up to four total attempts.
      if (signal.aborted || error.code !== 'ECONNRESET' || attempt >= 3) throw error;
    }
  }
}

async function follow(url, headers, signal) {
  for (let redirects = 0; ; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported remote media protocol.');
    const upstream = await getWithRetry(url, headers, signal);
    // HttpClient's automatic-redirect limit is 50. Once reached it exposes
    // the last 3xx response to the static-stream helper instead of failing.
    if (!redirectStatuses.has(upstream.statusCode) || !upstream.headers.location || redirects >= 50) return upstream;
    const next = new URL(upstream.headers.location, url);
    // SocketsHttpHandler does not automatically downgrade a trusted HTTPS
    // request to HTTP; expose the redirect response without fetching it.
    if (url.protocol === 'https:' && next.protocol === 'http:') return upstream;
    upstream.destroy();
    url = next;
  }
}

export function remoteStaticStreamResult(mediaPath, remoteHeaders = {}, serverVersion = '13.0.0') {
  return new BinaryResult(async (request, response) => {
    const controller = new AbortController();
    const abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', abort);
    response.once('close', abort);
    let upstream, decoder;
    try {
      const headers = {};
      const userAgent = remoteHeaders?.get?.('User-Agent') ?? remoteHeaders?.['User-Agent'] ?? remoteHeaders?.['user-agent'];
      headers['User-Agent'] = userAgent || `Jellyfin-Server/${serverVersion}`;
      headers.Accept = 'application/json; q=1.0, application/xml; q=0.9, */*; q=0.8';
      headers['Accept-Encoding'] = 'gzip, deflate, br';
      if (request.headers.range !== undefined) headers.Range = request.headers.range;
      if (request.headers['if-range'] !== undefined) headers['If-Range'] = request.headers['if-range'];
      upstream = await follow(new URL(mediaPath), headers, controller.signal);
      if (controller.signal.aborted) return;
      // HttpClient AutomaticDecompression removes only the last content
      // coding. Earlier layers remain encoded in the forwarded body.
      const encoding = upstream.headers['content-encoding']?.split(',').at(-1).trim().toLowerCase();
      const decompress = Object.hasOwn(decoders, encoding) ? decoders[encoding] : undefined;
      response.statusCode = upstream.statusCode;
      response.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] ?? (upstream.statusCode === 206 ? 'bytes' : 'none'));
      const range = contentRange(upstream.headers['content-range']);
      if (range !== undefined) response.setHeader('Content-Range', range);
      if (!decompress && upstream.headers['content-length'] !== undefined) response.setHeader('Content-Length', upstream.headers['content-length']);
      response.setHeader('Content-Type', contentType(upstream.headers['content-type']));
      if (request.method === 'HEAD') { response.end(); return; }
      if (decompress) {
        decoder = decompress();
        upstream.once('error', error => decoder.destroy(error));
        upstream.pipe(decoder);
      }
      for await (const chunk of decoder ?? upstream) {
        if (controller.signal.aborted) return;
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      response.end();
    } catch (error) {
      if (controller.signal.aborted || response.headersSent) { response.destroy(); return; }
      error.status = 500;
      throw error;
    } finally {
      decoder?.destroy();
      upstream?.destroy();
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
    }
  });
}
