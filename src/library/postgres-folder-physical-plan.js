import path from 'node:path';
import { quoteIdentifier as q } from '../database/model.js';
import { nativeTextBytes } from '../database/native-text.js';
import { nativeTextSql } from '../database/native-text-sql.js';
import { nonemptyId } from './records.js';
import { nativeItemTypes, nativeItemDescriptor } from './native-item-entity.js';
import { nativeContainsSubPath } from './native-path.js';

const plan = (text, values = []) => Object.freeze({ text, values: Object.freeze(values) });
const encoded = value => value == null ? null : nativeTextBytes(value);
const folders = nativeItemTypes.filter(value => nativeItemDescriptor(value).family === 'folder').map(nativeTextBytes);

export async function physicalPlan(session, parent, recursive, { linkedChildren, library }) {
  const sql = nativeTextSql(session.schemaName), items = `${q(session.schemaName)}."BaseItems"`;
  const dataPath=library.options.dataPath??(library.options.programDataPath&&path.join(library.options.programDataPath,'data'));
  const empty=()=>plan('SELECT NULL::bytea AS "Id", 0::bigint AS "Ordinal" WHERE FALSE');
  if(parent.Type==='Playlist')return empty();
  if(parent.Type==='BoxSet'&&(!parent.Path||await linkedChildren.count(parent.LinkedChildren)>0n||dataPath&&nativeContainsSubPath(parent.Path,dataPath)))return empty();
  const values = [encoded(parent.Id), folders, encoded(dataPath), encoded('MediaBrowser.Controller.Entities.Movies.BoxSet'), encoded('MediaBrowser.Controller.Playlists.Playlist')];
  const present = expression => `${expression} IS NOT NULL AND octet_length(${expression})>0 AND ${sql.guidKey(expression)}<>'00000000000000000000000000000000'`;
  const visible = alias => `(NOT (${present(`${alias}."OwnerId"`)}) OR ${alias}."ExtraType" IS NOT NULL)
    AND (NOT (${present(`${alias}."PrimaryVersionId"`)}) OR NOT EXISTS(SELECT 1 FROM ${items} primary_item
      WHERE ${sql.guidKey('primary_item."Id"')}=${sql.guidKey(`${alias}."PrimaryVersionId"`)}
        AND ${sql.guidKey('primary_item."TopParentId"')} IS NOT DISTINCT FROM ${sql.guidKey(`${alias}."TopParentId"`)}))`;
  if (parent.Type === 'MusicArtist' && !nonemptyId(parent.ParentId)) return plan('SELECT NULL::bytea AS "Id", 0::bigint AS "Ordinal" WHERE FALSE');
  const ordered = `ordered AS (SELECT item.*, row_number() OVER(PARTITION BY ${sql.guidKey('item."ParentId"')}
    ORDER BY item."SortName" ASC NULLS FIRST,item."Id") AS position FROM ${items} item WHERE ${visible('item')})`;
  if (!recursive) return plan(`WITH ${ordered} SELECT "Id",position AS "Ordinal" FROM ordered
    WHERE ${sql.guidKey('"ParentId"')}=${sql.guidKey('$1::bytea')} ORDER BY position`, values.slice(0, 1));
  return plan(`WITH RECURSIVE ${ordered}, walk AS (
    SELECT item."Id",item."Type",ARRAY[item.position] AS path,ARRAY[${sql.guidKey('$1::bytea')},${sql.guidKey('item."Id"')}] AS seen,
      ${sql.guidKey('item."Id"')}=${sql.guidKey('$1::bytea')} AS cycle
    FROM ordered item WHERE ${sql.guidKey('item."ParentId"')}=${sql.guidKey('$1::bytea')}
    UNION ALL SELECT item."Id",item."Type",walk.path||item.position,walk.seen||${sql.guidKey('item."Id"')},
      ${sql.guidKey('item."Id"')}=ANY(walk.seen) AS cycle
    FROM walk JOIN ordered item ON ${sql.guidKey('item."ParentId"')}=${sql.guidKey('walk."Id"')}
    WHERE NOT walk.cycle AND walk."Type"=ANY($2::bytea[]) AND walk."Type"<>$5::bytea
      AND (walk."Type"<>$4::bytea OR EXISTS(SELECT 1 FROM ordered container WHERE container."Id"=walk."Id"
        AND container."Path" IS NOT NULL AND octet_length(container."Path")>0
        AND NOT EXISTS(SELECT 1 FROM ${q(session.schemaName)}."LinkedChildren" link WHERE ${sql.guidKey('link."ParentId"')}=${sql.guidKey('container."Id"')})
        AND ($3::bytea IS NULL OR NOT (octet_length(${sql.ordinalIgnoreCaseKey('container."Path"')})>octet_length(${sql.ordinalIgnoreCaseKey('$3::bytea')})
          AND substring(${sql.ordinalIgnoreCaseKey('container."Path"')} from 1 for octet_length(${sql.ordinalIgnoreCaseKey('$3::bytea')}))=${sql.ordinalIgnoreCaseKey('$3::bytea')}
          AND substring(${sql.ordinalIgnoreCaseKey('container."Path"')} from octet_length(${sql.ordinalIgnoreCaseKey('$3::bytea')})+1 for 2)=ANY(ARRAY[decode('002f','hex'),decode('005c','hex')])))))
  ) SELECT "Id",row_number() OVER(ORDER BY path) AS "Ordinal",cycle FROM walk ORDER BY path`, values);
}

