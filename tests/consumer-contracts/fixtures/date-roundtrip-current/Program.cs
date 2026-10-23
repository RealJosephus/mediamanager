using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.Database.Providers.Sqlite.ValueConverters;
using MediaBrowser.Model.Dto;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var converter = new DateTimeKindValueConverter(DateTimeKind.Utc);
var observations = input.GetProperty("cases").EnumerateArray().Select(sample =>
{
    var source = JsonSerializer.Serialize(new { LastPlayedDate = sample.GetProperty("input").GetString(), PlayCount = 7 });
    var dto = JsonSerializer.Deserialize<UpdateUserItemDataDto>(source, JsonDefaults.Options)!;
    var date = dto.LastPlayedDate!.Value;
    var stored = (DateTime)converter.ConvertToProvider(date)!;
    var read = (DateTime)converter.ConvertFromProvider(stored)!;
    var wire = JsonSerializer.Serialize(read, JsonDefaults.Options);
    return new { name = sample.GetProperty("name").GetString(), source,
        stored = stored.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture),
        wire = JsonSerializer.Deserialize<string>(wire),
        diagnostics = new { kind = date.Kind.ToString(), localTimezone = TimeZoneInfo.Local.Id } };
}).ToArray();
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualExecution = true, inputSha256 = Hash(inputBytes),
    timezone = TimeZoneInfo.Local.Id, environmentTimezone = Environment.GetEnvironmentVariable("TZ"), observations,
    assemblies = new[] { typeof(JsonDefaults).Assembly, typeof(UpdateUserItemDataDto).Assembly,
        typeof(DateTimeKindValueConverter).Assembly }.Distinct().Select(assembly => new {
            name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }),
    scope = "Current designated JSON DTO and actual SQLite DateTime converter. The companion test separately executes real Native HTTP, PostgreSQL and SQLite takeover." },
    new JsonSerializerOptions { WriteIndented = true }) + "\n");
