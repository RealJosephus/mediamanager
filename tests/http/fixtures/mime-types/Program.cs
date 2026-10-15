using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Mime = MediaBrowser.Model.Net.MimeTypes;

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
var toExtension = mimeTypes.ToDictionary(value => value, Mime.ToExtension, StringComparer.Ordinal);
var resource = new { extensionMimeTypes = known.OrderBy(entry => entry.Key, StringComparer.Ordinal).ToDictionary(entry => entry.Key, entry => entry.Value),
    videoExtensions, mimeExtensions = toExtension };
var filenameResults = new List<object>();
foreach (var extension in extensions) foreach (var filename in new[] { "sample" + extension, "sample" + extension.ToUpperInvariant(), extension }) RecordFilename(filename, false, null);
foreach (var filename in new string?[] { null, "", "sample", ".", "..", "file.", "file.PNG ", "file.png\n", "file.jpg?x=1", "file.png#x", "file.png;test",
    "Z:\\dir.with.dot\\image.PNG", "/dir.with.dot/image.PNG", "Z:\\dir.png\\file", "/dir.png/file", "Z:\\dir.png\\", "file.tbn:stream", "file:png", "file.IMG", "file.ISO", "file.ſvg", "file.İco", "file.Kml", "file.png\0", "file.png\0.jpg" }) {
    RecordFilename(filename, false, null);
    foreach (var fallback in new string?[] { null, "", "application/controlled" }) RecordFilename(filename, true, fallback);
}
var extensionResults = new List<object>();
foreach (var mimeType in mimeTypes) foreach (var value in new[] { mimeType, mimeType.ToUpperInvariant(), mimeType + "; charset=UTF-8", mimeType + " ; charset=UTF-8", " " + mimeType }) RecordExtension(value);
foreach (var value in new string?[] { null, "", ";", ";image/png", "image/png;;x", "image/png\n", "image/x-unknown", "text/plain;charset=\"UTF-8\"", "image/PNG\0", "image/ſvg+xml", "text/plaın" }) RecordExtension(value);
File.WriteAllText(args[0], JsonSerializer.Serialize(new { resource, inventory = new {
    packageEntries = packageMap.Count(), mimeOverrides = mimeOverrides.Count(), extensionOverrides = extensionOverrides.Count(),
    extensionCount = extensions.Length, mimeCount = mimeTypes.Length, extensions, mimeTypes }, filenameResults, extensionResults,
    scope = "Actual designated MediaBrowser.Model.Net.MimeTypes methods. Complete extension and MIME inventories derive from actual compiled source-package and wrapper maps, including native overrides, video fallback, reverse first-extension choices and invalid/default/semicolon/case/path boundaries. No HTTP, image decoding or storage execution is claimed.",
    assemblies = new[] { type.Assembly }.Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
void RecordFilename(string? filename, bool explicitDefault, string? defaultValue) {
    string? mime = null, exception = null;
    try { mime = explicitDefault ? Mime.GetMimeType(filename!, defaultValue) : Mime.GetMimeType(filename!); }
    catch (Exception error) { exception = error.GetType().Name; }
    filenameResults.Add(new { filename, explicitDefault, defaultValue, mime, exception });
}
void RecordExtension(string? mimeType) {
    string? extension = null, exception = null;
    try { extension = Mime.ToExtension(mimeType!); } catch (Exception error) { exception = error.GetType().Name; }
    extensionResults.Add(new { mimeType, extension, exception });
}
