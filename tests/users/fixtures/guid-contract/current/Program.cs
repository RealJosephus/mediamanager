using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Playlists;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var candidateBytes = File.ReadAllBytes(args[1]);
var specification = JsonSerializer.Deserialize<Input>(inputBytes)!;
using var candidateDocument = JsonDocument.Parse(candidateBytes);
var inputSha256 = Hash(inputBytes);
if (candidateDocument.RootElement.GetProperty("inputSha256").GetString() != inputSha256)
{
    throw new InvalidOperationException("Candidate data belongs to another input.");
}

object ExecuteGuid(Func<Guid?> operation, bool nullable)
{
    try
    {
        var value = operation();
        var serialized = nullable ? JsonSerializer.Serialize(value, JsonDefaults.Options)
            : JsonSerializer.Serialize(value!.Value, JsonDefaults.Options);
        var reread = nullable ? JsonSerializer.Deserialize<Guid?>(serialized, JsonDefaults.Options)
            : JsonSerializer.Deserialize<Guid>(serialized, JsonDefaults.Options);
        return new { supported = true, success = true, value = value?.ToString("D"), serialized,
            rereadValue = reread?.ToString("D"), failure = (object?)null };
    }
    catch (Exception error)
    {
        return new { supported = true, success = false, value = (string?)null, serialized = (string?)null,
            rereadValue = (string?)null, failure = Diagnostic(error) };
    }
}

BaseItem ReadItem(Type type, string data) => BaseItemMapper.DeserializeBaseItem(new BaseItemEntity
{
    Id = Guid.Parse("cb210000-0000-0000-0000-000000000009"), Type = type.FullName!, Data = data,
    Name = "Current GUID contract", SortName = "current guid contract"
}, NullLogger.Instance, null) ?? throw new InvalidOperationException("The actual mapper did not return an item.");

object ReadPlaylist(string data)
{
    try
    {
        var item = (Playlist)ReadItem(typeof(Playlist), data);
        var canonicalJson = JsonSerializer.Serialize(new { item.OwnerUserId, item.OpenAccess }, JsonDefaults.Options);
        var reread = (Playlist)ReadItem(typeof(Playlist), canonicalJson);
        return new { supported = true, success = true,
            value = new { owner = item.OwnerUserId.ToString("N"), openAccess = item.OpenAccess }, canonicalJson,
            canonicalValue = new { owner = reread.OwnerUserId.ToString("N"), openAccess = reread.OpenAccess }, failure = (object?)null };
    }
    catch (Exception error)
    {
        return new { supported = true, success = false, value = (object?)null, canonicalJson = (string?)null,
            canonicalValue = (object?)null, failure = Diagnostic(error) };
    }
}

object ReadUserView(string data)
{
    try
    {
        var item = (UserView)ReadItem(typeof(UserView), data);
        var canonicalJson = JsonSerializer.Serialize(new { item.UserId, item.DisplayParentId }, JsonDefaults.Options);
        var reread = (UserView)ReadItem(typeof(UserView), canonicalJson);
        return new { supported = true, success = true,
            value = new { userId = item.UserId?.ToString("N"), displayParentId = item.DisplayParentId.ToString("N") }, canonicalJson,
            canonicalValue = new { userId = reread.UserId?.ToString("N"), displayParentId = reread.DisplayParentId.ToString("N") },
            failure = (object?)null };
    }
    catch (Exception error)
    {
        return new { supported = true, success = false, value = (object?)null, canonicalJson = (string?)null,
            canonicalValue = (object?)null, failure = Diagnostic(error) };
    }
}

var cases = specification.Cases.Select(sample =>
{
    var playlistData = "{\"OwnerUserId\":" + sample.Value.GetRawText() + ",\"OpenAccess\":true}";
    var userViewData = "{\"UserId\":" + sample.Value.GetRawText()
        + ",\"DisplayParentId\":\"cb210000-0000-0000-0000-000000000007\"}";
    return new
    {
        sample.Name, value = sample.Value,
        guidParse = sample.Value.ValueKind is JsonValueKind.String or JsonValueKind.Null
            ? ExecuteGuid(() => Guid.Parse(sample.Value.ValueKind == JsonValueKind.Null ? null! : sample.Value.GetString()!), false)
            : (object)new { supported = false },
        jsonGuid = ExecuteGuid(() => JsonSerializer.Deserialize<Guid>(sample.Value.GetRawText(), JsonDefaults.Options), false),
        nullableJsonGuid = ExecuteGuid(() => JsonSerializer.Deserialize<Guid?>(sample.Value.GetRawText(), JsonDefaults.Options), true),
        playlistData, playlist = ReadPlaylist(playlistData), userViewData, userView = ReadUserView(userViewData)
    };
}).ToArray();

object ReadCandidate(JsonElement row, string property, Func<string, object> reader)
{
    var candidate = row.GetProperty(property);
    return candidate.GetProperty("success").GetBoolean()
        ? reader(candidate.GetProperty("serializedData").GetString()!)
        : new { supported = false, success = false, value = (object?)null };
}
var nodeReads = candidateDocument.RootElement.GetProperty("cases").EnumerateArray().Select(row => new
{
    Name = row.GetProperty("Name").GetString(), playlist = ReadCandidate(row, "playlist", ReadPlaylist),
    userView = ReadCandidate(row, "userView", ReadUserView)
}).ToArray();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .OrderBy(value => value.GetName().Name).Select(value => new { name = value.GetName().Name, filename = value.Location,
        sha256 = Hash(File.ReadAllBytes(value.Location)) }).ToArray();
File.WriteAllText(args[2], JsonSerializer.Serialize(new
{
    actualExecution = true, actualGuidParse = true, actualJsonGuidConverter = true, actualJsonDefaults = true,
    actualBaseItemMapper = true, mediaOpened = false, portOpened = false, inputSha256,
    candidateSha256 = Hash(candidateBytes), cases, nodeReads, assemblies,
    dotnetRuntime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine(JsonSerializer.Serialize(new { cases = cases.Length, actualBaseItemMapper = true }));

static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static object Diagnostic(Exception error) => new { type = error.GetType().FullName, error.Message };
public sealed class Input { public Sample[] Cases { get; set; } = []; }
public sealed class Sample { public string Name { get; set; } = ""; public JsonElement Value { get; set; } }
