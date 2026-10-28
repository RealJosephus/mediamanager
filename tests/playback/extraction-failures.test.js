import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionService } from '../../src/playback/extraction.js';
import { ProbeReadBridge } from '../../src/storage/probe-bridge.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { createTestMediaEncoder } from '../helpers/media-encoder.js';
import { extractionFixture } from './extraction-fixture.js';
import reference from './fixtures/extraction-reference.json' with { type: 'json' };

test('packet-copy and attachment metadata failures survive a later actual bridge release failure and allow retry', { timeout: 60000 }, async t => {
  for (const operation of ['subtitle', 'attachment']) for (const [name, primary] of [['undefined', undefined], ['null', null]]) {
    await t.test(`${operation}/${name}`, { timeout: 30000 }, async t => {
      let fixture, bridge, service, inject = true, failMetadata = false, metadataFailed = false;
      const released = [], processes = [], secondary = new Error('The released extraction bridge reported a cleanup error.', {
        cause: new Error('The actual bridge owner is already released.'),
      });
      t.after(async () => {
        const errors = [];
        for (const close of [() => service?.close(), () => bridge?.close(), () => fixture?.close()]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Extraction failure fixture cleanup failed.', { cause: errors[0] });
      });
      fixture = await extractionFixture(Object.fromEntries(reference.sources.map(value => ['/' + value.name, Buffer.from(value.media, 'base64')])));
      bridge = new ProbeReadBridge(fixture.vfs);
      // The bridge keeps the actual source VFS. Only the extraction consumer's
      // later source-metadata read rejects, after the real lease is admitted.
      const vfs = { resolve: fixture.vfs.resolve.bind(fixture.vfs), async stat(...arguments_) {
        const info = await fixture.vfs.stat(...arguments_);
        if (failMetadata) { metadataFailed = true; throw primary; }
        return info;
      } };
      const leases = { async lease(...arguments_) {
        const owned = await bridge.lease(...arguments_);
        if (inject) failMetadata = true;
        return { ...owned, async release() {
          await owned.release(); released.push(owned.url);
          if (inject) throw secondary;
        } };
      } };
      service = new ExtractionService({ vfs, bridge: leases, subtitleCache: fixture.createSubtitleCache(),
        mediaEncoder: await createTestMediaEncoder(t), getEncodingOptions: () => defaultConfiguration('encoding'),
        onProcess: value => processes.push(value),
      });
      const expected = reference.outputs.find(value => value.type === operation && (operation === 'attachment' || value.format === 'srt'));
      const entry = reference.sources.find(value => value.name === expected.source);
      const stream = (operation === 'subtitle' ? entry.source.MediaStreams : entry.source.MediaAttachments).find(value => value.Index === expected.index);
      await assert.rejects(service[operation](entry.source, stream, '/' + entry.name, { signal: t.signal }), error => {
        assert.equal(Object.hasOwn(error, 'cause'), true); assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, secondary]);
        return true;
      });
      assert.equal(metadataFailed, true, 'The actual source metadata read rejected after the media operation completed.');
      assert.ok(fixture.requests.some(value => value.method === 'GET' && value.path === '/' + entry.name));
      assert.ok(processes.some(value => operation === 'subtitle' ? value.args.includes('copy') : value.args.some(argument => argument.startsWith('-dump_attachment:'))));
      for (const url of released) { const response = await fetch(url, { signal: t.signal }); assert.equal(response.status, 404); await response.arrayBuffer(); }
      inject = false; failMetadata = false;
      const recovered = await service[operation](entry.source, stream, '/' + entry.name, { signal: t.signal });
      assert.deepEqual(recovered.bytes, Buffer.from(expected.bytes, 'base64'));
      for (const url of released) { const response = await fetch(url, { signal: t.signal }); assert.equal(response.status, 404); await response.arrayBuffer(); }
    });
  }
});
