using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;

if (args.Length != 2) throw new ArgumentException("Expected the historical input JSON and a new output JSON.");
var inputBytes = File.ReadAllBytes(args[0]);
using var document = JsonDocument.Parse(inputBytes);
var inputs = document.RootElement.GetProperty("raw").GetProperty("results");
if (inputs.GetArrayLength() != 16) throw new InvalidOperationException("The original sixteen raw inputs are required.");
// This thin getter host does not instantiate CoreAppHost. Bind its supplied
// entry assembly explicitly so recordOracle can verify the same native build.
_ = Assembly.Load("jellyfin");
var sharedProperty = typeof(Playlist).GetProperty("IsSharedItem", BindingFlags.Instance | BindingFlags.NonPublic)!;
var results = new List<object>();
foreach (var row in inputs.EnumerateArray())
{
    var programDataPath = row.GetProperty("programDataPath").GetString()!;
    var dataPath = row.GetProperty("dataPath").GetString()!;
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_ProgramDataPath" => programDataPath, "get_DataPath" => dataPath, "get_TempDirectory" => programDataPath + @"\tmp",
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration(),
        _ => Stub.Default(method.ReturnType)
    });
    var parent = new Folder { Id = row.GetProperty("ParentId").GetGuid(), Path = @"Q:\external-library", Name = "External real parent" };
    var lookups = new List<string>();
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => {
        lookups.Add(method.Name);
        return method.Name switch {
            "GetItemById" => (Guid)values![0]! == parent.Id ? parent : null,
            "GetCollectionFolders" => new List<Folder>(),
            _ => throw new NotSupportedException(method.Name)
        };
    });
    var user = new User("ControlledPathUser", "controlled-auth", "controlled-reset") { Id = row.GetProperty("userId").GetGuid() };
    user.SetPermission(PermissionKind.EnableAllFolders, true);
    user.SetPreference(PreferenceKind.BlockedTags, Array.Empty<string>());
    user.SetPreference(PreferenceKind.AllowedTags, Array.Empty<string>());
    user.SetPreference(PreferenceKind.BlockUnratedItems, Array.Empty<string>());
    var playlist = new Playlist {
        Id = row.GetProperty("Id").GetGuid(), ParentId = parent.Id,
        Path = row.GetProperty("path").GetString()!, Name = "Private raw path",
        OpenAccess = row.GetProperty("OpenAccess").GetBoolean(), OwnerUserId = row.GetProperty("OwnerUserId").GetGuid(),
        Shares = row.GetProperty("shares").Deserialize<PlaylistUserPermissions[]>()!
    };
    var shared = (bool)sharedProperty.GetValue(playlist)!;
    var visible = playlist.IsVisible(user);
    var standalone = playlist.IsVisibleStandalone(user);
    results.Add(new {
        input = new { name = row.GetProperty("name").GetString(), programDataPath, dataPath, path = playlist.Path,
            playlist.Id, playlist.ParentId, playlist.OpenAccess, playlist.OwnerUserId, shares = playlist.Shares, userId = user.Id },
        isSharedItem = shared, isVisible = visible, isVisibleStandalone = standalone, libraryCalls = lookups.ToArray()
    });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
var output = new {
    actualExecution = true, inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    platform = OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux",
    runtime = RuntimeInformation.FrameworkDescription, os = RuntimeInformation.OSDescription,
    results, assemblies,
    sourceBoundary = "The same sixteen sealed raw inputs invoke the current supplied DLL's actual Playlist IsSharedItem, IsVisible and IsVisibleStandalone on this OS. Only configuration, entity lookup and empty collection membership are controlled. No database, HTTP host or media filesystem is opened."
};
using var destination = new FileStream(args[1], FileMode.CreateNew, FileAccess.Write);
JsonSerializer.Serialize(destination, output, new JsonSerializerOptions { WriteIndented = true });

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
