using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.LiveTv;

var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var cases = input.GetProperty("cases").EnumerateArray().Select(sample =>
{
    var channel = new LiveTvChannel
    {
        Name = sample.GetProperty("name").GetString(),
        Number = sample.GetProperty("number").GetString()
    };
    return new { key = sample.GetProperty("key").GetString(), channel.SortName };
}).ToArray();
var assemblies = new[] { typeof(LiveTvChannel).Assembly, typeof(object).Assembly, typeof(JsonSerializer).Assembly }
    .Distinct().Select(assembly => new { assembly.FullName, filename = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualChannelCreateSortName = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
    assemblies,
    cases
}));
