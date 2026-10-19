// Validation only: executes the frozen Jellyfin DTO and converters.
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

var directory = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var file = Path.Combine(directory, name.Name + ".dll");
    return File.Exists(file) ? context.LoadFromAssemblyPath(file) : null;
};
var extensions = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Jellyfin.Extensions.dll"));
var options = new JsonSerializerOptions((JsonSerializerOptions)extensions.GetType("Jellyfin.Extensions.Json.JsonDefaults")!.GetProperty("Options")!.GetValue(null)!) { PropertyNameCaseInsensitive = true };
var model = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "MediaBrowser.Model.dll"));
var type = model.GetType("MediaBrowser.Model.Dto.UpdateUserItemDataDto")!;
Console.InputEncoding = System.Text.Encoding.UTF8;
Console.OutputEncoding = System.Text.Encoding.UTF8;
string? source;
while ((source = Console.ReadLine()) is not null) {
    try {
        var value = JsonSerializer.Deserialize(source, type, options);
        var fields = value is null ? null : type.GetProperties().ToDictionary(property => property.Name, property => {
            var field = property.GetValue(value);
            if (field is DateTime date) return (object)new { ticks = date.Ticks.ToString(), kind = date.Kind.ToString(), utcTicks = date.ToUniversalTime().Ticks.ToString(), stored = date.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture) };
            if (field is long integer) return new Dictionary<string, string> { ["$integer"] = integer.ToString(CultureInfo.InvariantCulture) };
            if (field is double number && !double.IsFinite(number)) return new Dictionary<string, string> { ["$float"] = number.ToString(CultureInfo.InvariantCulture) };
            return field;
        });
        Console.WriteLine(JsonSerializer.Serialize(new { value = fields }));
    } catch (Exception error) {
        if (error is JsonException json) Console.WriteLine(JsonSerializer.Serialize(new { error = error.GetType().Name, json.Message, json.Path, json.LineNumber, json.BytePositionInLine }));
        else Console.WriteLine(JsonSerializer.Serialize(new { error = error.GetType().Name, error.Message }));
    }
}
