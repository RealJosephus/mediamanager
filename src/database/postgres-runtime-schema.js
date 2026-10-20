import { createHash } from 'node:crypto';
import { qualifyNativeTextSql } from './native-text-functions.js';
import { quoteIdentifier as q } from './model.js';
import invariantCharUpperMapping from '../core/resources/invariant-char-upper.json' with { type: 'json' };
import invariantLowerMapping from '../core/resources/invariant-lower.json' with { type: 'json' };
import unicodeLetterNumberRangeBoundsResource from '../core/resources/unicode-letter-number-ranges.json' with { type: 'json' };
import ordinalIgnoreCaseMapping from '../storage/resources/ordinal-ignore-case.json' with { type: 'json' };
import diacriticsMapping from '../sessions/resources/diacritics.json' with { type: 'json' };
import { postgresVersionFamilyKey } from './postgres-query-expressions.js';
import { nativeItemJsonValidationManifest } from '../library/native-item-data.js';
import { clrWhitespaceCharacters, ecmaWhitespaceCharacters } from '../metadata/whitespace.js';
import { loadLocalizationData } from '../core/localization-data.js';

const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const WINDOWS_NATIVE_PATH_PATTERN = String.raw`^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)`;
const WINDOWS_SEPARATOR_PATTERN = String.raw`\\+`;
const sqlLiteral = value => `'${value.replaceAll("'", "''")}'`;

function translateMapping(mapping, name) {
  const entries = Object.entries(mapping);
  if (entries.some(([source, target]) => [...source].length !== 1 || [...target].length !== 1)) {
    throw new Error(`The ${name} resource must contain one-code-point mappings for PostgreSQL translate`);
  }
  return Object.freeze({
    from: entries.map(([source]) => source).join(''),
    to: entries.map(([, target]) => target).join(''),
  });
}
function fixedRangeBounds(bounds, name) {
  if (!Array.isArray(bounds) || bounds.length === 0 || bounds.length % 2 !== 0) {
    throw new Error(`The ${name} resource must contain start/end pairs`);
  }
  for (let index = 0; index < bounds.length; index += 2) {
    const start = bounds[index];
    const end = bounds[index + 1];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > 0x110000
      || (index > 0 && bounds[index - 1] >= start)) {
      throw new Error(`The ${name} resource must contain ordered, disjoint, maximally joined Unicode ranges`);
    }
  }
  return Object.freeze([...bounds]);
}
const invariantLowerTranslate = translateMapping(invariantLowerMapping, 'invariant-lower');
const invariantCharUpperTranslate = translateMapping(invariantCharUpperMapping, 'invariant-char-upper');
const ordinalIgnoreCaseTranslate = translateMapping(ordinalIgnoreCaseMapping, 'ordinal-ignore-case');
let nativeItemDataValidationManifest;
function itemDataValidationManifest() {
  return nativeItemDataValidationManifest ??= nativeItemJsonValidationManifest();
}
const unicodeLetterNumberRangeBounds = fixedRangeBounds(
  unicodeLetterNumberRangeBoundsResource, 'unicode-letter-number-ranges');

const index = (name, table, keys, where) => Object.freeze({ name, table, keys, where });
const normalizedGuid = column => `(replace(mm_native_guid_lower(${q(column)}), '-', ''))`;

export const postgresNativePathKeyFunctionName = 'mm_native_path_key';
export const postgresInvariantLowerFunctionName = 'mm_invariant_lower';
export const postgresInvariantCharUpperFunctionName = 'mm_invariant_char_upper';
export const postgresOrdinalIgnoreCaseKeyFunctionName = 'mm_ordinal_ignore_case_key';
export const postgresCleanValueFunctionName = 'mm_clean_value';
export const postgresRemoveDiacriticsFunctionName = 'mm_remove_diacritics';
export const postgresSafeNativeItemDataFunctionName = 'mm_safe_native_item_data';
export const postgresSafeInt32FunctionName = 'mm_safe_int32';
export const postgresNativeJsonEnumFunctionName = 'mm_native_json_enum';
export const postgresNativeJsonGuidKeyFunctionName = 'mm_native_json_guid_key';
export const postgresParentalRatingScoreFunctionName = 'mm_parental_rating_score';

const invariantLowerBody = `SELECT mm_text_utf8_key(pg_catalog.translate(mm_bytes_text_projection(source),
  ${sqlLiteral(invariantLowerTranslate.from)},
  ${sqlLiteral(invariantLowerTranslate.to)}))`;

const invariantCharUpperBody = `SELECT mm_text_utf8_key(pg_catalog.translate(mm_bytes_text_projection(source),
  ${sqlLiteral(invariantCharUpperTranslate.from)},
  ${sqlLiteral(invariantCharUpperTranslate.to)}))`;

const ordinalIgnoreCaseKeyBody = `SELECT mm_projected_utf16_key(pg_catalog.translate(mm_bytes_text_projection(source),
  ${sqlLiteral(ordinalIgnoreCaseTranslate.from)},
  ${sqlLiteral(ordinalIgnoreCaseTranslate.to)}))`;

