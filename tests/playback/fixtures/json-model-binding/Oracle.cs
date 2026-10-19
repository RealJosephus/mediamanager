using System.Reflection;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.Api.Models.MediaInfoDtos;
using MediaBrowser.Model.Dlna;

var options = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true };
var definitions = new Dictionary<string, object>();
var nullability = new NullabilityInfoContext();
object Rule(Type type) {
    var underlying = Nullable.GetUnderlyingType(type);
    var actual = underlying ?? type;
    if (actual.IsEnum) return new { type = "enum", nullable = underlying is not null, clrType = actual.FullName, values = Enum.GetNames(actual).ToDictionary(name => name, name => Convert.ToInt32(Enum.Parse(actual, name))) };
    if (actual.IsArray) return new { type = "array", nullable = true, clrType = actual.FullName, item = Rule(actual.GetElementType()!) };
    var kind = actual == typeof(string) ? "string" : actual == typeof(bool) ? "boolean" : actual == typeof(int) ? "integer" : actual == typeof(long) ? "long" : actual == typeof(Guid) ? "guid" : null;
    if (kind is not null) return new { type = kind, nullable = underlying is not null || actual == typeof(string), clrType = actual.FullName };
    if (!definitions.ContainsKey(actual.FullName!)) {
        definitions[actual.FullName!] = null!;
        var defaults = JsonSerializer.SerializeToElement(Activator.CreateInstance(actual), actual, options);
        var properties = actual.GetProperties().Where(prop => prop.CanWrite).ToArray();
        definitions[actual.FullName!] = new { fields = properties.ToDictionary(prop => prop.Name, prop => Rule(prop.PropertyType)), defaults,
            required = properties.Where(prop => !prop.PropertyType.IsValueType && nullability.Create(prop).ReadState == NullabilityState.NotNull).Select(prop => prop.Name).ToArray() };
    }
    return new { type = "object", nullable = true, clrType = actual.FullName, reference = actual.FullName };
}
if (args[0] == "schema") {
    var playback = Rule(typeof(PlaybackInfoDto));
    File.WriteAllText(args[1], JsonSerializer.Serialize(new { playback, definitions }, options));
} else {
    var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
    var result = new List<object>();
    foreach (var entry in input.EnumerateArray()) {
        var name = entry.GetProperty("name").GetString();
        var json = entry.GetProperty("json").GetString()!;
        try {
            var value = JsonSerializer.Deserialize<PlaybackInfoDto>(json, options);
            result.Add(new { name, value });
        } catch (JsonException error) { result.Add(new { name, error = error.GetType().Name, error.Message, error.Path, error.LineNumber, error.BytePositionInLine }); }
        catch (Exception error) { result.Add(new { name, error = error.GetType().Name, error.Message }); }
    }
    File.WriteAllText(args[1], JsonSerializer.Serialize(result,options));
}
