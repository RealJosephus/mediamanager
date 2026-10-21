using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using MediaBrowser.Model.MediaInfo;

// File consumer only. Actual hosts and their real ffprobe processes produce
// the cache bytes before this process is launched.
var bytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(bytes).RootElement;
var values = new List<object>();
foreach (var entry in input.GetProperty("files").EnumerateArray()) {
    var contents = File.ReadAllBytes(entry.GetProperty("filename").GetString()!);
    MediaInfo? value = null; string? error = null;
    try { value = JsonSerializer.Deserialize<MediaInfo>(contents, JsonDefaults.Options); }
    catch (Exception cause) { error = cause.GetType().Name; }
    values.Add(new { name = entry.GetProperty("name").GetString(), length = contents.Length,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(contents)), value, error });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualTypedMediaInfoReader = true,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), values,
    assemblies = new[] { typeof(MediaInfo).Assembly, typeof(JsonDefaults).Assembly }.Distinct()
        .Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }) }, JsonDefaults.Options));