// BaseItems.Data is an arbitrary TEXT boundary. This gate is generated from
// native-item-data's pinned contract and validates every occurrence of every
// known writable property before exposing any sibling value to relational SQL.
// PostgreSQL json (not jsonb) is intentional: it preserves duplicate keys in
// source order and retains numeric token spelling such as 1e2 versus 100.
let safeNativeItemDataBodyValue;
function safeNativeItemDataBody() {
  return safeNativeItemDataBodyValue ??= `
DECLARE
  native_type text := mm_bytes_text_projection(native_type_bytes);
  manifest CONSTANT jsonb := ${sqlLiteral(JSON.stringify(itemDataValidationManifest()))}::jsonb;
  trim_characters CONSTANT text := ${sqlLiteral(ecmaWhitespaceCharacters)};
  guid_trim_characters CONSTANT text := ${sqlLiteral(clrWhitespaceCharacters)};
  document json;
  validation_document json;
  contract jsonb;
  nested_contract jsonb;
  enum_values jsonb;
  spec jsonb;
  element_spec jsonb;
  occurrence record;
  element record;
  pending_values text[] := ARRAY[]::text[];
  pending_specs jsonb[] := ARRAY[]::jsonb[];
  pending_position integer := 1;
  value_text text;
  value_json json;
  value_type text;
  kind text;
  element_kind text;
  nullable boolean;
  scalar text;
  normalized text;
  enum_part text;
  integer_value integer;
  long_value bigint;
  double_value double precision;
  date_year integer;
  date_month integer;
  date_day integer;
  date_hour integer;
  date_minute integer;
  date_second integer;
  offset_hour integer;
  offset_minute integer;
  offset_direction integer;
  date_instant timestamp;
BEGIN
  BEGIN
    document := mm_text_json_projection(source_bytes);
    validation_document := document;
  EXCEPTION WHEN OTHERS THEN
    RETURN '{}'::json;
  END;
  IF pg_catalog.json_typeof(document) IS DISTINCT FROM 'object' THEN
    RETURN '{}'::json;
  END IF;
  contract := manifest -> 'contracts' -> native_type;
  IF contract IS NULL THEN
    RETURN '{}'::json;
  END IF;

  FOR occurrence IN SELECT entry.key, entry.value
    FROM pg_catalog.json_each(validation_document) AS entry LOOP
    spec := contract -> occurrence.key;
    IF spec IS NOT NULL THEN
      pending_values := pg_catalog.array_append(pending_values, occurrence.value::text);
      pending_specs := pg_catalog.array_append(pending_specs, spec);
    END IF;
  END LOOP;

  WHILE pending_position <= COALESCE(pg_catalog.cardinality(pending_values), 0) LOOP
    value_text := pending_values[pending_position];
    spec := pending_specs[pending_position];
    pending_position := pending_position + 1;
    value_json := value_text::json;
    value_type := pg_catalog.json_typeof(value_json);
    kind := spec ->> 'kind';
    nullable := COALESCE((spec ->> 'nullable')::boolean, false);

    IF value_type = 'null' THEN
      IF nullable OR kind = 'string' OR pg_catalog.right(kind, 2) = '[]' OR kind = 'guid' THEN
        CONTINUE;
      END IF;
      RETURN '{}'::json;
    END IF;

    scalar := CASE WHEN value_type IN ('string', 'number', 'boolean')
      THEN value_json #>> '{}' ELSE NULL END;
    IF nullable AND value_type = 'string' AND scalar = ''
      AND kind <> 'string' AND kind <> 'guid' AND pg_catalog.right(kind, 2) <> '[]' THEN
      CONTINUE;
    END IF;

    IF pg_catalog.right(kind, 2) = '[]' THEN
      IF value_type <> 'array' THEN
        RETURN '{}'::json;
      END IF;
      element_kind := pg_catalog.left(kind, pg_catalog.char_length(kind) - 2);
      element_spec := pg_catalog.jsonb_build_object('kind', element_kind, 'nullable',
        element_kind IN ('string', 'entity') OR (manifest -> 'nested') ? element_kind);
      FOR element IN SELECT entry.value FROM pg_catalog.json_array_elements(value_json) AS entry LOOP
        pending_values := pg_catalog.array_append(pending_values, element.value::text);
        pending_specs := pg_catalog.array_append(pending_specs, element_spec);
      END LOOP;
      CONTINUE;
    END IF;

    nested_contract := manifest -> 'nested' -> kind;
    IF nested_contract IS NOT NULL THEN
      IF value_type <> 'object' THEN
        RETURN '{}'::json;
      END IF;
      FOR occurrence IN SELECT entry.key, entry.value
        FROM pg_catalog.json_each(value_json) AS entry LOOP
        spec := nested_contract -> occurrence.key;
        IF spec IS NOT NULL THEN
          pending_values := pg_catalog.array_append(pending_values, occurrence.value::text);
          pending_specs := pg_catalog.array_append(pending_specs, spec);
        END IF;
      END LOOP;
      CONTINUE;
    END IF;

    IF kind = 'string' THEN
      IF value_type NOT IN ('string', 'number', 'boolean') THEN
        RETURN '{}'::json;
      END IF;
      CONTINUE;
    ELSIF kind = 'bool' THEN
      IF value_type <> 'boolean' THEN
        RETURN '{}'::json;
      END IF;
      CONTINUE;
    ELSIF kind IN ('int', 'long', 'double') THEN
      IF value_type NOT IN ('string', 'number') OR scalar !~ (CASE WHEN value_type = 'string'
        THEN '^[+-]?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?$'
        ELSE '^-?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?$' END) THEN
        RETURN '{}'::json;
      END IF;
      IF kind IN ('int', 'long') AND scalar !~ (CASE WHEN value_type = 'string'
        THEN '^[+-]?[0-9]+$' ELSE '^-?[0-9]+$' END) THEN
        RETURN '{}'::json;
      END IF;
      BEGIN
        IF kind = 'int' THEN
          integer_value := scalar::integer;
        ELSIF kind = 'long' THEN
          long_value := scalar::bigint;
        ELSE
          double_value := scalar::double precision;
          IF double_value IN ('Infinity'::double precision, '-Infinity'::double precision) THEN
            RETURN '{}'::json;
          END IF;
        END IF;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN '{}'::json;
      END;
      CONTINUE;
    ELSIF kind = 'guid' THEN
      IF value_type <> 'string' THEN
        RETURN '{}'::json;
      END IF;
      normalized := pg_catalog.btrim(scalar, guid_trim_characters);
      IF normalized !~* '^[0-9a-f]{32}$'
        AND normalized !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND normalized !~* '^\\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\}$'
        AND normalized !~* '^\\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\)$'
        AND pg_catalog.translate(normalized, guid_trim_characters, '') !~* '^\\{0x0*[0-9a-f]{1,8},0x0*[0-9a-f]{1,8},0x0*[0-9a-f]{1,8},\\{0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2},0x0*[0-9a-f]{1,2}\\}\\}$' THEN
        RAISE EXCEPTION 'Invalid GUID in native item Data' USING ERRCODE = 'MM001';
      END IF;
      CONTINUE;
    ELSIF kind = 'date' THEN
      IF value_type <> 'string' OR scalar !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,16})?(?:Z|[+-][0-9]{2}:[0-9]{2})?$' THEN
        RETURN '{}'::json;
      END IF;
      date_year := pg_catalog.substr(scalar, 1, 4)::integer;
      date_month := pg_catalog.substr(scalar, 6, 2)::integer;
      date_day := pg_catalog.substr(scalar, 9, 2)::integer;
      date_hour := pg_catalog.substr(scalar, 12, 2)::integer;
      date_minute := pg_catalog.substr(scalar, 15, 2)::integer;
      date_second := pg_catalog.substr(scalar, 18, 2)::integer;
      IF date_year < 1 OR date_hour > 23 OR date_minute > 59 OR date_second > 59 THEN
        RETURN '{}'::json;
      END IF;
      BEGIN
        PERFORM pg_catalog.make_date(date_year, date_month, date_day);
        date_instant := pg_catalog.make_timestamp(date_year, date_month, date_day,
          date_hour, date_minute, date_second);
      EXCEPTION WHEN OTHERS THEN
        RETURN '{}'::json;
      END;
      IF scalar ~ '[+-][0-9]{2}:[0-9]{2}$' THEN
        offset_hour := pg_catalog.substr(scalar, pg_catalog.char_length(scalar) - 4, 2)::integer;
        offset_minute := pg_catalog.right(scalar, 2)::integer;
        offset_direction := CASE pg_catalog.substr(scalar, pg_catalog.char_length(scalar) - 5, 1)
          WHEN '-' THEN -1 ELSE 1 END;
        IF offset_hour > 14 OR offset_minute > 59 OR offset_hour = 14 AND offset_minute <> 0 THEN
          RETURN '{}'::json;
        END IF;
        BEGIN
          date_instant := date_instant - pg_catalog.make_interval(
            mins => offset_direction * (offset_hour * 60 + offset_minute));
        EXCEPTION WHEN OTHERS THEN
          RETURN '{}'::json;
        END;
        IF pg_catalog.date_part('year', date_instant) NOT BETWEEN 1 AND 9999 THEN
          RETURN '{}'::json;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    enum_values := manifest -> 'enums' -> kind;
    IF enum_values IS NOT NULL THEN
      IF value_type = 'number' THEN
        IF scalar !~ '^-?[0-9]+$' THEN
          RETURN '{}'::json;
        END IF;
        BEGIN integer_value := scalar::integer;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN '{}'::json;
        END;
        CONTINUE;
      ELSIF value_type <> 'string' THEN
        RETURN '{}'::json;
      END IF;
      normalized := pg_catalog.btrim(scalar, trim_characters);
      IF normalized = '' THEN
        RETURN '{}'::json;
      END IF;
      FOR enum_part IN SELECT part FROM pg_catalog.regexp_split_to_table(normalized, ',') AS part LOOP
        enum_part := pg_catalog.btrim(enum_part, trim_characters);
        IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(enum_values) AS allowed(name)
            WHERE pg_catalog.translate(allowed.name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
              = pg_catalog.translate(enum_part, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')) THEN
          CONTINUE;
        END IF;
        IF enum_part !~ '^[+-]?[0-9]+$' THEN
          RETURN '{}'::json;
        END IF;
        BEGIN integer_value := enum_part::integer;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN '{}'::json;
        END;
      END LOOP;
      CONTINUE;
    END IF;

    RETURN '{}'::json;
  END LOOP;
  RETURN document;
EXCEPTION
  WHEN SQLSTATE 'MM001' THEN RAISE;
  WHEN OTHERS THEN RETURN '{}'::json;
END`;
}

