// Inputs are shared by the frozen DLL recorder and the HTTP replay scenario.
export function userDataBindingCases() {
  const cases = [
    ['empty-object', '{}'], ['null-root', 'null'], ['array-root', '[]'], ['number-root', '1'], ['string-root', '"text"'],
    ['unknown-fields', '{"Unknown":{"PlayCount":false},"Other":[null,{}]}'],
    ['all-fields', '{"Rating":8.5,"PlayedPercentage":15.25,"UnplayedItemCount":3,"PlaybackPositionTicks":9007199254740993,"PlayCount":2,"IsFavorite":true,"Likes":false,"LastPlayedDate":"2026-09-27T12:34:56.1234567+05:30","Played":true,"Key":1e3,"ItemId":false}'],
    ['duplicate-invalid-first', '{"PlayCount":false,"playCount":1}'],
    ['duplicate-valid-last', '{"PlayCount":1,"playCount":2}'],
    ['escaped-property', '{"Play\\u0043ount":"3"}'],
    ['utf8-error', '{"ignored":"中文","PlayCount":false}']
  ];
  const tokens = ['null', '""', '" "', 'true', 'false', '0', '1', '-1', '1.5', '1e2', '"2"', '"+2"', '" 2 "', '"true"', '"NaN"', '"Infinity"', '{}', '[]'];
  for (const field of ['Rating', 'PlayedPercentage', 'UnplayedItemCount', 'PlaybackPositionTicks', 'PlayCount', 'IsFavorite', 'Likes', 'LastPlayedDate', 'Played', 'Key', 'ItemId']) {
    for (let index = 0; index < tokens.length; index++) cases.push([`${field}-${index}`, `{"${field}":${tokens[index]}}`]);
  }
  for (const field of ['Rating', 'PlayedPercentage']) {
    for (const token of ['1e309', '-1e309', '"1e309"', '"-Infinity"', '"nan"', '"+1.5"', '"01.5"', '"1."', '".5"', '"0x10"', '" 1.5"', '"1.5 "', '-0', '"-0"', '5e-324', '2.2250738585072014e-308', '"1e-4000"']) cases.push([`${field}-boundary-${cases.length}`, `{"${field}":${token}}`]);
  }
  for (const field of ['PlayCount', 'UnplayedItemCount', 'PlaybackPositionTicks']) {
    for (const token of ['2147483647', '2147483648', '-2147483648', '-2147483649', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809', '"01"', '"+1"', '"1e2"']) cases.push([`${field}-boundary-${cases.length}`, `{"${field}":${token}}`]);
  }
  for (const date of ['2026-09-27', '2026-09-27T12:34', '2026-09-27T12:34:56', '2026-09-27T12:34:56.0000001', '2026-09-27T12:34:56.1234567890123456Z', '2026-09-27T12:34:56.12345678901234567Z', '2026-09-27T12:34:56.Z', '2026-09-27T12:34:56+08', '2026-09-27T12:34:56.1234567-05:30', '2026-02-30T00:00:00Z', '2026-09-27t12:34:56Z', '2026-09-27 12:34:56', '2026-09-27T24:00:00Z', '2026-09-27T12:34:56+14:01', '0001-01-01T00:00:00', '0001-01-01T00:00:00Z', '0001-01-01T00:00:00+14:00', '9999-12-31T23:59:59.9999999Z', '9999-12-31T23:59:59.9999999+00:00', '1990-07-01T12:00:00+00:00', '1900-01-01T12:00:00', 'bad']) cases.push([`date-${cases.length}`, JSON.stringify({ LastPlayedDate: date })]);
  return cases.map(([name, source]) => ({ name, source }));
}
