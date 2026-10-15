import { nativeTextSql } from './native-text-sql.js';

const postgresEmptyGuidKey = '00000000000000000000000000000000';

// CLR integer format strings specify a minimum width, while PostgreSQL lpad
// truncates to its requested width. Widen before abs to support Int32.MinValue.
export function postgresSignedPaddedInteger(expression, width) {
  const digits = `abs((${expression})::bigint)::text`;
  return `(CASE WHEN ${expression} < 0 THEN '-' ELSE '' END || lpad(${digits}, greatest(${width}, length(${digits})), '0'))`;
}

export function postgresVersionFamilyKey(schema, idExpression, primaryVersionIdExpression) {
  if (typeof idExpression !== 'string' || !idExpression
    || typeof primaryVersionIdExpression !== 'string' || !primaryVersionIdExpression) {
    throw new TypeError('PostgreSQL version-family expressions are required');
  }
  const text = nativeTextSql(schema);
  return `CASE WHEN ${primaryVersionIdExpression} IS NULL OR ${text.guidKey(primaryVersionIdExpression)} = '${postgresEmptyGuidKey}' THEN ${text.guidKey(idExpression)} ELSE ${text.guidKey(primaryVersionIdExpression)} END`;
}

export function postgresAliasedVersionFamilyKey(schema, alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias ?? '')) {
    throw new TypeError('A safe PostgreSQL table alias is required');
  }
  return postgresVersionFamilyKey(schema, `${alias}."Id"`, `${alias}."PrimaryVersionId"`);
}
