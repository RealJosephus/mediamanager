using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Devices;
using Microsoft.Extensions.Logging.Abstractions;
var results = new List<object>();
foreach (var sample in JsonDocument.Parse(File.ReadAllBytes(args[0])).RootElement.EnumerateArray()) {
    var root = Path.GetFullPath(sample.GetProperty("root").GetString()!);
    var paths = new ServerApplicationPaths(Path.Combine(root, "data"), Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
    var filename = Path.Combine(paths.DataPath, "device.txt"); var beforeBytes = Convert.ToBase64String(File.ReadAllBytes(filename));
    var owner = new DeviceId(paths, NullLogger<DeviceId>.Instance); var value = owner.Value;
    results.Add(new { name = sample.GetProperty("name").GetString(), value, cachedValue = owner.Value, beforeBytes, afterBytes = Convert.ToBase64String(File.ReadAllBytes(filename)) });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualDeviceId = true, actualFiles = true, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
