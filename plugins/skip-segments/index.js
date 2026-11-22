import { createHash, randomUUID } from 'node:crypto';
import { quoteIdentifier } from '@mediamanager/plugin-sdk/database/model';
import { ScheduledTaskWorker } from '@mediamanager/plugin-sdk/tasks/refresh-library-task';
import { chapterIntervals, recurringInterval } from './detection.js';
import { rollingCredits } from './rolling-credits.js';

const name = 'MediaManager Intro and Credits';
const movie = 'MediaBrowser.Controller.Entities.Movies.Movie',
  episode = 'MediaBrowser.Controller.Entities.TV.Episode';
const columns = [
  'Id',
  'Type',
  'Path',
  'SeasonId',
  'IndexNumber',
  'RunTimeTicks',
  'DateModified',
  'IsVirtualItem',
];
const second = 10000000n;

function windowFor(item, type) {
  const length = Number(item.RunTimeTicks / second),
    duration = Math.min(type === 5 ? 600 : 420, Math.floor(length / 3));
  return { start: type === 5 ? 0 : length - duration, duration };
}

export async function scanSegments(services, { signal, reportProgress }) {
  const { store, mediaSegments, readSegmentFingerprint } = services;
  // The LRU holds decoded fingerprints of only a few neighbouring episodes.
  const fingerprints = new Map();
  async function fingerprint(item, type) {
    const { start, duration } = windowFor(item, type);
    if (duration < 22) return null;
    const key = [item.Id, item.Path, item.DateModified, item.RunTimeTicks, type].join('/');
    const saved = fingerprints.get(key);
    if (saved) {
      fingerprints.delete(key);
      fingerprints.set(key, saved);
      return saved;
    }
    const hashes = await readSegmentFingerprint(item, start, duration, signal);
    const value = { start, hashes };
    if (fingerprints.size >= 16) fingerprints.delete(fingerprints.keys().next().value);
    fingerprints.set(key, value);
    return value;
  }
  const criteria = { where: { IsVirtualItem: false }, whereIn: { Type: [movie, episode] } };
  const cacheTable = (db) => quoteIdentifier(db.controlSchema) + '.skip_segment_analysis';
  await store.run(
    async (db) => {
      await db.ensureMediaSegmentStorage();
      await db.client.query(
        'DELETE FROM ' +
          cacheTable(db) +
          ' c WHERE NOT EXISTS (SELECT 1 FROM ' +
          quoteIdentifier(db.schemaName) +
          '."BaseItems" b WHERE b."Id"=c.item_id)',
      );
    },
    { signal },
  );
  let after,
    count = 0;
  const total = await store.run(
    async (db) =>
      (
        await db.client.query(
          'SELECT COUNT(*) AS n FROM "BaseItems" WHERE "IsVirtualItem" IS FALSE AND "Type" = ANY($1::bytea[])',
          [[Buffer.from(movie), Buffer.from(episode)]],
        )
      ).rows[0].n,
    { signal },
  );
  while (true) {
    signal.throwIfAborted();
    const page = await store.run((db) => db.rows('BaseItems', { ...criteria, columns, after, limit: 32 }), {
      signal,
    });
    if (!page.length) break;
    for (const item of page) {
      signal.throwIfAborted();
      reportProgress(Math.min(100, (100 * count++) / Math.max(1, Number(total))));
      if (!item.Path || !item.RunTimeTicks || !(await mediaSegments.providerEnabled(item.Id, name))) continue;
      const held = await mediaSegments.heldTypes(item.Id, signal);
      if (held.has(4) && held.has(5)) continue;
      const chapters = await store.run(
        (db) => db.rows('Chapters', { where: { ItemId: item.Id }, orderBy: [{ column: 'ChapterIndex' }] }),
        { signal },
      );
      const candidates = chapterIntervals(chapters, item.RunTimeTicks).filter((s) => !held.has(s.Type));
      const references = [];
      if (readSegmentFingerprint && item.Type === episode && item.SeasonId && item.IndexNumber != null) {
        // Neighbouring episodes are more likely to share a theme after a mid-season change.
        const peers = await store.run(
          async (db) => {
            const result = await db.client.query(
              'SELECT "Id" FROM "BaseItems" WHERE "SeasonId"=$1 AND "Type"=$2 AND "IsVirtualItem" IS FALSE AND "IndexNumber"<>$3 ' +
                'ORDER BY abs("IndexNumber"::bigint-$3::bigint),"IndexNumber","Id" LIMIT 12',
              [Buffer.from(item.SeasonId), Buffer.from(episode), item.IndexNumber],
            );
            const ids = result.rows.map((r) => r.Id.toString('utf8'));
            if (!ids.length) return [];
            const rows = await db.rows('BaseItems', { whereIn: { Id: ids }, columns });
            const byId = new Map(rows.map((row) => [row.Id, row]));
            return ids.map((id) => byId.get(id)).filter(Boolean);
          },
          { signal },
        );
        const numbers = new Set([item.IndexNumber]);
        for (const p of peers) {
          if (
            p.IndexNumber == null ||
            numbers.has(p.IndexNumber) ||
            p.Path === item.Path ||
            !p.Path ||
            !p.RunTimeTicks
          )
            continue;
          if (!(await mediaSegments.providerEnabled(p.Id, name))) continue;
          numbers.add(p.IndexNumber);
          references.push(p);
          if (references.length === 3) break;
        }
      }
      const revision = (row) => [row.Id, row.Path, row.RunTimeTicks, row.DateModified];
      const signature = createHash('sha256')
        .update(
          JSON.stringify(
            [
              2,
              revision(item),
              chapters.map((c) => [c.Name, c.StartPositionTicks]),
              references.map(revision),
            ],
            (_, v) => (typeof v === 'bigint' ? String(v) : v),
          ),
        )
        .digest('hex');
      const key = Buffer.from(item.Id);
      const unchanged = await store.run(
        (db) =>
          db.client.query('SELECT 1 FROM ' + cacheTable(db) + ' WHERE item_id=$1 AND signature=$2', [
            key,
            signature,
          ]),
        { signal },
      );
      if (unchanged.rowCount) continue;
      let completed = true;
      for (const type of [5, 4]) {
        if (held.has(type) || candidates.some((c) => c.Type === type) || !references.length) continue;
        try {
          const target = await fingerprint(item, type),
            other = [];
          if (!target) continue;
          for (const peer of references) {
            try {
              const window = await fingerprint(peer, type);
              if (window) other.push(window);
            } catch (error) {
              signal.throwIfAborted();
              services.onAnalysisError(error);
              completed = false;
            }
          }
          const found = recurringInterval(target, other, type);
          if (found) candidates.push(found);
        } catch (error) {
          signal.throwIfAborted();
          // A missing track, unavailable file or unsupported muxer cannot invalidate known chapters.
          services.onAnalysisError(error);
          completed = false;
        }
      }
      if (services.readSegmentCreditFrames && !held.has(4) && !candidates.some((c) => c.Type === 4)) {
        const { duration } = windowFor(item, 4);
        if (duration >= 22) {
          const start = Number(item.RunTimeTicks) / Number(second) - duration;
          try {
            const sample = await services.readSegmentCreditFrames(item, start, duration, signal);
            candidates.push(...rollingCredits(sample, start, item.RunTimeTicks));
          } catch (error) {
            signal.throwIfAborted();
            services.onAnalysisError(error);
            completed = false;
          }
        }
      }
      if (candidates.length)
        await mediaSegments.saveMissing(
          item,
          name,
          candidates.map((s) => ({ ...s, Id: randomUUID().toUpperCase() })),
          signal,
        );
      if (completed)
        await store.run(
          (db) =>
            db.client.query(
              'INSERT INTO ' +
                cacheTable(db) +
                ' SELECT "Id",$2 FROM ' +
                quoteIdentifier(db.schemaName) +
                '."BaseItems" WHERE "Id"=$1 ON CONFLICT(item_id) DO UPDATE SET signature=excluded.signature',
              [key, signature],
            ),
          { signal },
        );
    }
    after = { Id: page.at(-1).Id };
  }
  reportProgress(100);
}

export async function activate(context) {
  return {
    async connect(services) {
      await context.register('mediaSegment', { name });
      if (
        services.canReadPublishedIntroSkipper &&
        (await services.mediaSegments.hasPublishedProvider('Intro Skipper'))
      ) {
        await context.register('mediaSegment', { name: 'Intro Skipper' });
      }
      await context.register('task', {
        create: (options) =>
          new ScheduledTaskWorker({
            ...options,
            definition: {
              id: 'bcd5e75481194582b93a354f9ffec0c6',
              key: 'AnalyzeIntroAndCredits',
              name: 'Detect intros and credits',
              description: 'Find missing segments from chapters, recurring season audio and rolling credits.',
              category: 'Library',
              defaultTriggers: [{ Type: 'DailyTrigger', TimeOfDayTicks: 108000000000n }],
            },
            run: (operation) =>
              scanSegments({ ...services, onAnalysisError: context.logger.warn }, operation),
          }),
      });
    },
  };
}
