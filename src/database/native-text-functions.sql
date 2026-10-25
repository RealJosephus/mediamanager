CREATE FUNCTION mm_bytes_text_projection(source bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT convert_from(decode(COALESCE(string_agg(CASE byte[1]
    WHEN '00' THEN '0130' WHEN '01' THEN '0131' ELSE byte[1] END, '' ORDER BY ordinal), ''), 'hex'), 'UTF8')
  FROM regexp_matches(encode(source, 'hex'), '..', 'g') WITH ORDINALITY bytes(byte, ordinal)
$$;

CREATE FUNCTION mm_native_guid_lower(source bytea) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT lower(mm_bytes_text_projection(source)) $$;

CREATE FUNCTION mm_native_guid_lower(source text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT lower(source) $$;

CREATE FUNCTION mm_text_utf8_key(source text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result bytea := ''::bytea; position integer := 1; character text; escape text;
BEGIN
  WHILE position <= char_length(source) LOOP
    character := substring(source FROM position FOR 1); position := position + 1;
    IF character = chr(1) THEN
      escape := substring(source FROM position FOR 1); position := position + 1;
      IF escape = '0' THEN result := result || decode('00', 'hex');
      ELSIF escape = '1' THEN result := result || decode('01', 'hex');
      ELSE RAISE EXCEPTION 'Non-canonical native text escape' USING ERRCODE='22023'; END IF;
    ELSE result := result || convert_to(character, 'UTF8'); END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION mm_projected_utf16_key(source text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result bytea := ''::bytea; position integer := 1; code integer; escape text; high integer; low integer;
BEGIN
  WHILE position <= char_length(source) LOOP
    code := ascii(substring(source FROM position FOR 1)); position := position + 1;
    IF code = 1 THEN
      escape := substring(source FROM position FOR 1); position := position + 1;
      IF escape = '0' THEN code := 0;
      ELSIF escape = '1' THEN code := 1;
      ELSE RAISE EXCEPTION 'Non-canonical native text escape' USING ERRCODE='22023'; END IF;
    END IF;
    IF code > 65535 THEN
      high := 55296 + ((code - 65536) >> 10); low := 56320 + ((code - 65536) & 1023);
      result := result || decode(lpad(to_hex(high), 4, '0') || lpad(to_hex(low), 4, '0'), 'hex');
    ELSE result := result || decode(lpad(to_hex(code), 4, '0'), 'hex'); END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION mm_text_utf16_key(source bytea) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT mm_projected_utf16_key(mm_bytes_text_projection(source)) $$;

CREATE FUNCTION mm_text_utf16_key(source text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT mm_text_utf16_key(mm_text_utf8_key(source)) $$;

-- SQLite LIKE consumes its text up to the first NUL; this is a consumer
-- projection, never a storage decoder or a general string truncation rule.
CREATE FUNCTION mm_projected_sqlite_like_prefix(source text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result text := ''; position integer := 1; character text; escape text;
BEGIN
  WHILE position <= char_length(source) LOOP
    character := substring(source FROM position FOR 1); position := position + 1;
    IF character = chr(1) THEN
      escape := substring(source FROM position FOR 1); position := position + 1;
      IF escape = '0' THEN RETURN result;
      ELSIF escape <> '1' THEN RAISE EXCEPTION 'Non-canonical native text escape' USING ERRCODE='22023'; END IF;
    END IF;
    result := result || character;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION mm_projected_sqlite_like(source text, pattern text, escape_character text DEFAULT '') RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT translate(mm_projected_sqlite_like_prefix(source), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
    LIKE translate(mm_projected_sqlite_like_prefix(pattern), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
    ESCAPE escape_character
$$;

CREATE FUNCTION mm_text_sqlite_like(source bytea, pattern bytea, escape_character text DEFAULT '') RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT mm_projected_sqlite_like(mm_bytes_text_projection(source), mm_bytes_text_projection(pattern), escape_character)
$$;

-- NumberStyles.Integer parsing used by parental-rating numeric branches.
CREATE FUNCTION mm_projected_int32(source text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE value text := source;
BEGIN
  WHILE right(value, 2) = chr(1) || '0' LOOP value := left(value, char_length(value) - 2); END LOOP;
  value := btrim(value, chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||' ');
  IF value !~ '^[+-]?[0-9]+$' THEN RETURN NULL; END IF;
  BEGIN RETURN value::integer; EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL; END;
END $$;

CREATE FUNCTION mm_text_int32(source bytea) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT mm_projected_int32(mm_bytes_text_projection(source)) $$;

CREATE FUNCTION mm_json_string_text(token text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result text := ''; position integer := 2; ending integer := char_length(token);
  character text; escape text; digits text; code integer; low integer;
BEGIN
  IF left(token, 1) <> '"' OR right(token, 1) <> '"' THEN RAISE EXCEPTION 'Invalid JSON string'; END IF;
  WHILE position < ending LOOP
    character := substring(token FROM position FOR 1); position := position + 1;
    IF ascii(character) < 32 THEN RAISE EXCEPTION 'Unescaped JSON control character'; END IF;
    IF character = E'\\' THEN
      escape := substring(token FROM position FOR 1); position := position + 1;
      IF escape = 'u' THEN
        digits := substring(token FROM position FOR 4); position := position + 4;
        IF digits !~ '^[0-9A-Fa-f]{4}$' THEN RAISE EXCEPTION 'Invalid JSON Unicode escape'; END IF;
        code := ('x' || digits)::bit(16)::integer;
        IF code BETWEEN 55296 AND 56319 THEN
          IF substring(token FROM position FOR 2) <> E'\\u' THEN RAISE EXCEPTION 'Unpaired JSON surrogate'; END IF;
          digits := substring(token FROM position + 2 FOR 4); position := position + 6;
          IF digits !~ '^[0-9A-Fa-f]{4}$' THEN RAISE EXCEPTION 'Invalid JSON Unicode escape'; END IF;
          low := ('x' || digits)::bit(16)::integer;
          IF low NOT BETWEEN 56320 AND 57343 THEN RAISE EXCEPTION 'Unpaired JSON surrogate'; END IF;
          code := 65536 + ((code - 55296) << 10) + low - 56320;
        ELSIF code BETWEEN 56320 AND 57343 THEN RAISE EXCEPTION 'Unpaired JSON surrogate'; END IF;
        IF code = 0 THEN result := result || chr(1) || '0';
        ELSIF code = 1 THEN result := result || chr(1) || '1';
        ELSE result := result || chr(code); END IF;
      ELSIF escape = 'b' THEN result := result || chr(8);
      ELSIF escape = 'f' THEN result := result || chr(12);
      ELSIF escape = 'n' THEN result := result || chr(10);
      ELSIF escape = 'r' THEN result := result || chr(13);
      ELSIF escape = 't' THEN result := result || chr(9);
      ELSIF escape IN ('"', E'\\', '/') THEN result := result || escape;
      ELSE RAISE EXCEPTION 'Invalid JSON escape'; END IF;
    ELSE result := result || character; END IF;
    IF position > ending THEN RAISE EXCEPTION 'Incomplete JSON escape'; END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION mm_text_json_projection(source bytea) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN RETURN mm_projected_json(mm_bytes_text_projection(source));
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

-- Produce a derived JSON view whose keys and string leaves use the same
-- canonical text codec. Original Data is retained separately, byte for byte.
-- Every lexical string is rewritten, including unknown keys and nested leaves;
-- duplicate keys, order and number token spelling survive in PostgreSQL json.
CREATE FUNCTION mm_projected_json(source text) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result text := ''; position integer := 1; starting integer; character text;
  escaped boolean; closed boolean; token text;
BEGIN
  WHILE position <= char_length(source) LOOP
    character := substring(source FROM position FOR 1);
    IF character <> '"' THEN result := result || character; position := position + 1; CONTINUE; END IF;
    starting := position; position := position + 1; escaped := false; closed := false;
    WHILE position <= char_length(source) LOOP
      character := substring(source FROM position FOR 1); position := position + 1;
      IF escaped THEN escaped := false;
      ELSIF character = E'\\' THEN escaped := true;
      ELSIF character = '"' THEN closed := true; EXIT; END IF;
    END LOOP;
    IF NOT closed THEN RAISE EXCEPTION 'Incomplete JSON string'; END IF;
    token := substring(source FROM starting FOR position - starting);
    result := result || to_json(mm_json_string_text(token))::text;
  END LOOP;
  RETURN result::json;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE FUNCTION mm_native_ascii_lower(source bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result bytea := source; position integer; value integer;
BEGIN
  IF octet_length(source) = 0 THEN RETURN result; END IF;
  FOR position IN 0..octet_length(source) - 1 LOOP
    value := get_byte(source, position);
    IF value BETWEEN 65 AND 90 THEN result := set_byte(result, position, value + 32); END IF;
  END LOOP;
  RETURN result;
END $$;

-- The argument is a canonical projection, not ordinary JSON. Its string
-- leaves encode NUL as SOH+'0' and literal SOH as SOH+'1'. Decoding restores
-- the authoritative bytes without sending NUL through PostgreSQL text.
CREATE FUNCTION mm_native_json_text_bytes(source json, property_name text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
  IF json_typeof(source -> property_name) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  RETURN mm_text_utf8_key(source ->> property_name);
END $$;

-- Consume one CLR string character at a time from a canonical SQL projection.
-- Escaped NUL/SOH are single characters; their ASCII escape suffix is not data.
CREATE FUNCTION mm_projected_text_characters(source text) RETURNS TABLE(part text, codepoint integer)
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE position integer := 1; escape text;
BEGIN
  WHILE position <= char_length(source) LOOP
    part := substring(source FROM position FOR 1); position := position + 1;
    codepoint := ascii(part);
    IF codepoint = 1 THEN
      escape := substring(source FROM position FOR 1); position := position + 1;
      IF escape = '0' THEN codepoint := 0;
      ELSIF escape = '1' THEN codepoint := 1;
      ELSE RAISE EXCEPTION 'Non-canonical native text escape' USING ERRCODE='22023'; END IF;
      part := part || escape;
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
