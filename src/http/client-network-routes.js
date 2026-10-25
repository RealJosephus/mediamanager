import { randomFillSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BindingError, integerValue, queryValue } from './binding.js';
import { BinaryResult } from './binary-result.js';
import { requestIsLocal, requestNetworkInfo } from '../network/http-request.js';

// SystemController.GetEndpointInfo and MediaInfoController.GetBitrateTestBytes
// in the designated Jellyfin source. Both are used by the unmodified Web client.
export function registerClientNetworkRoutes(add, { authentication }) {
  add('GET', '/System/Endpoint', context => {
    const info = context.requestInfo ?? requestNetworkInfo(context.request);
    return {
      IsLocal: requestIsLocal(info),
      IsInNetwork: authentication.isLocalNetwork(context.remoteEndPoint)
    };
  });
  add('GET', '/Playback/BitrateTest', context => {
    let length = 16;
    // The reference returns the complete rented array, including its rounded
    // capacity. That capacity is observable in the HTTP body and Content-Length.
    while (length < context.queryInput) length *= 2;
    return new BinaryResult(async (request, response) => {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', length);
      // Bound each allocation and let pipeline own disconnect/backpressure.
      // No media encoder, database or persistent file participates in this test.
      const chunks = function* () {
        for (let remaining = length; remaining > 0;) {
          const chunk = Buffer.allocUnsafe(Math.min(65536, remaining));
          randomFillSync(chunk);
          remaining -= chunk.length;
          yield chunk;
        }
      };
      await pipeline(Readable.from(chunks(), { objectMode: false, highWaterMark: 65536 }), response);
    });
  }, { bindQuery: query => {
    const raw = queryValue(query, 'size');
    if (raw !== undefined && raw.trim() === '') throw new BindingError('size', `The value '${raw}' is invalid.`);
    const size = integerValue(raw, 'size', 102400);
    if (size < 1 || size > 100000000) throw new BindingError('size',
      'The requested size must be greater than or equal to 1 and less than or equal to 100000000');
    return size;
  } });
}
