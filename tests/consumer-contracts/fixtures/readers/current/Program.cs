// Current consumer observations against the designated runtime assemblies.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Emby.Server.Implementations.Cryptography;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Extensions.Json;
using MediaBrowser.MediaEncoding.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Cryptography;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Nikse.SubtitleEdit.Core.SubtitleFormats;
using PlaylistsNET.Content;

var inputBytes = File.ReadAllBytes(args[0]);
var document = JsonDocument.Parse(inputBytes).RootElement;
var input = document.GetProperty("input");
var candidate = document.GetProperty("candidate");
var output = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
var utf8 = new UTF8Encoding(false);
var options = JsonDefaults.Options;
var crypto = new CryptographyProvider();
var passwords = candidate.GetProperty("passwords").EnumerateArray().Select(sample => {
    var hash = PasswordHash.Parse(sample.GetProperty("hash").GetString()!);
    var password = sample.GetProperty("password").GetString()!;
    return new { name = sample.GetProperty("name").GetString(), canonical = hash.ToString(),
        salt = Convert.ToHexString(hash.Salt), hashLength = hash.Hash.Length,
        verified = crypto.Verify(hash, password), changedPassword = crypto.Verify(hash, password + "x") };
}).ToArray();
var nativePassword = "原生密碼😀";
var zeroSalt = Convert.FromHexString("000102030405060708090A0B0C0D0E00");
var nativePasswords = new[] {
    new { name = "native-csprng", password = nativePassword, hash = crypto.CreatePasswordHash(nativePassword).ToString() },
    new { name = "native-contained-zero", password = nativePassword, hash = new PasswordHash("PBKDF2-SHA512",
        Rfc2898DeriveBytes.Pbkdf2(nativePassword, zeroSalt, 210000, HashAlgorithmName.SHA512, 64), zeroSalt,
        new Dictionary<string, string> { { "iterations", "210000" } }).ToString() }
};

var parser = new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance);
using var encoder = new SubtitleEncoder(NullLogger<SubtitleEncoder>.Instance, null!, null!, null!, null!, parser, null!, null!);
var filterEvents = typeof(SubtitleEncoder).GetMethod("FilterEvents", BindingFlags.Instance | BindingFlags.NonPublic)!;
object ReadSubtitle(string text, string format, JsonElement? conversion = null) {
    string? json = null, rewritten = null, rereadJson = null;
    object? error = null;
    try {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(text));
        var subtitle = parser.Parse(stream, format);
        if (conversion is { } settings) {
            filterEvents.Invoke(encoder, new object[] { subtitle,
                long.Parse(settings.GetProperty("startPositionTicks").GetString()!, CultureInfo.InvariantCulture),
                long.Parse(settings.GetProperty("endPositionTicks").GetString()!, CultureInfo.InvariantCulture),
                settings.GetProperty("copyTimestamps").GetBoolean() });
        }
        json = new JsonWriter().ToText(subtitle, "untitled");
        SubtitleFormat writer = format == "srt" ? new SubRip() : new WebVTT();
        rewritten = writer.ToText(subtitle, "untitled");
        using var next = new MemoryStream(Encoding.UTF8.GetBytes(rewritten));
        rereadJson = new JsonWriter().ToText(parser.Parse(next, format), "untitled");
    } catch (Exception caught) { error = new { type = caught.GetType().Name, message = caught.Message }; }
    return new { json, rewritten, rereadJson, error };
}
var neutralSubtitles = input.GetProperty("subtitles").EnumerateArray().ToArray();
var subtitles = candidate.GetProperty("subtitles").EnumerateArray().Select((sample, index) => {
    var format = sample.GetProperty("format").GetString()!;
    var rewritten = sample.GetProperty("rewritten");
    return new { name = sample.GetProperty("name").GetString(),
        baseline = ReadSubtitle(neutralSubtitles[index].GetProperty("text").GetString()!, format),
        node = rewritten.ValueKind == JsonValueKind.Null ? null : ReadSubtitle(rewritten.GetString()!, format) };
}).ToArray();
var neutralTimeMaps = input.GetProperty("subtitleTimeMaps").EnumerateArray().ToArray();
var subtitleTimeMaps = candidate.GetProperty("subtitleTimeMaps").EnumerateArray().Select((sample, index) => {
    var format = sample.GetProperty("format").GetString()!;
    var neutral = neutralTimeMaps[index];
    var rewritten = sample.GetProperty("rewritten");
    return new { name = sample.GetProperty("name").GetString(),
        baseline = ReadSubtitle(neutral.GetProperty("text").GetString()!, format, neutral.GetProperty("options")),
        node = rewritten.ValueKind == JsonValueKind.Null ? null : ReadSubtitle(rewritten.GetString()!, format) };
}).ToArray();

object Tree(XElement element) => new {
    name = element.Name.ToString(),
    attributes = element.Attributes().Select(attribute => new { name = attribute.Name.ToString(), value = attribute.Value })
        .OrderBy(attribute => attribute.name, StringComparer.Ordinal).ToArray(),
    children = element.Nodes().Where(node => node is XElement || node is XText).Select(node => node is XElement child
        ? Tree(child) : (object)new { text = ((XText)node).Value }).ToArray()
};
object Unknown(string text) => XDocument.Parse(text, LoadOptions.PreserveWhitespace).Root!.Elements()
    .Where(element => element.Name.LocalName is "Extra" or "Future").Select(Tree).ToArray();
