import { buildPostgresItemPageQuery, visitPostgresRowPlanPages } from '../database/postgres-item-query.js';
import { quoteIdentifier as q } from '../database/model.js';
import { decodeNativeTextBytes, nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';

export function visitLibraryProviderPaths(session, { kind, provider, value, signal }, visit) {
  const sql = nativeTextSql(session.schemaName);
  const entity = `${q(session.schemaName)}."BaseItems"`;
  const identity = `${q(session.schemaName)}."BaseItemProviders"`;
  const source = buildPostgresItemPageQuery(session, { includeitemtypes: [kind] }, { includeOrdinal: true });
  const providerId = sql.ordinalIgnoreCaseKey(`$${source.values.length + 1}::bytea`);
  const providerValue = sql.ordinalIgnoreCaseKey(`$${source.values.length + 2}::bytea`);
  const normalized = expression => sql.guidLower(expression);
  const expectedValue = sql.ordinalIgnoreCaseKey('NULLIF(provider."ProviderValue", \'\'::bytea)');
  const plan = { text: `SELECT item."Path"
    FROM (${source.text}) selected JOIN ${entity} item ON item."Id" = selected."Id"
    LEFT JOIN LATERAL (
      SELECT supplied."ProviderValue" FROM ${identity} supplied
      WHERE ${normalized('supplied."ItemId"')} = ${normalized('item."Id"')}
        AND ${sql.ordinalIgnoreCaseKey('supplied."ProviderId"')} = ${providerId}
      ORDER BY supplied."ProviderId" DESC LIMIT 1
    ) provider ON TRUE
    WHERE ${expectedValue} IS NOT DISTINCT FROM ${providerValue}
    ORDER BY selected."__ordinal"`, values: [...source.values, nativeTextBytes(provider), value == null ? null : nativeTextBytes(value)] };
  return visitPostgresRowPlanPages(session, plan, { signal }, async rows => {
    for (const row of rows) {
      signal?.throwIfAborted();
      await visit(row.Path == null ? null : decodeNativeTextBytes(row.Path));
    }
  });
}