const safeInt32Body = `
DECLARE source text := mm_bytes_text_projection(source_bytes);
BEGIN
  IF source !~ '^[+-]?[0-9]+$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN source::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN NULL;
  END;
END`;

let nativeJsonEnumBodyValue;
function nativeJsonEnumBody() {
  return nativeJsonEnumBodyValue ??= `
DECLARE
  enum_contracts CONSTANT jsonb := ${sqlLiteral(JSON.stringify(itemDataValidationManifest().enums))}::jsonb;
  trim_characters CONSTANT text := ${sqlLiteral(ecmaWhitespaceCharacters)};
  enum_values jsonb := enum_contracts -> enum_kind;
  value_type text := pg_catalog.json_typeof(source);
  scalar text;
  part text;
  canonical text;
  component integer;
  combined integer := 0;
BEGIN
  IF enum_values IS NULL OR value_type NOT IN ('string', 'number') THEN
    RETURN NULL;
  END IF;
  scalar := source #>> '{}';
  IF value_type = 'number' THEN
    IF scalar !~ '^-?[0-9]+$' THEN RETURN NULL; END IF;
    BEGIN combined := scalar::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
    END;
  ELSE
    scalar := pg_catalog.btrim(scalar, trim_characters);
    FOR part IN SELECT entry FROM pg_catalog.regexp_split_to_table(scalar, ',') AS entry LOOP
      part := pg_catalog.btrim(part, trim_characters);
      SELECT (allowed.ordinality - 1)::integer INTO component
      FROM pg_catalog.jsonb_array_elements_text(enum_values) WITH ORDINALITY AS allowed(name, ordinality)
      WHERE allowed.name IS NOT NULL
        AND pg_catalog.translate(allowed.name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
          = pg_catalog.translate(part, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      LIMIT 1;
      IF component IS NULL THEN
        IF part !~ '^[+-]?[0-9]+$' THEN RETURN NULL; END IF;
        BEGIN component := part::integer;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
        END;
      END IF;
      combined := combined | component;
      component := NULL;
    END LOOP;
  END IF;
  canonical := enum_values ->> combined;
  RETURN mm_text_utf8_key(COALESCE(canonical, combined::text));
END`;
}

const nativeJsonGuidKeyBody = `
DECLARE
  trim_characters CONSTANT text := ${sqlLiteral(clrWhitespaceCharacters)};
  scalar text;
  compact text;
  parts text[];
BEGIN
  IF pg_catalog.json_typeof(source) = 'null' THEN RETURN '00000000000000000000000000000000'; END IF;
  IF pg_catalog.json_typeof(source) <> 'string' THEN RETURN NULL; END IF;
  scalar := pg_catalog.btrim(source #>> '{}', trim_characters);
  IF scalar ~* '^[0-9a-f]{32}$' THEN
    RETURN pg_catalog.lower(scalar);
  END IF;
  IF scalar ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN pg_catalog.lower(pg_catalog.replace(scalar, '-', ''));
  END IF;
  IF scalar ~* '^\\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\}$'
    OR scalar ~* '^\\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\)$' THEN
    RETURN pg_catalog.lower(pg_catalog.replace(pg_catalog.substr(scalar, 2,
      pg_catalog.char_length(scalar) - 2), '-', ''));
  END IF;
  compact := pg_catalog.translate(scalar, trim_characters, '');
  parts := pg_catalog.regexp_match(compact,
    '^\\{0x(0*[0-9a-f]{1,8}),0x(0*[0-9a-f]{1,8}),0x(0*[0-9a-f]{1,8}),\\{0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2})\\}\\}$', 'i');
  IF parts IS NULL THEN
    RAISE EXCEPTION 'Invalid GUID in native item Data' USING ERRCODE = 'MM001';
  END IF;
  RETURN pg_catalog.lower(pg_catalog.lpad(pg_catalog.ltrim(parts[1], '0'), 8, '0')
    || pg_catalog.lpad(pg_catalog.right(pg_catalog.ltrim(parts[2], '0'), 4), 4, '0') || pg_catalog.lpad(pg_catalog.right(pg_catalog.ltrim(parts[3], '0'), 4), 4, '0')
    || pg_catalog.lpad(pg_catalog.ltrim(parts[4], '0'), 2, '0') || pg_catalog.lpad(pg_catalog.ltrim(parts[5], '0'), 2, '0')
    || pg_catalog.lpad(pg_catalog.ltrim(parts[6], '0'), 2, '0') || pg_catalog.lpad(pg_catalog.ltrim(parts[7], '0'), 2, '0')
    || pg_catalog.lpad(pg_catalog.ltrim(parts[8], '0'), 2, '0') || pg_catalog.lpad(pg_catalog.ltrim(parts[9], '0'), 2, '0')
    || pg_catalog.lpad(pg_catalog.ltrim(parts[10], '0'), 2, '0') || pg_catalog.lpad(pg_catalog.ltrim(parts[11], '0'), 2, '0'));
END`;

