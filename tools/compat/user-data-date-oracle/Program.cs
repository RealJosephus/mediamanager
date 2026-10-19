// Validation only: unmodified reference DTO and JsonDefaults date conversion.
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

var directory = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (context, name) => {
    var filename = Path.Combine(directory, name.Name + ".dll");
    return File.Exists(filename) ? context.LoadFromAssemblyPath(filename) : null;
};
var extensions = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Jellyfin.Extensions.dll"));
var model = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "MediaBrowser.Model.dll"));
var syncplay = args.Length > 1 && args[1] == "syncplay";
var api = syncplay ? AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Jellyfin.Api.dll")) : null;
var type = model.GetType("MediaBrowser.Model.Dto.UpdateUserItemDataDto")!;
var options = new JsonSerializerOptions((JsonSerializerOptions)extensions.GetType("Jellyfin.Extensions.Json.JsonDefaults")!
    .GetProperty("Options")!.GetValue(null)!) { PropertyNameCaseInsensitive = true };
Console.InputEncoding = System.Text.Encoding.UTF8;
Console.OutputEncoding = System.Text.Encoding.UTF8;
Console.WriteLine(JsonSerializer.Serialize(new { type = "environment", runtime = RuntimeInformation.FrameworkDescription,
    operatingSystem = RuntimeInformation.OSDescription, timezoneId = TimeZoneInfo.Local.Id,
    baseUtcOffset = TimeZoneInfo.Local.BaseUtcOffset.ToString(), pid = Environment.ProcessId,
    assemblies = new[] { extensions, model, api }.Where(assembly => assembly is not null).Select(assembly => new { name = assembly!.GetName().Name,
        path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }) }));
string? source;
while ((source = Console.ReadLine()) is not null) {
    if (syncplay) {
        var input = JsonDocument.Parse(source).RootElement;
        object result;
        try {
            if (input.GetProperty("kind").GetString() == "date") {
                var date = JsonSerializer.Deserialize<DateTime>(input.GetProperty("source").GetString()!, options);
                result = new { ticks = date.Ticks.ToString(CultureInfo.InvariantCulture), kind = date.Kind.ToString(), wire = JsonSerializer.Serialize(date, options) };
            } else {
                var dtoType = api!.GetType("Jellyfin.Api.Models.SyncPlayDtos." + input.GetProperty("name").GetString())!;
                var dto = JsonSerializer.Deserialize(input.GetProperty("source").GetString()!, dtoType, options);
                var dates = dto is null ? null : dtoType.GetProperties().Where(property => property.PropertyType == typeof(DateTime)).ToDictionary(property => property.Name, property => {
                    var date = (DateTime)property.GetValue(dto)!;
                    return new { ticks = date.Ticks.ToString(CultureInfo.InvariantCulture), kind = date.Kind.ToString() };
                });
                result = new { value = JsonDocument.Parse(JsonSerializer.Serialize(dto, dtoType, options)).RootElement.Clone(), dates };
            }
        } catch (Exception error) {
            result = error is JsonException json ? new { error = error.GetType().Name, json.Message, json.Path, json.LineNumber, json.BytePositionInLine }
                : (object)new { error = error.GetType().Name, error.Message };
        }
        Console.WriteLine(JsonSerializer.Serialize(new { input, result }));
        continue;
    }
    var value = JsonSerializer.Deserialize(source, type, options)!;
    var userDate = (DateTime)type.GetProperty("LastPlayedDate")!.GetValue(value)!;
    Console.WriteLine(JsonSerializer.Serialize(new { source, value = new { ticks = userDate.Ticks.ToString(CultureInfo.InvariantCulture),
        kind = userDate.Kind.ToString(), utcTicks = userDate.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
        stored = userDate.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture) } }));
}
