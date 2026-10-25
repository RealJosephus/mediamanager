// Additional consumer reader observations. Existing oracles and their expected bytes are unchanged.
using System.Globalization;
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
using PlaylistsNET.Content;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var crypto = new CryptographyProvider();
var passwordResults = input.GetProperty("passwords").EnumerateArray().Select(sample => {
    var hash = PasswordHash.Parse(sample.GetProperty("hash").GetString()!);
    var password = sample.GetProperty("password").GetString()!;
    return new { name = sample.GetProperty("name").GetString(), canonical = hash.ToString(),
        salt = Convert.ToHexString(hash.Salt), hashLength = hash.Hash.Length,
        verified = crypto.Verify(hash, password), changedPassword = crypto.Verify(hash, password + "x") };
}).ToArray();
var zeroSalt = Convert.FromHexString("000102030405060708090A0B0C0D0E00");
var nativeZeroHash = new PasswordHash("PBKDF2-SHA512",
    Rfc2898DeriveBytes.Pbkdf2("原生密碼😀", zeroSalt, 210000, HashAlgorithmName.SHA512, 64), zeroSalt,
    new Dictionary<string, string> { { "iterations", "210000" } }).ToString();
var parser = new SubtitleEditParser(NullLogger<SubtitleEditParser>.Instance);
var subtitles = input.GetProperty("subtitles").EnumerateArray().Select(sample => {
    object? parsed = null, error = null;
    try {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(sample.GetProperty("text").GetString()!));
        var subtitle = parser.Parse(stream, sample.GetProperty("format").GetString()!);
        parsed = subtitle.Paragraphs.Select(cue => new { number = cue.Number,
            startMilliseconds = cue.StartTime.TotalMilliseconds, endMilliseconds = cue.EndTime.TotalMilliseconds,
            text = cue.Text }).ToArray();
    } catch (Exception caught) { error = new { type = caught.GetType().Name, message = caught.Message }; }
    return new { name = sample.GetProperty("name").GetString(), parsed, error };
}).ToArray();
object Tree(XElement element) => new {
    name = element.Name.ToString(),
    attributes = element.Attributes().Select(attribute => new { name = attribute.Name.ToString(), value = attribute.Value })
        .OrderBy(attribute => attribute.name, StringComparer.Ordinal).ToArray(),
    children = element.Nodes().Where(node => node is XElement || node is XText).Select(node => node is XElement child
        ? Tree(child) : (object)new { text = ((XText)node).Value }).ToArray()
};
var serializer = new MyXmlSerializer();
var configurations = input.GetProperty("configurations").EnumerateArray().Select(sample => {
    var xml = sample.GetProperty("xml").GetString()!;
    var configuration = (ServerConfiguration)serializer.DeserializeFromBytes(typeof(ServerConfiguration), Encoding.UTF8.GetBytes(xml))!;
    using var saved = new MemoryStream();
    serializer.SerializeToStream(configuration, saved);
    var rewritten = Encoding.UTF8.GetString(saved.ToArray());
    object Unknown(string text) => XDocument.Parse(text, LoadOptions.PreserveWhitespace).Root!.Elements()
        .Where(element => element.Name.LocalName is "Extra" or "Future").Select(Tree).ToArray();
    return new { name = sample.GetProperty("name").GetString(), configuration.ServerName, configuration.UICulture,
        configuration.MetadataCountryCode, configuration.ContentTypes,
        unknown = Unknown(xml), nativeRewrittenUnknown = Unknown(rewritten), nativeRewritten = rewritten };
}).ToArray();
var options = JsonDefaults.Options;
var tasks = input.GetProperty("tasks").EnumerateArray().Select(sample => {
    var type = sample.GetProperty("kind").GetString() == "triggers" ? typeof(TaskTriggerInfo[]) : typeof(TaskResult);
    var source = sample.GetProperty("text").GetString()!;
    var value = JsonSerializer.Deserialize(source, type, options);
    return new { name = sample.GetProperty("name").GetString(), text = JsonSerializer.Serialize(value, type, options) };
}).ToArray();
var playlists = input.GetProperty("playlists").EnumerateArray().Select(sample => {
    using var stream = new MemoryStream(Convert.FromBase64String(sample.GetProperty("bytes").GetString()!));
    string rewritten;
    JsonElement entries, reread;
    if (sample.GetProperty("path").GetString()!.EndsWith(".zpl", StringComparison.OrdinalIgnoreCase)) {
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
    return new { name = sample.GetProperty("name").GetString(), entries, rewritten, reread };
}).ToArray();
var jsonBoundary = JsonSerializer.Serialize(new {
    Value = 1.00000006f, NegativeZero = -0f, NegativeDoubleZero = -0d, MinTicks = long.MinValue, MaxTicks = long.MaxValue,
    Date = DateTime.Parse("2026-10-11T01:02:03.1234567Z", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
    Missing = (string?)null, Dictionary = new Dictionary<string, string?> { { "Null", null }, { "Tmdb", "123" } },
    Values = new string?[] { null, "\ud800" }, InvalidKey = new Dictionary<string, string> { { "\ud800", "\ud800" } }
}, options);
var nonFinite = new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity }.Select(value => {
    try { return (object)new { rejected = false, text = JsonSerializer.Serialize(new { Value = value }, options) }; }
    catch (Exception error) { return new { rejected = true, type = error.GetType().Name, message = error.Message }; }
}).ToArray();
var result = new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    candidateVerified = false, timezone = TimeZoneInfo.Local.Id, passwordResults, nativeZeroHash,
    nativeZeroPassword = "原生密碼😀", subtitles, configurations, tasks, playlists, jsonBoundary, nonFinite,
    assemblies = new[] { typeof(PasswordHash).Assembly, typeof(CryptographyProvider).Assembly, typeof(SubtitleEditParser).Assembly,
        typeof(JsonDefaults).Assembly, typeof(WplContent).Assembly }.Distinct().Select(assembly => new { name = assembly.GetName().Name, filename = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) };
File.WriteAllText(args[1], JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