var serializer = new MyXmlSerializer();
var configurations = candidate.GetProperty("configurations").EnumerateArray().Select((sample, index) => {
    var xml = sample.TryGetProperty("filename", out var source) ? File.ReadAllText(source.GetString()!) : sample.GetProperty("xml").GetString()!;
    var configuration = (ServerConfiguration)serializer.DeserializeFromBytes(typeof(ServerConfiguration), Encoding.UTF8.GetBytes(xml))!;
    var filename = Path.Combine(output, $"configuration-{index}.xml");
    using (var saved = File.Create(filename)) serializer.SerializeToStream(configuration, saved);
    var rewritten = File.ReadAllText(filename);
    return new { name = sample.GetProperty("name").GetString(), inputXml = xml, filename,
        configuration.ServerName, configuration.UICulture, configuration.MetadataCountryCode, configuration.ContentTypes,
        unknown = Unknown(xml), nativeRewrittenUnknown = Unknown(rewritten), nativeRewritten = rewritten };
}).ToArray();

var tasks = candidate.GetProperty("tasks").EnumerateArray().Select((sample, index) => {
    var type = sample.GetProperty("kind").GetString() == "triggers" ? typeof(TaskTriggerInfo[]) : typeof(TaskResult);
    var source = File.ReadAllText(sample.GetProperty("filename").GetString()!);
    var value = JsonSerializer.Deserialize(source, type, options);
    var text = JsonSerializer.Serialize(value, type, options);
    var filename = Path.Combine(output, $"task-{index}.json");
    File.WriteAllText(filename, text, utf8);
    return new { name = sample.GetProperty("name").GetString(), inputText = source, text, filename };
}).ToArray();

JsonElement ReadPlaylist(string bytes, string extension) {
    using var stream = new MemoryStream(Convert.FromBase64String(bytes));
    return extension.Equals(".zpl", StringComparison.OrdinalIgnoreCase)
        ? JsonSerializer.SerializeToElement(new ZplContent().GetFromStream(stream).PlaylistEntries)
        : JsonSerializer.SerializeToElement(new WplContent().GetFromStream(stream).PlaylistEntries);
}
var neutralPlaylists = input.GetProperty("playlists").EnumerateArray().ToArray();
var playlists = candidate.GetProperty("playlists").EnumerateArray().Select((sample, index) => {
    using var stream = new MemoryStream(Convert.FromBase64String(sample.GetProperty("bytes").GetString()!));
    string rewritten;
    JsonElement entries, reread;
    var extension = Path.GetExtension(sample.GetProperty("path").GetString()!);
    if (extension.Equals(".zpl", StringComparison.OrdinalIgnoreCase)) {
        var content = new ZplContent(); var playlist = content.GetFromStream(stream);
        entries = JsonSerializer.SerializeToElement(playlist.PlaylistEntries);
        rewritten = content.ToText(playlist);
        using var next = new MemoryStream(Encoding.UTF8.GetBytes(rewritten));
        reread = JsonSerializer.SerializeToElement(content.GetFromStream(next).PlaylistEntries);
    } else {
        var content = new WplContent(); var playlist = content.GetFromStream(stream);
        entries = JsonSerializer.SerializeToElement(playlist.PlaylistEntries);
        rewritten = content.ToText(playlist);
        using var next = new MemoryStream(Encoding.UTF8.GetBytes(rewritten));
        reread = JsonSerializer.SerializeToElement(content.GetFromStream(next).PlaylistEntries);
    }
    var filename = Path.Combine(output, $"playlist-{index}{extension}");
    File.WriteAllText(filename, rewritten, utf8);
    return new { name = sample.GetProperty("name").GetString(),
        baseline = ReadPlaylist(neutralPlaylists[index].GetProperty("bytes").GetString()!, extension),
        entries, rewritten, reread, filename };
}).ToArray();

var jsonBoundary = JsonSerializer.Serialize(new PublicJsonBoundary {
    Value = 1.00000006f, NegativeZero = -0f, NegativeDoubleZero = -0d, MinTicks = long.MinValue, MaxTicks = long.MaxValue,
    Date = DateTime.Parse("2026-10-11T01:02:03.1234567Z", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
    Dictionary = new Dictionary<string, string?> { { "Null", null }, { "Tmdb", "123" } },
    Values = new string?[] { null, "\ud800" }, InvalidKey = new Dictionary<string, string> { { "\ud800", "\ud800" } }
}, options);
var jsonReadBack = JsonSerializer.Serialize(JsonSerializer.Deserialize<PublicJsonBoundary>(candidate.GetProperty("jsonBoundary").GetString()!, options), options);
var nonFinite = new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity }.Select(value => {
    try { return (object)new { rejected = false, text = JsonSerializer.Serialize(new { Value = value }, options) }; }
    catch (Exception error) { return new { rejected = true, type = error.GetType().Name, message = error.Message }; }
}).ToArray();
var result = new { actualExecution = true, inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    timezone = TimeZoneInfo.Local.Id, passwords, nativePasswords, subtitles, subtitleTimeMaps, configurations, tasks, playlists,
    jsonBoundary, jsonReadBack, nonFinite,
    assemblies = new[] { typeof(PasswordHash).Assembly, typeof(CryptographyProvider).Assembly, typeof(SubtitleEditParser).Assembly,
        typeof(SubtitleFormat).Assembly, typeof(JsonDefaults).Assembly, typeof(WplContent).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) };
File.WriteAllText(args[1], JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }), utf8);

public sealed class PublicJsonBoundary {
    public float Value { get; set; }
    public float NegativeZero { get; set; }
    public double NegativeDoubleZero { get; set; }
    public long MinTicks { get; set; }
    public long MaxTicks { get; set; }
    public DateTime Date { get; set; }
    public string? Missing { get; set; }
    public Dictionary<string, string?>? Dictionary { get; set; }
    public string?[]? Values { get; set; }
    public Dictionary<string, string>? InvalidKey { get; set; }
}