// LocalizationManager rating resolution is used by live in-memory item sorts
// and standalone BoxSet child visibility. Keep its fixed resource tables in
// the fingerprinted runtime function: database locale and an allow-list cannot
// reproduce prefix recursion, slash alternatives, or country sub-scores.
const parentalRatingResolver = loadLocalizationData().parentalRatingResolverData();
const parentalRatingScoreBody = `
DECLARE
  source text := mm_bytes_text_projection(source_bytes);
  resolver CONSTANT jsonb := ${sqlLiteral(JSON.stringify(parentalRatingResolver))}::jsonb;
  whitespace CONSTANT text := ${sqlLiteral(clrWhitespaceCharacters)};
  numeric_whitespace CONSTANT text := ${sqlLiteral('\u0009\u000a\u000b\u000c\u000d\u0020')};
  ordinal_from CONSTANT text := ${sqlLiteral(ordinalIgnoreCaseTranslate.from)};
  ordinal_to CONSTANT text := ${sqlLiteral(ordinalIgnoreCaseTranslate.to)};
  tasks jsonb[] := ARRAY[jsonb_build_object(
    'kind', 'get', 'rating', source, 'country', $2 -> 0, 'default', $2 -> 1)];
  task jsonb;
  task_count integer;
  task_kind text;
  raw_rating text;
  rating text;
  rating_key text;
  numeric_text text;
  numeric_score integer;
  current_country text;
  current_default text;
  selected_country text;
  country_text text;
  country_key text;
  resolved_country text;
  system_key text;
  system_values jsonb;
  rating_value jsonb;
  parts text[];
  part text;
  part_key text;
  part_index integer;
  separator text;
  first_position integer;
  last_position integer;
  country_part text;
  rating_part text;
BEGIN
  WHILE COALESCE(cardinality(tasks), 0) > 0 LOOP
    task_count := cardinality(tasks);
    task := tasks[task_count];
    tasks := tasks[1:task_count - 1];
    task_kind := task ->> 'kind';
    raw_rating := task ->> 'rating';
    current_country := task ->> 'country';
    current_default := task ->> 'default';

    IF task_kind = 'get' THEN
      IF raw_rating IS NULL OR raw_rating = '' THEN
        RAISE EXCEPTION 'Rating must not be empty.' USING ERRCODE = '22023';
      END IF;
      rating_key := translate(btrim(raw_rating, whitespace), ordinal_from, ordinal_to);
      IF rating_key IN ('N/A', 'UNRATED', 'NOT RATED', 'NR') THEN
        CONTINUE;
      END IF;

      -- getRatingScore tries the whole value first, then each nonempty slash
      -- part from left to right. Push in reverse because tasks is a LIFO stack.
      parts := ARRAY(
        SELECT btrim(value, whitespace)
        FROM unnest(string_to_array(raw_rating, '/')) WITH ORDINALITY AS split_parts(value, position)
        WHERE btrim(value, whitespace) <> ''
        ORDER BY position);
      IF cardinality(parts) > 1 THEN
        FOR part_index IN REVERSE cardinality(parts)..1 LOOP
          part := btrim(parts[part_index], whitespace);
          part_key := translate(part, ordinal_from, ordinal_to);
          IF part <> '' AND part_key NOT IN ('N/A', 'UNRATED', 'NOT RATED', 'NR') THEN
            tasks := array_append(tasks, jsonb_build_object(
              'kind', 'resolve', 'rating', part,
              'country', current_country, 'default', current_default));
          END IF;
        END LOOP;
      END IF;
      tasks := array_append(tasks, jsonb_build_object(
        'kind', 'resolve', 'rating', raw_rating,
        'country', current_country, 'default', current_default));
      CONTINUE;
    END IF;

    -- Int32.TryParse happens before Rated-prefix removal. Jellyfin removes
    -- every '+' only when it occurs at the literal end of the input.
    numeric_score := mm_projected_int32(regexp_replace(raw_rating, '\\++$', ''));
    IF numeric_score IS NOT NULL THEN
      RETURN ARRAY[numeric_score, NULL::integer];
    END IF;

    rating := btrim(replace(replace(replace(
      translate(raw_rating, ordinal_from, ordinal_to),
      'RATED :', ''), 'RATED:', ''), 'RATED ', ''), whitespace);
    rating_key := rating;
    selected_country := CASE WHEN current_country IS NOT NULL AND current_country <> ''
      THEN current_country ELSE current_default END;
    IF selected_country IS NULL THEN
      RAISE EXCEPTION 'Value cannot be null. (Parameter ''key'')' USING ERRCODE = '22004';
    END IF;

    country_key := translate(selected_country, ordinal_from, ordinal_to);
    system_values := resolver -> 'systems' -> country_key;
    rating_value := system_values -> rating_key;
    IF rating_value IS NOT NULL THEN
      RETURN ARRAY[(rating_value ->> 0)::integer,
        CASE WHEN jsonb_typeof(rating_value -> 1) = 'null' THEN NULL
          ELSE (rating_value ->> 1)::integer END];
    END IF;

    -- Native prefix stripping is available only for an explicitly nonempty
    -- countryCode. A default-country lookup does not enter this branch.
    country_text := COALESCE(current_country, current_default);
    IF current_country IS NOT NULL AND current_country <> ''
      AND char_length(rating) > char_length(country_text)
      AND translate(substring(rating FROM 1 FOR char_length(country_text)), ordinal_from, ordinal_to)
        = translate(country_text, ordinal_from, ordinal_to)
      AND substring(rating FROM char_length(country_text) + 1 FOR 1) IN ('-', ':') THEN
      rating_part := btrim(substring(rating FROM char_length(country_text) + 2), whitespace);
      rating_value := system_values -> rating_part;
      IF rating_value IS NOT NULL THEN
        RETURN ARRAY[(rating_value ->> 0)::integer,
          CASE WHEN jsonb_typeof(rating_value -> 1) = 'null' THEN NULL
            ELSE (rating_value ->> 1)::integer END];
      END IF;
    END IF;

    rating_value := resolver -> 'systems' -> 'US' -> rating_key;
    IF rating_value IS NOT NULL THEN
      RETURN ARRAY[(rating_value ->> 0)::integer,
        CASE WHEN jsonb_typeof(rating_value -> 1) = 'null' THEN NULL
          ELSE (rating_value ->> 1)::integer END];
    END IF;
    FOR system_key IN SELECT jsonb_array_elements_text(resolver -> 'order') LOOP
      rating_value := resolver -> 'systems' -> system_key -> rating_key;
      IF rating_value IS NOT NULL THEN
        RETURN ARRAY[(rating_value ->> 0)::integer,
          CASE WHEN jsonb_typeof(rating_value -> 1) = 'null' THEN NULL
            ELSE (rating_value ->> 1)::integer END];
      END IF;
    END LOOP;

    -- A recognized country/language prefix owns its suffix. An unknown prefix
    -- recursively evaluates the suffix with this resolver's captured default.
    FOREACH separator IN ARRAY ARRAY[':', '-']::text[] LOOP
      first_position := strpos(rating, separator);
      IF first_position = 0 THEN CONTINUE; END IF;
      last_position := char_length(rating) - strpos(reverse(rating), separator) + 1;
      country_part := btrim(substring(rating FROM 1 FOR first_position - 1), whitespace);
      rating_part := btrim(substring(rating FROM last_position + 1), whitespace);
      IF rating_part = '' THEN CONTINUE; END IF;
      country_key := translate(country_part, ordinal_from, ordinal_to);
      IF (resolver -> 'systems') ? country_key THEN
        resolved_country := country_key;
      ELSE
        resolved_country := resolver -> 'languages' ->> country_key;
      END IF;
      system_values := resolver -> 'systems' -> resolved_country;
      IF system_values IS NOT NULL THEN
        rating_value := system_values -> rating_part;
        IF rating_value IS NOT NULL THEN
          RETURN ARRAY[(rating_value ->> 0)::integer,
            CASE WHEN jsonb_typeof(rating_value -> 1) = 'null' THEN NULL
              ELSE (rating_value ->> 1)::integer END];
        END IF;
        numeric_score := mm_projected_int32(regexp_replace(rating_part, '\\++$', ''));
        IF numeric_score IS NOT NULL THEN
          RETURN ARRAY[numeric_score, NULL::integer];
        END IF;
      ELSE
        tasks := array_append(tasks, jsonb_build_object(
          'kind', 'get', 'rating', rating_part,
          'country', resolved_country, 'default', current_default));
      END IF;
      EXIT;
    END LOOP;
  END LOOP;
  RETURN NULL;
END`;

