using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;

var input = File.ReadAllBytes(args[1]);
var specification = JsonSerializer.Deserialize<Input>(input)!;
object Execute(Func<Guid?> callback) {
    try { return new { supported = true, success = true, value = callback()?.ToString("D"), failure = (object?)null }; }
    catch (Exception error) { return new { supported = true, success = false, value = (string?)null,
        failure = new { type = error.GetType().Name, error.Message } }; }
}
var cases = specification.Cases.Select(sample => new {
    sample.Name, value = sample.Value,
    guidParse = sample.Value.ValueKind is JsonValueKind.String or JsonValueKind.Null
        ? Execute(() => Guid.Parse(sample.Value.ValueKind == JsonValueKind.Null ? null! : sample.Value.GetString()!))
        : (object)new { supported = false },
    jsonGuid = Execute(() => JsonSerializer.Deserialize<Guid>(sample.Value.GetRawText(), JsonDefaults.Options)),
    nullableJsonGuid = Execute(() => JsonSerializer.Deserialize<Guid?>(sample.Value.GetRawText(), JsonDefaults.Options))
}).ToArray();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .OrderBy(value => value.GetName().Name).Select(value => new { name = value.GetName().Name, filename = value.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(value.Location))).ToLowerInvariant() }).ToArray();
File.WriteAllText(args[2], JsonSerializer.Serialize(new { actualGuidParse = true, actualJsonGuidConverter = true,
    actualJsonDefaults = true, mediaOpened = false, portOpened = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(), cases, assemblies,
    dotnetRuntime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = cases.Length, actualGuidParse = true, actualJsonGuidConverter = true }));
public sealed class Input { public Sample[] Cases { get; set; } = []; }
public sealed class Sample { public string Name { get; set; } = ""; public JsonElement Value { get; set; } }
