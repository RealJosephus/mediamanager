using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.LiveTv;

// This process only consumes captured bytes. The actual HTTP host and guide
// task produced them; no substitute manager/controller is initialized here.
var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var serializer = new MyXmlSerializer();
var results = new List<object>();
foreach (var sample in input.GetProperty("files").EnumerateArray()) {
    var filename = sample.GetProperty("filename").GetString()!;
    var contents = File.ReadAllBytes(filename); object? value = null; string? error = null;
    try {
        value = sample.GetProperty("kind").GetString() == "configuration"
            ? serializer.DeserializeFromBytes(typeof(LiveTvOptions), contents)
            : JsonSerializer.Deserialize<List<ChannelInfo>>(contents, JsonDefaults.Options);
    } catch (Exception cause) { error = cause.GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), kind = sample.GetProperty("kind").GetString(),
        sha256 = Convert.ToHexStringLower(SHA256.HashData(contents)), length = contents.Length, value, error });
}
var assemblies = new[] { typeof(LiveTvOptions).Assembly, typeof(MyXmlSerializer).Assembly, typeof(ChannelInfo).Assembly, typeof(JsonDefaults).Assembly }
    .Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualXmlSerializer = true, actualTypedChannelCacheReader = true,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), executorsStarted = false, results, assemblies }, options));