// This is the SQL equivalent of records.cleanValue. PostgreSQL's lower() and
// POSIX character classes depend on database locale, so both case folding and
// Unicode Letter/Number classification are embedded as fixed data.
const cleanValueBody = `
DECLARE
  source text := mm_bytes_text_projection(source_bytes);
  diacritic_map CONSTANT jsonb := ${sqlLiteral(JSON.stringify(diacriticsMapping))}::jsonb;
  letter_number_ranges CONSTANT integer[] := ARRAY[${unicodeLetterNumberRangeBounds.join(',')}];
  mapped_source text := '';
  part text;
  result text := '';
  has_trimmed_content boolean := false;
  pending_separator boolean := false;
  codepoint integer;
  low integer;
  high integer;
  middle integer;
  range_start integer;
  range_end integer;
  is_letter_or_number boolean;
BEGIN
  FOR part IN SELECT characters.part FROM mm_projected_text_characters(source) AS characters LOOP
    codepoint := pg_catalog.ascii(part);
    IF NOT (codepoint BETWEEN 9 AND 13 OR codepoint BETWEEN 8192 AND 8202
      OR codepoint IN (32, 133, 160, 5760, 8232, 8233, 8239, 8287, 12288)) THEN
      has_trimmed_content := true;
    END IF;
    mapped_source := mapped_source || COALESCE(diacritic_map ->> part, part);
  END LOOP;
  IF NOT has_trimmed_content THEN
    RETURN mm_text_utf8_key(source);
  END IF;
  mapped_source := pg_catalog.translate(mapped_source,
    ${sqlLiteral(invariantLowerTranslate.from)}, ${sqlLiteral(invariantLowerTranslate.to)});
  FOR part, codepoint IN SELECT characters.part, characters.codepoint FROM mm_projected_text_characters(mapped_source) AS characters LOOP
    low := 1;
    high := CASE WHEN codepoint > 65535 THEN 0 ELSE pg_catalog.cardinality(letter_number_ranges) / 2 END;
    is_letter_or_number := false;
    WHILE low <= high LOOP
      middle := (low + high) / 2;
      range_start := letter_number_ranges[middle * 2 - 1];
      range_end := letter_number_ranges[middle * 2];
      IF codepoint < range_start THEN
        high := middle - 1;
      ELSIF codepoint >= range_end THEN
        low := middle + 1;
      ELSE
        is_letter_or_number := true;
        EXIT;
      END IF;
    END LOOP;
    IF is_letter_or_number THEN
      IF pending_separator AND result <> '' THEN result := result || ' '; END IF;
      result := result || part;
      pending_separator := false;
    ELSE
      pending_separator := true;
    END IF;
  END LOOP;
  RETURN mm_text_utf8_key(result);
END`;

const nativePathKeyBody = `
DECLARE
  source text := mm_bytes_text_projection(source_bytes);
  windows boolean := source ~ ${sqlLiteral(WINDOWS_NATIVE_PATH_PATTERN)};
  normalized text;
  parts text[];
  path_root text;
  position integer;
  segment text;
  stack text[] := ARRAY[]::text[];
  relative boolean;
BEGIN
  IF source = '' THEN
    RETURN NULL;
  END IF;

  IF windows THEN
    normalized := replace(source, '/', chr(92));
    parts := regexp_split_to_array(normalized, ${sqlLiteral(WINDOWS_SEPARATOR_PATTERN)});
    IF substring(normalized, 2, 1) = ':' THEN
      path_root := substring(normalized, 1, 3);
      position := 2;
    ELSE
      path_root := chr(92) || chr(92) || parts[2] || chr(92) || parts[3] || chr(92);
      position := 4;
    END IF;
    WHILE position <= cardinality(parts) LOOP
      segment := parts[position];
      IF segment = '..' THEN
        IF cardinality(stack) > 0 THEN
          stack := stack[1:cardinality(stack) - 1];
        END IF;
      ELSIF segment <> '' AND segment <> '.' THEN
        stack := array_append(stack, segment);
      END IF;
      position := position + 1;
    END LOOP;
    RETURN mm_projected_utf16_key('windows' || chr(1) || '0' || translate(path_root || array_to_string(stack, chr(92)),
      ${sqlLiteral(ordinalIgnoreCaseTranslate.from)}, ${sqlLiteral(ordinalIgnoreCaseTranslate.to)}));
  END IF;

  parts := regexp_split_to_array(source, '/+');
  relative := left(source, 1) <> '/';
  path_root := CASE WHEN relative THEN '' ELSE '/' END;
  position := CASE WHEN relative THEN 1 ELSE 2 END;
  WHILE position <= cardinality(parts) LOOP
    segment := parts[position];
    IF segment = '..' THEN
      IF cardinality(stack) > 0 AND stack[cardinality(stack)] <> '..' THEN
        stack := stack[1:cardinality(stack) - 1];
      ELSIF relative THEN
        stack := array_append(stack, '..');
      END IF;
    ELSIF segment <> '' AND segment <> '.' THEN
      stack := array_append(stack, segment);
    END IF;
    position := position + 1;
  END LOOP;
  normalized := CASE
    WHEN path_root = '/' THEN path_root || array_to_string(stack, '/')
    WHEN cardinality(stack) = 0 THEN '.'
    ELSE array_to_string(stack, '/')
  END;
  RETURN mm_projected_utf16_key('posix' || chr(1) || '0' || normalized);
END`;

