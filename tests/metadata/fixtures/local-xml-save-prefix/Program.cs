using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using Emby.Server.Implementations.IO;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.LocalMetadata.Savers;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var stateRoot = Path.GetFullPath(args[0]); Directory.CreateDirectory(stateRoot);
var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
    "get_ProgramDataPath" => stateRoot, "get_DataPath" => Path.Combine(stateRoot, "data"),
    "get_InternalMetadataPath" => Path.Combine(stateRoot, "metadata"), _ => Stub.Default(method.ReturnType)
});
var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
    "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration { SaveMetadataHidden = false },
    _ => Stub.Default(method.ReturnType)
});
var actualFileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
BaseItem.ConfigurationManager = config; BaseItem.FileSystem = actualFileSystem;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var results = new List<object>();
var memberId = Guid.Parse("cd310000-0000-0000-0000-000000000002");
foreach (var sample in new[] {
    new { name = "existing-linked-lookup-failure", existing = true, fault = "links" },
    new { name = "absent-linked-lookup-failure", existing = false, fault = "links" },
    new { name = "existing-people-lookup-failure", existing = true, fault = "people" },
    new { name = "existing-success-control", existing = true, fault = "none" }, new { name = "existing-invalid-text-failure", existing = true, fault = "xml" }
}) {
    var directory = Path.Combine(stateRoot, sample.name); Directory.CreateDirectory(directory);
    var target = Path.Combine(directory, "collection.xml");
    var previous = Encoding.UTF8.GetBytes("<?xml version=\"1.0\"?><Item><LocalTitle>Previous complete collection</LocalTitle><CollectionItems><CollectionItem><Path>old.mkv</Path></CollectionItem></CollectionItems></Item>");
    if (sample.existing) File.WriteAllBytes(target, previous);
    var actions = new List<object>();
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetPeople") {
            actions.Add(new { action = "people", length = new FileInfo(target).Length });
            if (sample.fault == "people") throw new IOException("Controlled people lookup failure");
            return new List<PersonInfo>();
        }
        if (method.Name == "GetItemList") {
            var query = (InternalItemsQuery)values![0]!;
            actions.Add(new { action = "linked-items", length = new FileInfo(target).Length,
                query.ItemIds, fields = query.DtoOptions.Fields, query.DtoOptions.EnableImages });
            if (sample.fault == "links") throw new IOException("Controlled linked-item lookup failure");
            return new BaseItem[] { new Movie { Id = memberId, Path = "Z:\\NeutralMedia\\member.mkv" } };
        }
        return Stub.Default(method.ReturnType);
    });
    var fileSystem = Stub.Make<MediaBrowser.Model.IO.IFileSystem>((method, values) => {
        if (method.Name is "SetAttributes" or "SetHidden") actions.Add(new { action = method.Name, path = Path.GetFileName((string)values![0]!) });
        return Stub.Forward(actualFileSystem, method, values);
    });
    var item = new BoxSet { Id = Guid.Parse("cd310000-0000-0000-0000-000000000001"),
        Path = directory, Name = "New common title", Overview = sample.fault == "xml" ? "Before \0 after" : "New overview", OfficialRating = "PG",
        DateCreated = new DateTime(2026, 10, 13, 0, 0, 0, DateTimeKind.Utc),
        LinkedChildren = [new LinkedChild { ItemId = memberId, Type = LinkedChildType.Manual }] };
    BaseItem.LibraryManager = library;
    object? failure = null;
    try { await new BoxSetXmlSaver(fileSystem, config, library, NullLogger<BoxSetXmlSaver>.Instance).SaveAsync(item, CancellationToken.None); }
    catch (Exception error) { failure = new { type = error.GetType().Name, error.Message }; }
    var bytes = File.Exists(target) ? File.ReadAllBytes(target) : null;
    object? parseFailure = null;
    if (bytes is not null) try { using var reader = XmlReader.Create(new MemoryStream(bytes)); while (reader.Read()) {} }
        catch (Exception error) { parseFailure = new { type = error.GetType().Name, error.Message }; }
    results.Add(new { sample.name, sample.existing, sample.fault, actions, failure, parseFailure,
        previousLength = sample.existing ? previous.Length : (int?)null, previousSha256 = sample.existing ? Hash(previous) : null,
        fileExists = File.Exists(target), finalLength = bytes?.Length, finalSha256 = bytes is null ? null : Hash(bytes),
        changed = bytes is not null && (!sample.existing || !bytes.SequenceEqual(previous)),
        body = bytes is null ? null : Encoding.UTF8.GetString(bytes), relativePath = Path.GetRelativePath(stateRoot, target).Replace('\\', '/') });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(value => !value.IsDynamic && !string.IsNullOrEmpty(value.Location))
    .OrderBy(value => value.GetName().Name).Select(value => new { name = value.GetName().Name, location = value.Location,
        sha256 = Hash(File.ReadAllBytes(value.Location)) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualBaseXmlSaver = true, actualBoxSetXmlSaver = true,
    actualManagedFileSystem = true, peopleAndLinkedRepositoryControlled = true, databaseOpened = false, portOpened = false,
    phaseAcceptance = false, results, assemblies }, new JsonSerializerOptions { WriteIndented = true }) + "\n", new UTF8Encoding(false));
Console.WriteLine(JsonSerializer.Serialize(new { cases = results.Count }));
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); }
        catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
