using System.ComponentModel;
using System.Reflection;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Serialization;
using Emby.Server.Implementations.AppBase;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Extensions.Json;
using MediaBrowser.Model.LiveTv;

var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never, WriteIndented = true };
var types = new Dictionary<string, Type> { ["livetv"] = typeof(LiveTvOptions) };
var serializer = new MyXmlSerializer();
var inputBytes = File.ReadAllBytes(args[0]);
var outputFile = args[1];
var privateRoot = Path.Combine(Path.GetDirectoryName(outputFile)!, "private-configurations");
Directory.CreateDirectory(privateRoot);
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
try
{
    foreach (var sample in JsonDocument.Parse(inputBytes).RootElement.GetProperty("cases").EnumerateArray())
    {
        var filename = Path.Combine(privateRoot, results.Count + ".xml");
        byte[]? bytes = sample.TryGetProperty("filename", out var supplied) ? File.ReadAllBytes(supplied.GetString()!)
            : sample.TryGetProperty("text", out var text) ? Encoding.UTF8.GetBytes(text.GetString()!) : null;
        if (bytes is not null) File.WriteAllBytes(filename, bytes);
        object? value = null; string? error = null;
        try { value = serializer.DeserializeFromBytes(typeof(LiveTvOptions), bytes ?? []); }
        catch (Exception failure) { error = failure.GetType().Name; }
        var loaded = ConfigurationHelper.GetXmlConfiguration(typeof(LiveTvOptions), filename, serializer);
        results.Add(new { name = sample.GetProperty("name").GetString(), accepted = error is null, value, error,
            loaded, saved = Convert.ToBase64String(File.ReadAllBytes(filename)) });
    }
}
finally { Directory.Delete(privateRoot, true); }
var assemblies = new[] { typeof(LiveTvOptions).Assembly, typeof(MyXmlSerializer).Assembly, typeof(JsonDefaults).Assembly }
    .Distinct().Select(assembly => new { assembly.FullName, filename = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(outputFile, JsonSerializer.Serialize(new { actualXmlSerializer = true, actualConfigurationHelper = true,
    privateInputsRemoved = !Directory.Exists(privateRoot), inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    model = new { roots, definitions }, assemblies, results }, options));