export const postgresRuntimeFunctions = Object.freeze([
  Object.freeze({ name: postgresRemoveDiacriticsFunctionName, inputTypes: 'bytea', resultType: 'bytea', language: 'sql',
    body: `SELECT mm_text_utf8_key(COALESCE(string_agg(COALESCE(${sqlLiteral(JSON.stringify(diacriticsMapping))}::jsonb ->> part, part), '' ORDER BY ordinal), ''))
      FROM mm_projected_text_characters(mm_bytes_text_projection(source)) WITH ORDINALITY AS characters(part, codepoint, ordinal)` }),
  Object.freeze({ name: postgresNativePathKeyFunctionName, inputTypes: 'bytea', parameters: 'source_bytes bytea', resultType: 'bytea', language: 'plpgsql', body: nativePathKeyBody }),
  Object.freeze({ name: postgresInvariantLowerFunctionName, inputTypes: 'bytea', resultType: 'bytea', language: 'sql', body: invariantLowerBody }),
  Object.freeze({ name: postgresInvariantCharUpperFunctionName, inputTypes: 'bytea', resultType: 'bytea', language: 'sql', body: invariantCharUpperBody }),
  Object.freeze({ name: postgresOrdinalIgnoreCaseKeyFunctionName, inputTypes: 'bytea', resultType: 'bytea', language: 'sql', body: ordinalIgnoreCaseKeyBody }),
  Object.freeze({ name: postgresCleanValueFunctionName, inputTypes: 'bytea', parameters: 'source_bytes bytea', resultType: 'bytea', language: 'plpgsql', body: cleanValueBody }),
  Object.freeze({ name: postgresSafeNativeItemDataFunctionName, inputTypes: 'bytea, bytea', parameters: 'native_type_bytes bytea, source_bytes bytea', resultType: 'json', language: 'plpgsql', get body() { return safeNativeItemDataBody(); } }),
  Object.freeze({ name: postgresSafeInt32FunctionName, inputTypes: 'bytea', parameters: 'source_bytes bytea', resultType: 'integer', language: 'plpgsql', body: safeInt32Body }),
  Object.freeze({ name: postgresNativeJsonEnumFunctionName, inputTypes: 'json, text', parameters: 'source json, enum_kind text', resultType: 'bytea', language: 'plpgsql', get body() { return nativeJsonEnumBody(); } }),
  Object.freeze({ name: postgresNativeJsonGuidKeyFunctionName, inputTypes: 'json', resultType: 'text', language: 'plpgsql', body: nativeJsonGuidKeyBody }),
  Object.freeze({ name: postgresParentalRatingScoreFunctionName, inputTypes: 'bytea, jsonb', parameters: 'source_bytes bytea, context jsonb', resultType: 'integer[]', language: 'plpgsql', body: parentalRatingScoreBody }),
  Object.freeze({ name: postgresOrdinalIgnoreCaseKeyFunctionName, inputTypes: 'text', resultType: 'bytea', language: 'sql', body: 'SELECT mm_ordinal_ignore_case_key(mm_text_utf8_key(source))' }),
  Object.freeze({ name: postgresNativePathKeyFunctionName, inputTypes: 'text', resultType: 'bytea', language: 'sql', body: 'SELECT mm_native_path_key(mm_text_utf8_key(source))' }),
  Object.freeze({ name: postgresSafeInt32FunctionName, inputTypes: 'text', resultType: 'integer', language: 'sql', body: 'SELECT mm_safe_int32(mm_text_utf8_key(source))' }),
]);

