using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Devices;
using Microsoft.Extensions.Logging.Abstractions;
if (args[0] == "hold-file") { FileSharingProbe.Hold(args); return; }
var inputBytes = File.ReadAllBytes(args[0]); var output = Path.GetDirectoryName(Path.GetFullPath(args[1]))!; var results = new List<object>();
object Observe(JsonElement sample, string root, bool applyLock) {
    var name = sample.GetProperty("name").GetString()!;
    var paths = new ServerApplicationPaths(Path.Combine(root, "data"), Path.Combine(root, "log"), Path.Combine(root, "config"), Path.Combine(root, "cache"), Path.Combine(root, "web"));
    var filename = Path.Combine(paths.DataPath, "device.txt");
    if (sample.TryGetProperty("bytes", out var payload)) File.WriteAllBytes(filename, Convert.FromBase64String(payload.GetString()!));
    if (sample.TryGetProperty("directory", out var directory) && directory.GetBoolean()) Directory.CreateDirectory(filename);
    var beforeBytes = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
    if (sample.TryGetProperty("readOnly", out var readOnly) && readOnly.GetBoolean()) File.SetAttributes(filename, FileAttributes.ReadOnly);
    var hasLock = sample.TryGetProperty("lock", out var locked);
    var accessibleControl = applyLock && hasLock ? Observe(sample, Path.Combine(root, "accessible-control"), false) : null;
    using var held = applyLock && hasLock ? File.Open(filename, FileMode.Open, FileAccess.Read, locked.GetString() == "none" ? FileShare.None : FileShare.Read) : null;
    var lockBefore = held is null ? null : FileSharingProbe.Access(filename);
    var device = new DeviceId(paths, NullLogger<DeviceId>.Instance); var value = device.Value; var cachedValue = device.Value;
    var lockAfter = held is null ? null : FileSharingProbe.Access(filename);
    held?.Dispose();
    var afterBytes = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
    if (File.Exists(filename)) File.SetAttributes(filename, FileAttributes.Normal);
    var reopenedValue = new DeviceId(paths, NullLogger<DeviceId>.Instance).Value;
    var reopenedBytes = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
    return new { name, filename, value, cachedValue, reopenedValue, beforeBytes, afterBytes, reopenedBytes, accessibleControl,
        afterDirectory = Directory.Exists(filename), validGuid = Guid.TryParse(value, out _),
        fileSharing = held is null ? null : new { mode = locked.GetString(), sameProcess = true, before = lockBefore, after = lockAfter } };
}
foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.EnumerateArray())
    results.Add(Observe(sample, Path.Combine(output, "states", sample.GetProperty("name").GetString()!), true));
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).Select(assembly => new {
    filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).OrderBy(row => row.filename).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualDeviceId = true, actualFiles = true, inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), assemblies, results }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
