using BitFaster.Caching.Lru;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using Emby.Server.Implementations.Library;
using MediaBrowser.Model.IO;

var input = JsonNode.Parse(File.ReadAllText(args[0]))!.AsObject();
var output = new JsonObject();
output["actualFrozenDotIgnoreIgnoreRule"] = true;
output["inputSha256"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant();
output["assemblies"] = JsonSerializer.SerializeToNode(new[] { typeof(DotIgnoreIgnoreRule).Assembly, typeof(Ignore.Ignore).Assembly, typeof(Regex).Assembly, typeof(FastConcurrentLru<,>).Assembly }
    .Select(assembly => new { name = assembly.GetName().Name,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray());
output["scope"] = "Actual frozen DotIgnoreIgnoreRule.CheckIgnoreRules and ShouldIgnore/ClearDirectoryCache over real files, plus the bound .NET Regex runtime's BMP case equivalences, Unicode categories and block data. Rules include full paths, separators, directories, comment/empty/invalid handling, ordered negation, globstars, character classes/subtraction, category/block escapes, case/hex escapes, Unicode boundaries, octal escapes and backreferences. Sequential actual BitFaster FastConcurrentLru operations also cover configured capacities, warm-up, eviction, updates, removal and clear. Files cover nearest ancestor selection, directory start, cached absence/parent results, timestamp/length invalidation, deletion/clear and UTF-8/16/32 BOM decoding. Does not execute native FindExtras/scanning, symlinks, network failure paths, concurrent access, all .NET regex syntax, HTTP/WS or release acceptance.";
output["culture"] = CultureInfo.CurrentCulture.Name;
output["windowsPathNormalization"] = OperatingSystem.IsWindows();
var regexClass = typeof(Regex).Assembly.GetType("System.Text.RegularExpressions.RegexCharClass")!;
var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
var addChar = regexClass.GetMethod("AddChar", flags, [typeof(char)])!;
var addCase = regexClass.GetMethod("AddCaseEquivalences", flags, [typeof(CultureInfo)])!;
var serializeClass = regexClass.GetMethod("ToStringClass", flags, Type.EmptyTypes)!;
var equivalences = new SortedDictionary<string, int[]>(StringComparer.Ordinal);
var categoryCodes = new Dictionary<string, List<int>>(StringComparer.Ordinal);
for (var code = 0; code <= ushort.MaxValue; code++)
{
    var value = (char)code;
    var category = CharUnicodeInfo.GetUnicodeCategory(value).ToString();
    if (!categoryCodes.TryGetValue(category, out var codes)) categoryCodes[category] = codes = [];
    codes.Add(code);
    var characterClass = Activator.CreateInstance(regexClass, nonPublic: true)!;
    addChar.Invoke(characterClass, [value]);
    var before = (string)serializeClass.Invoke(characterClass, null)!;
    addCase.Invoke(characterClass, [CultureInfo.CurrentCulture]);
    var expanded = (string)serializeClass.Invoke(characterClass, null)!;
    if (expanded == before) continue;
    if (expanded[0] != 0 || expanded[2] != 0) throw new InvalidOperationException("Unexpected literal character class representation.");
    var members = new List<int>();
    for (var index = 3; index < 3 + expanded[1]; index += 2)
    {
        var end = index + 1 < 3 + expanded[1] ? expanded[index + 1] : 65536;
        for (var member = (int)expanded[index]; member < end; member++) members.Add(member);
    }
    equivalences[value.ToString()] = members.ToArray();
}
output["caseEquivalences"] = JsonSerializer.SerializeToNode(equivalences);
var categories = new SortedDictionary<string, string>(StringComparer.Ordinal);
foreach (var (name, codes) in categoryCodes)
{
    var ranges = new StringBuilder();
    for (var index = 0; index < codes.Count; index++)
    {
        var start = codes[index];
        while (index + 1 < codes.Count && codes[index + 1] == codes[index] + 1) index++;
        ranges.Append("\\u").Append(start.ToString("x4"));
        if (codes[index] != start) ranges.Append("-\\u").Append(codes[index].ToString("x4"));
    }
    categories[name] = ranges.ToString();
}
output["categories"] = JsonSerializer.SerializeToNode(categories);
var blocks = new SortedDictionary<string, int[]>(StringComparer.Ordinal);
foreach (var field in regexClass.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
{
    if (field.GetValue(null) is not string[][] definitions) continue;
    foreach (var definition in definitions)
    {
        if (definition.Length == 2 && definition[0].StartsWith("Is", StringComparison.Ordinal))
            blocks[definition[0]] = definition[1].Select(value => (int)value).ToArray();
    }
}
output["unicodeBlocks"] = JsonSerializer.SerializeToNode(blocks);
var checkRules = typeof(DotIgnoreIgnoreRule).GetMethod("CheckIgnoreRules", BindingFlags.NonPublic | BindingFlags.Static,
    null, [typeof(string), typeof(string[]), typeof(bool), typeof(bool)], null)!;
var ruleResults = new JsonArray();
foreach (var sample in input["rules"]!.AsArray())
{
    var rules = sample!["patterns"]!.AsArray().Select(x => x!.GetValue<string>()).ToArray();
    var results = new JsonArray();
    foreach (var path in sample["paths"]!.AsArray())
    {
        results.Add(new JsonObject {
            ["path"] = path!["path"]!.GetValue<string>(),
            ["isDirectory"] = path["isDirectory"]?.GetValue<bool>() ?? false,
            ["normalizePath"] = path["normalizePath"]?.GetValue<bool>() ?? true,
            ["ignored"] = (bool)checkRules.Invoke(null, [path["path"]!.GetValue<string>(), rules,
                path["isDirectory"]?.GetValue<bool>() ?? false, path["normalizePath"]?.GetValue<bool>() ?? true])!
        });
    }
    ruleResults.Add(new JsonObject { ["id"] = sample["id"]!.GetValue<string>(), ["checks"] = results });
}
output["rules"] = ruleResults;
var fileResults = new JsonArray();
Directory.CreateDirectory(args[2]);
foreach (var sample in input["files"]!.AsArray())
{
    var id = sample!["id"]!.GetValue<string>();
    var root = Path.GetFullPath(Path.Combine(args[2], id));
    Directory.CreateDirectory(root);
    var rule = new DotIgnoreIgnoreRule();
    var checks = new JsonArray();
    foreach (var action in sample["actions"]!.AsArray())
    {
        var relative = action!["path"]?.GetValue<string>() ?? "";
        var path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        switch (action["operation"]!.GetValue<string>())
        {
            case "write":
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                Encoding encoding = action["encoding"]?.GetValue<string>() switch {
                    "utf16le" => new UnicodeEncoding(false, true),
                    "utf16be" => new UnicodeEncoding(true, true),
                    "utf32le" => new UTF32Encoding(false, true),
                    "utf32be" => new UTF32Encoding(true, true),
                    "utf8bom" => new UTF8Encoding(true),
                    _ => new UTF8Encoding(false)
                };
                File.WriteAllText(path, action["text"]!.GetValue<string>(), encoding);
                File.SetLastWriteTimeUtc(path, DateTime.Parse(action["modified"]?.GetValue<string>() ?? "2025-01-01T00:00:00Z").ToUniversalTime());
                break;
            case "remove": File.Delete(path); break;
            case "clear": rule.ClearDirectoryCache(); break;
            case "check":
                var directory = action["isDirectory"]?.GetValue<bool>() ?? false;
                if (directory) Directory.CreateDirectory(path);
                else { Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, "media"); }
                var metadata = new FileSystemMetadata { FullName = path, Name = Path.GetFileName(path), IsDirectory = directory };
                checks.Add(new JsonObject { ["path"] = relative, ["isDirectory"] = directory,
                    ["ignored"] = rule.ShouldIgnore(metadata, null) });
                break;
            default: throw new InvalidOperationException("Unknown action.");
        }
    }
    fileResults.Add(new JsonObject { ["id"] = id, ["checks"] = checks });
}
output["files"] = fileResults;
output["processorCount"] = Environment.ProcessorCount;
output["directoryCacheCapacity"] = Math.Max(100, Environment.ProcessorCount * 100);
output["rulesCacheCapacity"] = Math.Max(32, Math.Max(100, Environment.ProcessorCount * 100) / 4);
var cacheResults = new JsonArray();
foreach (var sample in input["caches"]!.AsArray())
{
    var cache = new FastConcurrentLru<string, int>(1, sample!["capacity"]!.GetValue<int>(), StringComparer.Ordinal);
    var operations = new JsonArray();
    foreach (var action in sample["actions"]!.AsArray())
    {
        var operation = action!["operation"]!.GetValue<string>();
        var key = action["key"]?.GetValue<string>() ?? "";
        bool? found = null;
        int? value = null;
        switch (operation)
        {
            case "set": cache.AddOrUpdate(key, action["value"]!.GetValue<int>()); break;
            case "get": found = cache.TryGet(key, out var fetched); value = fetched; break;
            case "remove": found = cache.TryRemove(key, out var removed); value = removed; break;
            case "clear": cache.Clear(); break;
            default: throw new InvalidOperationException("Unknown cache operation.");
        }
        operations.Add(new JsonObject {
            ["operation"] = operation, ["key"] = key, ["found"] = found, ["value"] = value,
            ["count"] = cache.Count, ["hotCount"] = cache.HotCount, ["warmCount"] = cache.WarmCount, ["coldCount"] = cache.ColdCount,
            ["entries"] = JsonSerializer.SerializeToNode(cache.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => new { key = pair.Key, value = pair.Value }).ToArray())
        });
    }
    cacheResults.Add(new JsonObject { ["id"] = sample["id"]!.GetValue<string>(), ["operations"] = operations });
}
output["caches"] = cacheResults;
File.WriteAllText(args[1], output.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));