export const postgresRuntimeIndexes = Object.freeze([
  index('mm_runtime_baseitems_id_lower_idx', 'BaseItems', '(mm_native_guid_lower("Id"))'),
  index('mm_runtime_baseitems_parent_lower_sort_idx', 'BaseItems',
    '(mm_native_guid_lower("ParentId")), "SortName" ASC NULLS FIRST, "Id" ASC'),
  index('mm_runtime_baseitems_top_parent_lower_sort_idx', 'BaseItems',
    '(mm_native_guid_lower("TopParentId")), "SortName" ASC NULLS FIRST, "Id" ASC'),
  index('mm_runtime_baseitems_leaf_type_sort_idx', 'BaseItems',
    '(substring(mm_bytes_text_projection("Type") from \'[^.]+$\')), "SortName" ASC NULLS FIRST, "Id" ASC'),
  index('mm_runtime_baseitems_music_artist_name_invariant_idx', 'BaseItems',
    `(${postgresInvariantLowerFunctionName}("Name")), ("ParentId" IS NULL), `
      + '"SortName" ASC NULLS FIRST, "Id" ASC',
    'substring(mm_bytes_text_projection("Type") from \'[^.]+$\') = \'MusicArtist\''),
  index('mm_runtime_baseitems_media_type_sort_idx', 'BaseItems',
    '"MediaType", "SortName" ASC NULLS FIRST, "Id" ASC'),
  index('mm_runtime_baseitems_sort_idx', 'BaseItems',
    '"SortName" ASC NULLS FIRST, "Id" ASC'),
  index('mm_runtime_baseitems_normalized_sort_idx', 'BaseItems',
    `(mm_native_ascii_lower(COALESCE("SortName", ''::bytea)))`),
  index('mm_runtime_baseitems_series_presentation_idx', 'BaseItems',
    '"SeriesPresentationUniqueKey", "Id"'),
  index('mm_runtime_baseitems_version_family_idx', 'BaseItems',
    schema => `(${postgresVersionFamilyKey(schema, '"Id"', '"PrimaryVersionId"')})`),
  index('mm_runtime_baseitems_owner_lower_idx', 'BaseItems',
    '(mm_native_guid_lower("OwnerId")), (mm_native_guid_lower("Id"))', '"OwnerId" IS NOT NULL'),
  index('mm_runtime_baseitems_season_parent_lower_idx', 'BaseItems',
    '(mm_native_guid_lower(COALESCE("SeasonId", "ParentId"))), (mm_native_guid_lower("Id"))'),
  index('mm_runtime_ancestor_parent_item_lower_idx', 'AncestorIds',
    '(mm_native_guid_lower("ParentItemId")), (mm_native_guid_lower("ItemId"))'),
  index('mm_runtime_ancestor_item_parent_lower_idx', 'AncestorIds',
    '(mm_native_guid_lower("ItemId")), (mm_native_guid_lower("ParentItemId"))'),
  index('mm_runtime_item_values_map_item_value_lower_idx', 'ItemValuesMap',
    '(mm_native_guid_lower("ItemId")), (mm_native_guid_lower("ItemValueId"))'),
  index('mm_runtime_item_values_map_value_item_lower_idx', 'ItemValuesMap',
    '(mm_native_guid_lower("ItemValueId")), (mm_native_guid_lower("ItemId"))'),
  index('mm_runtime_item_values_map_value_item_raw_idx', 'ItemValuesMap',
    '"ItemValueId", "ItemId"'),
  index('mm_runtime_item_values_type_clean_id_lower_idx', 'ItemValues',
    '"Type", "CleanValue", (mm_native_guid_lower("ItemValueId"))'),
  index('mm_runtime_user_data_item_user_rating_lower_idx', 'UserData',
    '(mm_native_guid_lower("ItemId")), (mm_native_guid_lower("UserId")), "Rating"'),
  index('mm_runtime_search_history_user_item_idx', 'CustomItemDisplayPreferences',
    '"Client", "Key", (mm_native_guid_lower("UserId")), (mm_native_guid_lower("ItemId"))'),
  index('mm_runtime_user_data_user_resume_item_lower_idx', 'UserData',
    '(mm_native_guid_lower("UserId")), (mm_native_guid_lower("ItemId")), "LastPlayedDate" DESC NULLS LAST', '"PlaybackPositionTicks" > 0'),
  index('mm_runtime_user_data_user_played_item_lower_idx', 'UserData',
    '(mm_native_guid_lower("UserId")), (mm_native_guid_lower("ItemId")), "LastPlayedDate" DESC NULLS LAST', '"Played" IS TRUE'),
  index('mm_runtime_media_stream_item_type_language_lower_idx', 'MediaStreamInfos',
    '(mm_native_guid_lower("ItemId")), "StreamType", "Language"'),
  index('mm_runtime_linked_children_parent_child_lower_idx', 'LinkedChildren',
    '(mm_native_guid_lower("ParentId")), (mm_native_guid_lower("ChildId")), "ChildType"'),
  index('mm_runtime_linked_children_child_parent_lower_idx', 'LinkedChildren',
    '(mm_native_guid_lower("ChildId")), "ChildType", (mm_native_guid_lower("ParentId"))'),
  index('mm_runtime_providers_item_provider_ordinal_idx', 'BaseItemProviders',
    `(mm_native_guid_lower("ItemId")), (${postgresOrdinalIgnoreCaseKeyFunctionName}("ProviderId"))`),
  index('mm_runtime_providers_provider_value_ordinal_idx', 'BaseItemProviders',
    `(${postgresOrdinalIgnoreCaseKeyFunctionName}("ProviderId")), `
      + `(${postgresOrdinalIgnoreCaseKeyFunctionName}("ProviderValue")), (mm_native_guid_lower("ItemId"))`),
  index('mm_runtime_people_id_lower_idx', 'Peoples', '(mm_native_guid_lower("Id"))'),
  index('mm_runtime_people_name_type_invariant_idx', 'Peoples',
    `(${postgresInvariantLowerFunctionName}("Name")), "PersonType"`),
  index('mm_runtime_people_map_item_people_lower_idx', 'PeopleBaseItemMap',
    '(mm_native_guid_lower("ItemId")), (mm_native_guid_lower("PeopleId"))'),
  index('mm_runtime_people_map_people_item_lower_idx', 'PeopleBaseItemMap',
    '(mm_native_guid_lower("PeopleId")), (mm_native_guid_lower("ItemId"))'),
  index('mm_runtime_image_infos_item_type_lower_idx', 'BaseItemImageInfos',
    '(mm_native_guid_lower("ItemId")), "ImageType"'),
  index('mm_runtime_baseitems_native_path_key_idx', 'BaseItems',
    `(${postgresNativePathKeyFunctionName}("Path"))`),

  // Some production boundaries accept both Guid "D" and "N" text formats.
  // These expressions intentionally match those predicates byte-for-byte.
  index('mm_runtime_baseitems_id_normalized_idx', 'BaseItems',
    normalizedGuid('Id')),
  index('mm_runtime_baseitems_parent_normalized_sort_idx', 'BaseItems',
    `${normalizedGuid('ParentId')}, "SortName" ASC NULLS FIRST, "Id" ASC`),
  index('mm_runtime_baseitems_top_parent_normalized_sort_idx', 'BaseItems',
    `${normalizedGuid('TopParentId')}, "SortName" ASC NULLS FIRST, "Id" ASC`),
  index('mm_runtime_baseitems_owner_normalized_idx', 'BaseItems',
    `${normalizedGuid('OwnerId')}, ${normalizedGuid('Id')}`, '"OwnerId" IS NOT NULL'),
  index('mm_runtime_baseitems_primary_version_normalized_idx', 'BaseItems',
    `${normalizedGuid('PrimaryVersionId')}, ${normalizedGuid('TopParentId')}, ${normalizedGuid('Id')}`,
    '"PrimaryVersionId" IS NOT NULL'),
  index('mm_runtime_ancestor_parent_item_normalized_idx', 'AncestorIds',
    `${normalizedGuid('ParentItemId')}, ${normalizedGuid('ItemId')}`),
  index('mm_runtime_ancestor_item_parent_normalized_idx', 'AncestorIds',
    `${normalizedGuid('ItemId')}, ${normalizedGuid('ParentItemId')}`),
  index('mm_runtime_item_values_map_item_value_normalized_idx', 'ItemValuesMap',
    `${normalizedGuid('ItemId')}, ${normalizedGuid('ItemValueId')}`),
  index('mm_runtime_item_values_type_clean_id_normalized_idx', 'ItemValues',
    `"Type", "CleanValue", ${normalizedGuid('ItemValueId')}`),
  index('mm_runtime_user_data_item_user_rating_normalized_idx', 'UserData',
    `${normalizedGuid('ItemId')}, ${normalizedGuid('UserId')}, "Rating"`),
  index('mm_runtime_user_data_user_resume_item_normalized_idx', 'UserData',
    `${normalizedGuid('UserId')}, ${normalizedGuid('ItemId')}, "LastPlayedDate" DESC NULLS LAST`,
    '"PlaybackPositionTicks" > 0'),
  index('mm_runtime_user_data_user_played_item_normalized_idx', 'UserData',
    `${normalizedGuid('UserId')}, ${normalizedGuid('ItemId')}, "LastPlayedDate" DESC NULLS LAST`,
    '"Played" IS TRUE'),
  index('mm_runtime_media_stream_item_type_language_normalized_idx', 'MediaStreamInfos',
    `${normalizedGuid('ItemId')}, "StreamType", "Language"`),
  index('mm_runtime_image_infos_item_type_normalized_idx', 'BaseItemImageInfos',
    `${normalizedGuid('ItemId')}, "ImageType", "Id"`),
  index('mm_runtime_linked_children_parent_child_normalized_idx', 'LinkedChildren',
    `${normalizedGuid('ParentId')}, ${normalizedGuid('ChildId')}, "ChildType"`),
  index('mm_runtime_linked_children_child_parent_normalized_idx', 'LinkedChildren',
    `${normalizedGuid('ChildId')}, "ChildType", ${normalizedGuid('ParentId')}`),
]);

