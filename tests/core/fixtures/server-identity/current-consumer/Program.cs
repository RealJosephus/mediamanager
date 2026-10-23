using System.Text.Json;
using System.Security.Cryptography;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Devices;
using Microsoft.Extensions.Logging.Abstractions;
var results = new List<object>();
var inputBytes = File.ReadAllBytes(args[0]);
foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.EnumerateArray()) {
    var root = Path.GetFullPath(sample.GetProperty("root").GetString()!);
    var paths = new ServerApplicationPaths(Path.Combine(root, "data"), Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
    var filename = Path.Combine(paths.DataPath, "device.txt"); var beforeBytes = Convert.ToBase64String(File.ReadAllBytes(filename));
    var owner = new DeviceId(paths, NullLogger<DeviceId>.Instance); var value = owner.Value;
    var cachedValue = owner.Value; var reopenedValue = new DeviceId(paths, NullLogger<DeviceId>.Instance).Value;
    results.Add(new { name = sample.GetProperty("name").GetString(), value, cachedValue, reopenedValue, validGuid = Guid.TryParse(value, out _), beforeBytes, afterBytes = Convert.ToBase64String(File.ReadAllBytes(filename)) });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).Select(assembly => new {
    filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).OrderBy(row => row.filename).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualDeviceId = true, actualFiles = true,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), assemblies, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
