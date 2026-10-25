// Validation only: executes the frozen Jellyfin assemblies, never a product dependency.
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
var api = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Jellyfin.Api.dll"));
Console.InputEncoding = System.Text.Encoding.UTF8;
Console.OutputEncoding = System.Text.Encoding.UTF8;
string? line;
while ((line = Console.ReadLine()) is not null) {
    try {
        var input = JsonDocument.Parse(line).RootElement;
        if (input.GetProperty("kind").GetString() == "date") {
            var value = JsonSerializer.Deserialize<DateTime>(input.GetProperty("source").GetString()!, options);
            Console.WriteLine(JsonSerializer.Serialize(new { ticks = value.Ticks.ToString(), kind = value.Kind.ToString(), wire = JsonSerializer.Serialize(value, options) }));
        } else {
            var type = api.GetType("Jellyfin.Api.Models.SyncPlayDtos." + input.GetProperty("name").GetString())!;
            var value = JsonSerializer.Deserialize(input.GetProperty("source").GetString()!, type, options);
            var dates = value is null ? null : type.GetProperties().Where(property => property.PropertyType == typeof(DateTime)).ToDictionary(property => property.Name, property => {
                var date = (DateTime)property.GetValue(value)!;
                return new { ticks = date.Ticks.ToString(), kind = date.Kind.ToString() };
            });
            Console.WriteLine(JsonSerializer.Serialize(new { value = JsonDocument.Parse(JsonSerializer.Serialize(value, type, options)).RootElement.Clone(), dates }));
        }
    } catch (Exception error) {
        if (error is JsonException json) Console.WriteLine(JsonSerializer.Serialize(new { error = error.GetType().Name, json.Message, json.Path, json.LineNumber, json.BytePositionInLine }));
        else Console.WriteLine(JsonSerializer.Serialize(new { error = error.GetType().Name, error.Message }));
    }
}
