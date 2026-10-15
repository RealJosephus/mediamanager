using System.Reflection;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Emby.Server.Implementations.Library;
var input = JsonNode.Parse(File.ReadAllText(args[0]))!.AsArray();
var method = typeof(DotIgnoreIgnoreRule).GetMethod("CheckIgnoreRules", BindingFlags.NonPublic | BindingFlags.Static,
    null, [typeof(string), typeof(string[]), typeof(bool), typeof(bool)], null)!;
var results = new JsonArray();
foreach (var sample in input) {
    var checks = new JsonArray();
    foreach (var path in sample!["paths"]!.AsArray()) checks.Add(new JsonObject { ["path"] = path!.GetValue<string>(),
        ["ignored"] = (bool)method.Invoke(null, [path.GetValue<string>(), sample["patterns"]!.AsArray().Select(x => x!.GetValue<string>()).ToArray(), false, true])! });
    results.Add(new JsonObject { ["id"] = sample!["id"]!.GetValue<string>(), ["checks"] = checks });
}
File.WriteAllText(args[1], new JsonObject { ["actualFrozenIgnoreEscapes"] = true,
    ["inputSha256"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    ["scope"] = "Actual frozen DotIgnoreIgnoreRule.CheckIgnoreRules/Ignore 0.2.1 with its bound CLR Regex runtime. ASCII and non-ASCII control escape validation, numeric named references, initial bracket and subtracted classes, capture participation, forward references, optional/repeated captures, alternatives, boundaries and case equivalences. No file/cache operations, FindExtras, providers, scanning/network or release acceptance.",
    ["culture"] = CultureInfo.CurrentCulture.Name,
    ["assemblies"] = JsonSerializer.SerializeToNode(new[] { typeof(DotIgnoreIgnoreRule).Assembly, typeof(Ignore.Ignore).Assembly, typeof(Regex).Assembly }
        .Select(assembly => new { name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() })),
    ["rules"] = results }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
