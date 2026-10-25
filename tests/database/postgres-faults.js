import { quoteIdentifier as q } from '../../src/database/model.js';
import {nativeTextSql} from '../../src/database/native-text-sql.js';
import { idKey } from '../../src/library/records.js';

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

/** Fail the actual SQL deletion even when persistence uses a batched statement. */
export async function failBaseItemDelete(database, itemId, message) {
  const functionName = `${q(database.schemaName)}.test_delete_failure`;
  await database.client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${nativeTextSql(database.schemaName).guidKey('OLD."Id"')} = TG_ARGV[0] THEN
        RAISE EXCEPTION '%', TG_ARGV[1];
      END IF;
      RETURN OLD;
    END $$`);
  await database.client.query(`CREATE TRIGGER test_delete_failure BEFORE DELETE ON "BaseItems"
    FOR EACH ROW EXECUTE FUNCTION ${functionName}(${literal(idKey(itemId))}, ${literal(message)})`);
  return async () => {
    await database.client.query('DROP TRIGGER test_delete_failure ON "BaseItems"');
    await database.client.query(`DROP FUNCTION ${functionName}()`);
  };
}

/** Observe repository deletion attempts, including bulk SQL used by PostgreSQL. */
export function observeBaseItemDeletes(database, record) {
  const query = database.client.query.bind(database.client);
  database.client.query = (...args) => {
    const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (/\bDELETE FROM\s+(?:"[^"]+"\.)?"BaseItems"(?:\s|$)/u.test(statement)) {
      const values = typeof args[0] === 'string' ? args[1] : args[0].values;
      record(Array.isArray(values[0]) ? values[0] : [values[0]]);
    }
    return query(...args);
  };
}
