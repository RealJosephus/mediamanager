using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using MediaBrowser.Controller.Entities;

var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
BaseItem Create(JsonElement value) {
    var type = typeof(BaseItem).Assembly.GetTypes().Single(type => type.Name == value.GetProperty("Type").GetString()
        && !type.IsAbstract && typeof(BaseItem).IsAssignableFrom(type));
    var item = (BaseItem)Activator.CreateInstance(type)!;
    foreach (var field in value.EnumerateObject().Where(field => field.Name != "Type")) {
        var property = type.GetProperty(field.Name)!;
        if (property is null || !property.CanWrite) throw new InvalidOperationException("Unsupported control: " + field.Name);
        property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, JsonDefaults.Options));
    }
    return item;
}
object Capture(BaseItem item) => new {
    Type = item.GetType().Name, item.Name, item.Path, item.IsInMixedFolder, item.ProductionYear, item.RunTimeTicks,
    item.IndexNumber, item.Overview, item.ProviderIds,
    VideoType = item is Video video ? video.VideoType.ToString() : null,
    AdditionalParts = item is Video parts ? parts.AdditionalParts : null,
    LocalAlternateVersions = item is Video versions ? versions.LocalAlternateVersions : null
};
foreach (var sample in input.EnumerateArray()) {
    var current = Create(sample.GetProperty("current"));
    var resolved = Create(sample.GetProperty("resolved"));
    var method = current.GetType().GetMethod("UpdateFromResolvedItem", BindingFlags.NonPublic | BindingFlags.Instance)!;
    object Invoke() {
        try { return new { updateType = (int)method.Invoke(current, [resolved])!, exception = (string?)null, parameter = (string?)null }; }
        catch (TargetInvocationException error) {
            var cause = error.InnerException!;
            return new { updateType = (int?)null, exception = cause.GetType().Name, parameter = (cause as ArgumentException)?.ParamName };
        }
    }
    var first = Invoke();
    var after = Capture(current);
    var assignment = current is Video destination && resolved is Video source ? new {
        additionalParts = ReferenceEquals(destination.AdditionalParts, source.AdditionalParts),
        alternateVersions = ReferenceEquals(destination.LocalAlternateVersions, source.LocalAlternateVersions)
    } : null;
    var repeat = Invoke();
    results.Add(new { name = sample.GetProperty("name").GetString(), first, after, assignment, repeat });
}
var assembly = typeof(BaseItem).Assembly;
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualNativeUpdateFromResolvedItem = true, candidateVerified = false,
    scope = "Actual BaseItem and Video UpdateFromResolvedItem via reflection. Compares mutation, update flags, exception parameters, sequence assignment and repeat invocation. Excludes ValidateChildren enumeration, repository/image/file writes and the complete library.",
    assembly = new { name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() },
    results
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
