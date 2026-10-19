using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;

var bytes = File.ReadAllBytes(args[0]);
var input = JsonSerializer.Deserialize<Sample[]>(bytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
var results = new List<object>();
foreach (var sample in input)
{
    var text = string.Concat(sample.CodeUnits.Select(value => (char)value));
    var frame = new Frame
    {
        UserId = text,
        Values = new string?[] { text, null },
        Dictionary = new Dictionary<string, string?> { [text] = text, ["Null"] = null },
        Ticks = long.MaxValue
    };
    foreach (var profile in new[] { "Default", "PascalCase", "CamelCase" })
    {
        var options = profile == "Default" ? JsonDefaults.Options
            : profile == "PascalCase" ? JsonDefaults.PascalCaseOptions : JsonDefaults.CamelCaseOptions;
        results.Add(new { name = sample.Name, profile, body = JsonSerializer.Serialize(frame, options) });
    }
}
Console.WriteLine(JsonSerializer.Serialize(new
{
    actualFrozenJsonDefaultsEncoder = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
    results
}, new JsonSerializerOptions { WriteIndented = true }));

sealed class Sample
{
    public string Name { get; set; } = "";
    public int[] CodeUnits { get; set; } = Array.Empty<int>();
}
sealed class Frame
{
    public string UserId { get; set; } = "";
    public string? Missing { get; set; }
    public string?[] Values { get; set; } = Array.Empty<string?>();
    public Dictionary<string, string?> Dictionary { get; set; } = new();
    public long Ticks { get; set; }
}
