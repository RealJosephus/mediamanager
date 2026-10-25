using System.ComponentModel;
using System.Reflection;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Serialization;
using Emby.Server.Implementations.AppBase;
using Emby.Server.Implementations.Serialization;
using Emby.Server.Implementations;
using Jellyfin.Extensions.Json;
using MediaBrowser.Common.Net;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.System;
using MediaBrowser.Model.Branding;
using Microsoft.Extensions.Logging.Abstractions;

Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals, WriteIndented = true };
options.Converters.Insert(0, new GuidValueConverter());
var types = new Dictionary<string, Type> {
    ["server"] = typeof(ServerConfiguration), ["network"] = typeof(NetworkConfiguration), ["encoding"] = typeof(EncodingOptions),
    ["metadata"] = typeof(MetadataConfiguration), ["nfo"] = typeof(XbmcMetadataOptions), ["branding"] = typeof(BrandingOptions),
    ["tmdb"] = typeof(MediaBrowser.Providers.Plugins.Tmdb.PluginConfiguration),
};
var serializer = new MyXmlSerializer();
if (args[0] == "hold-file") {
    using var heldFile = File.Open(args[1], FileMode.Open, FileAccess.Read, args[2] == "none" ? FileShare.None : FileShare.Read);
    Console.WriteLine("READY"); Console.Out.Flush(); Console.ReadLine();
    return;
}
var consume = args[0] == "consume";
var inputFile = args[consume ? 1 : 0]; var outputFile = args[consume ? 2 : 1];
var inputBytes = File.ReadAllBytes(inputFile);
var root = Path.Combine(Path.GetDirectoryName(outputFile)!, "states"); Directory.CreateDirectory(root);
var definitions = new Dictionary<string, object>();
var aliases = types.ToDictionary(pair => pair.Value, pair => pair.Value.Name == "PluginConfiguration" ? pair.Key + "Options" : pair.Value.Name);
string Name(Type type) => aliases.TryGetValue(type, out var name) ? name : type.Name;
object Describe(Type original) {
    var nullable = Nullable.GetUnderlyingType(original); var type = nullable ?? original;
    if (type == typeof(string)) return new { kind = "string" };
    if (type == typeof(bool)) return new { kind = "boolean" };
    if (type == typeof(int) || type == typeof(long) || type == typeof(uint)) return new { kind = "integer", bits = type == typeof(long) ? 64 : 32, signed = type != typeof(uint), nullable = nullable is not null };
    if (type == typeof(double) || type == typeof(float)) return new { kind = "number", single = type == typeof(float) };
    if (type == typeof(Guid)) return new { kind = "guid", nullable = nullable is not null };
    if (type.IsEnum) return new { kind = "enum", name = Name(type), flags = type.GetCustomAttribute<FlagsAttribute>() is not null,
        members = Enum.GetNames(type).Select(name => new { name, xml = type.GetField(name)!.GetCustomAttribute<XmlEnumAttribute>()?.Name ?? name, value = Convert.ToInt64(Enum.Parse(type, name)) }).ToArray() };
    if (type.IsArray) return new { kind = "array", item = Describe(type.GetElementType()!), element = type.GetElementType() == typeof(string) ? "string" : type.GetElementType() == typeof(Guid) ? "guid" : type.GetElementType() == typeof(uint) ? "unsignedInt" : type.GetElementType() == typeof(int) ? "int" : type.GetElementType()!.Name,
        nullableItem = !type.GetElementType()!.IsValueType || Nullable.GetUnderlyingType(type.GetElementType()!) is not null };
    if (!definitions.ContainsKey(Name(type))) {
        definitions[Name(type)] = new { pending = true };
        var properties = type.GetProperties().Where(property => property.CanRead && property.CanWrite && property.SetMethod?.IsPublic == true
            && property.GetCustomAttribute<XmlIgnoreAttribute>() is null).ToArray();
        var fields = properties.ToDictionary(property => property.Name, property => new {
            type = Describe(property.PropertyType), element = property.GetCustomAttribute<XmlElementAttribute>()?.ElementName is string element && element.Length > 0 ? element : property.Name,
            nullable = property.GetCustomAttribute<XmlElementAttribute>()?.IsNullable ?? Nullable.GetUnderlyingType(property.PropertyType) is not null,
            defaultValue = property.GetCustomAttribute<DefaultValueAttribute>() is { } attribute ? JsonSerializer.SerializeToElement(attribute.Value, options) : (JsonElement?)null
        });
        var initial = Activator.CreateInstance(type);
        definitions[Name(type)] = new { xmlType = type.GetCustomAttribute<XmlTypeAttribute>()?.TypeName is string typeName && typeName.Length > 0 ? typeName : type.Name,
            fields, order = properties.OrderBy(property => Depth(property.DeclaringType!)).ThenBy(property => property.MetadataToken).Select(property => property.Name).ToArray(),
            defaults = JsonSerializer.SerializeToElement(initial, options) };
    }
    return new { kind = "object", reference = Name(type) };
}
var roots = types.ToDictionary(pair => pair.Key, pair => new { type = Describe(pair.Value),
    element = pair.Value.GetCustomAttribute<XmlRootAttribute>()?.ElementName is string element && element.Length > 0 ? element : pair.Value.Name,
    defaults = JsonSerializer.SerializeToElement(Activator.CreateInstance(pair.Value), options) });
