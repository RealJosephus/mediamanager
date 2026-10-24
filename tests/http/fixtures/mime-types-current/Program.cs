using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Mime = MediaBrowser.Model.Net.MimeTypes;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var type = typeof(Mime);
var package = type.Assembly.GetType("MediaBrowser.Model.MimeTypes")!;
var packageMap = (IEnumerable<KeyValuePair<string, string>>)package.GetField("s_typeMap", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
var mimeOverrides = (IEnumerable<KeyValuePair<string, string>>)type.GetField("_mimeTypeLookup", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
var extensionOverrides = (IEnumerable<KeyValuePair<string, string>>)type.GetField("_extensionLookup", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
var videoExtensions = ((IEnumerable<string>)type.GetField("_videoFileExtensions", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!).Order(StringComparer.Ordinal).ToArray();
var known = packageMap.ToDictionary(entry => "." + entry.Key, entry => entry.Value, StringComparer.OrdinalIgnoreCase);
foreach (var entry in mimeOverrides) known[entry.Key] = entry.Value;
var extensions = known.Keys.Concat(videoExtensions).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToArray();
var mimeTypes = packageMap.Select(entry => entry.Value).Concat(mimeOverrides.Select(entry => entry.Value)).Concat(extensionOverrides.Select(entry => entry.Key))
    .Select(value => value.Split(';')[0]).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToArray();
var resource = new {
    extensionMimeTypes = known.OrderBy(entry => entry.Key, StringComparer.Ordinal).ToDictionary(entry => entry.Key, entry => entry.Value),
    videoExtensions, mimeExtensions = mimeTypes.ToDictionary(value => value, Mime.ToExtension, StringComparer.Ordinal)
};
var filenameResults = new List<object>();
foreach (var sample in input.RootElement.GetProperty("filenames").EnumerateArray()) {
    var filename = sample.GetProperty("filename").GetString();
    var explicitDefault = sample.GetProperty("explicitDefault").GetBoolean();
    var defaultValue = sample.GetProperty("defaultValue").GetString();
    string? mime = null, exception = null;
    try { mime = explicitDefault ? Mime.GetMimeType(filename!, defaultValue) : Mime.GetMimeType(filename!); }
    catch (Exception error) { exception = error.GetType().Name; }
    filenameResults.Add(new { filename, explicitDefault, defaultValue, mime, exception });
}
var extensionResults = new List<object>();
foreach (var sample in input.RootElement.GetProperty("mimeTypes").EnumerateArray()) {
    var mimeType = sample.GetString();
    string? extension = null, exception = null;
    try { extension = Mime.ToExtension(mimeType!); }
    catch (Exception error) { exception = error.GetType().Name; }
    extensionResults.Add(new { mimeType, extension, exception });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualExecution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    resource, inventory = new { extensions, mimeTypes }, filenameResults, extensionResults,
    assemblies = new[] { type.Assembly, typeof(Jellyfin.Extensions.StringExtensions).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