export const postgresRuntimeSchemaFingerprintKey = 'runtimeSchemaFingerprint';
export const postgresRuntimeIndexNames = Object.freeze(postgresRuntimeIndexes.map(entry => entry.name));

const runtimeIndexNameSet = new Set(postgresRuntimeIndexNames);
const runtimeFunctionIdentitySet = new Set(postgresRuntimeFunctions.map(entry => `${entry.name}(${entry.inputTypes})`));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createPostgresRuntimeFunctionSql(schema, definition) {
  if (!postgresRuntimeFunctions.includes(definition)) throw new TypeError('Unknown PostgreSQL runtime function definition');
  return `CREATE FUNCTION ${q(schema)}.${q(definition.name)}(${definition.parameters ?? `source ${definition.inputTypes}`})
RETURNS ${definition.resultType}
LANGUAGE ${definition.language}
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $mm_runtime_function$${qualifyRuntimeSql(schema, definition.body)}$mm_runtime_function$`;
}

export function createPostgresRuntimeIndexSql(schema, definition) {
  if (!postgresRuntimeIndexes.includes(definition)) throw new TypeError('Unknown PostgreSQL runtime index definition');
  return `CREATE INDEX ${q(definition.name)} ON ${q(schema)}.${q(definition.table)} (${qualifyRuntimeSql(schema, typeof definition.keys === 'function' ? definition.keys(schema) : definition.keys)})${definition.where ? ` WHERE ${qualifyRuntimeSql(schema, definition.where)}` : ''}`;
}

export function withoutPostgresRuntimeIndexes(snapshot) {
  return {
    ...snapshot,
    indices: snapshot.indices.filter(entry => !runtimeIndexNameSet.has(entry.indexname)),
    indexState: snapshot.indexState.filter(entry => !runtimeIndexNameSet.has(entry.index_name)),
    relations: snapshot.relations.filter(entry => !runtimeIndexNameSet.has(entry.relname)),
    functions: snapshot.functions.filter(entry => !runtimeFunctionIdentitySet.has(
      `${entry.function_name}(${entry.input_types})`)),
  };
}

export function postgresRuntimeSchemaFingerprint(snapshot) {
  const definitionsByName = new Map(postgresRuntimeIndexes.map(entry => [entry.name, entry]));
  const indices = snapshot.indices.filter(entry => runtimeIndexNameSet.has(entry.indexname));
  const indexState = snapshot.indexState.filter(entry => runtimeIndexNameSet.has(entry.index_name));
  const relations = snapshot.relations.filter(entry => runtimeIndexNameSet.has(entry.relname));
  const functions = snapshot.functions.filter(entry => runtimeFunctionIdentitySet.has(
    `${entry.function_name}(${entry.input_types})`));
  const found = new Set(indices.map(entry => entry.indexname));
  const missing = postgresRuntimeIndexNames.filter(name => !found.has(name));
  if (missing.length) throw new Error(`PostgreSQL runtime schema is missing indexes: ${missing.join(', ')}`);
  const foundFunctions = new Set(functions.map(entry => `${entry.function_name}(${entry.input_types})`));
  const missingFunctions = [...runtimeFunctionIdentitySet].filter(identity => !foundFunctions.has(identity));
  if (missingFunctions.length) {
    throw new Error(`PostgreSQL runtime schema is missing functions: ${missingFunctions.join(', ')}`);
  }
  if (indices.length !== postgresRuntimeIndexes.length
    || indexState.length !== postgresRuntimeIndexes.length
    || relations.length !== postgresRuntimeIndexes.length
    || functions.length !== postgresRuntimeFunctions.length) {
    throw new Error('PostgreSQL runtime schema contains duplicate or incomplete index metadata');
  }
  for (const entry of indices) {
    if (entry.tablename !== definitionsByName.get(entry.indexname).table) {
      throw new Error(`PostgreSQL runtime index ${entry.indexname} belongs to the wrong table`);
    }
  }
  for (const entry of indexState) {
    if (entry.table_name !== definitionsByName.get(entry.index_name).table
      || !entry.indisvalid || !entry.indisready || !entry.indislive) {
      throw new Error(`PostgreSQL runtime index ${entry.index_name} is not usable`);
    }
  }
  for (const entry of relations) {
    if (entry.relkind !== 'i') throw new Error(`PostgreSQL runtime index ${entry.relname} has an invalid relation type`);
  }
  for (const definition of postgresRuntimeFunctions) {
    const entry = functions.find(candidate => candidate.function_name === definition.name
      && candidate.input_types === definition.inputTypes);
    if (!entry) throw new Error(`PostgreSQL runtime schema is missing function: ${definition.name}(${definition.inputTypes})`);
    if (entry.result_type !== definition.resultType
      || entry.language !== definition.language
      || entry.volatility !== 'i'
      || !entry.is_strict
      || entry.security_definer
      || entry.leakproof
      || entry.parallel_safety !== 's'
      || entry.kind !== 'f'
      || !entry.executable
      || JSON.stringify(entry.configuration) !== JSON.stringify(['search_path=pg_catalog'])
      || entry.source !== qualifyRuntimeSql(snapshot.namespaces[0].nspname, definition.body)) {
      throw new Error(`PostgreSQL runtime function ${definition.name} is not the verified immutable definition`);
    }
  }
  return digest({ indices, indexState, relations, functions });
}

function qualifyRuntimeSql(schema, body) {
  body = qualifyNativeTextSql(schema, body);
  for (const definition of postgresRuntimeFunctions) {
    body = body.replaceAll(new RegExp('\\b' + definition.name + '\\(', 'g'), q(schema) + '.' + q(definition.name) + '(');
  }
  return body;
}
