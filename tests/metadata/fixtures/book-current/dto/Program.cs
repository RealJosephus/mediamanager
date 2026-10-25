using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Dto;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var method = typeof(DtoService).GetMethod("SetBookProperties", BindingFlags.Static | BindingFlags.NonPublic)!;
var results = new List<object>();
foreach (var sample in input.RootElement.GetProperty("cases").EnumerateArray())
{
    var value = sample.GetProperty("seriesName");
    var book = new Book { SeriesName = value.ValueKind == JsonValueKind.Null ? null : value.GetString() };
    var dto = new BaseItemDto();
    method.Invoke(null, [dto, book]);
    var serialized = JsonSerializer.SerializeToElement(dto, JsonDefaults.Options);
    var wire = new Dictionary<string, JsonElement>();
    if (serialized.TryGetProperty(nameof(BaseItemDto.SeriesName), out var seriesName))
    {
        wire.Add(nameof(BaseItemDto.SeriesName), seriesName);
    }

    results.Add(new { name = sample.GetProperty("name").GetString(), dto.SeriesName, wire, dto = serialized });
}

File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualExecution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    results,
    assemblies = new[] { typeof(DtoService).Assembly, typeof(Book).Assembly, typeof(BaseItemDto).Assembly, typeof(JsonDefaults).Assembly }
        .Distinct().Select(assembly => new { name = assembly.GetName().Name,
            sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }),
    scope = "Actual DtoService.SetBookProperties and supplied JsonDefaults serialization for all three original Book SeriesName values. Full serialized target DTOs are retained; the functional comparison concerns Book SeriesName wire presence/value. No native hosted HTTP or database claim."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