int Depth(Type type) => type.BaseType is null ? 0 : 1 + Depth(type.BaseType);
var results = new List<object>();
foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.EnumerateArray()) {
    var alias = sample.GetProperty("root").GetString()!; var type = types[alias];
    var name = sample.GetProperty("name").GetString()!;
    var directory = Path.Combine(root, results.Count.ToString()); Directory.CreateDirectory(directory);
    var plugin = sample.TryGetProperty("plugin", out var pluginLoad) && pluginLoad.GetBoolean();
    var paths = plugin ? new ServerApplicationPaths(directory, Path.Combine(directory, "log"), Path.Combine(directory, "config"), Path.Combine(directory, "cache"), Path.Combine(directory, "web")) : null;
    var filename = consume ? Path.GetFullPath(sample.GetProperty("filename").GetString()!) : plugin
        ? Path.Combine(paths!.PluginConfigurationsPath, "Jellyfin.Plugin.Tmdb.xml") : Path.Combine(directory, "config.xml");
    byte[]? bytes = sample.TryGetProperty("bytes", out var payload) ? Convert.FromBase64String(payload.GetString()!) : null;
    if (sample.TryGetProperty("encoding", out var encoded)) {
        var encoding = Encoding.GetEncoding(encoded.GetString()!);
        bytes = encoding.GetBytes(sample.GetProperty("text").GetString()!);
        if (sample.TryGetProperty("prefix", out var prefix)) bytes = Convert.FromHexString(prefix.GetString()!).Concat(bytes).ToArray();
    }
    if (sample.TryGetProperty("canonical", out var canonical) && canonical.GetBoolean()) {
        using var stream = new MemoryStream();
        serializer.SerializeToStream(bytes is null ? Activator.CreateInstance(type)! : serializer.DeserializeFromBytes(type, bytes)!, stream); bytes = stream.ToArray();
    }
    if (!consume) {
        if (sample.TryGetProperty("directory", out var isDirectory) && isDirectory.GetBoolean()) Directory.CreateDirectory(filename);
        else if (bytes is not null) { Directory.CreateDirectory(Path.GetDirectoryName(filename)!); File.WriteAllBytes(filename, bytes); }
    }
    var beforeBytes = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
    if (sample.TryGetProperty("readOnly", out var readOnly) && readOnly.GetBoolean()) File.SetAttributes(filename, FileAttributes.ReadOnly);
    using var held = sample.TryGetProperty("locked", out var locked) && locked.GetBoolean()
        ? new FileStream(filename, FileMode.Open, FileAccess.Read, sample.TryGetProperty("lockMode", out var lockMode) && lockMode.GetString() == "none" ? FileShare.None : FileShare.Read) : null;
    object? value = null, error = null; JsonElement? observed = null;
    try {
        value = consume ? serializer.DeserializeFromFile(type, filename) : plugin
            ? new MediaBrowser.Providers.Plugins.Tmdb.Plugin(paths!, serializer).Configuration
            : sample.TryGetProperty("helper", out var helper) && helper.GetBoolean()
            ? ConfigurationHelper.GetXmlConfiguration(type, filename, serializer)
            : serializer.DeserializeFromBytes(type, bytes ?? Array.Empty<byte>());
        observed = value is null ? null : JsonSerializer.SerializeToElement(value, options);
        if (consume && sample.TryGetProperty("changes", out var changes)) {
            foreach (var change in changes.EnumerateObject()) {
                var property = type.GetProperty(change.Name)!;
                property.SetValue(value, JsonSerializer.Deserialize(change.Value.GetRawText(), property.PropertyType, options));
            }
            serializer.SerializeToFile(value!, filename);
        }
    } catch (Exception failure) { error = new { type = failure.GetType().Name, message = failure.Message, inner = failure.InnerException?.Message }; }
    held?.Dispose();
    var afterBytes = File.Exists(filename) ? Convert.ToBase64String(File.ReadAllBytes(filename)) : null;
    object? reread = null;
    try { if (afterBytes is not null) reread = serializer.DeserializeFromBytes(type, Convert.FromBase64String(afterBytes)); } catch { }
    results.Add(new { name, root = alias, accepted = error is null, value = observed, error,
        beforeBytes, afterBytes, reread = reread is null ? (JsonElement?)null : JsonSerializer.SerializeToElement(reread, options), afterDirectory = Directory.Exists(filename) });
    if (File.Exists(filename)) File.SetAttributes(filename, FileAttributes.Normal);
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).Select(assembly => new {
    name = assembly.GetName().Name, filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).OrderBy(row => row.name).ToArray();
File.WriteAllText(outputFile, JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualXmlSerializer = true, actualConfigurationHelper = !consume, actualFiles = true, actualContinuedWrite = consume,
    actualPluginConfiguration = !consume && JsonDocument.Parse(inputBytes).RootElement.EnumerateArray().Any(sample => sample.TryGetProperty("plugin", out var loaded) && loaded.GetBoolean()),
    model = new { roots, definitions }, host = new { processorCount = Environment.ProcessorCount }, assemblies, results }, options) + "\n");

public class GuidValueConverter : JsonConverter<Guid> {
    public override Guid Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => reader.GetGuid();
    public override void Write(Utf8JsonWriter writer, Guid value, JsonSerializerOptions options) => writer.WriteStringValue(value.ToString("N"));
}
