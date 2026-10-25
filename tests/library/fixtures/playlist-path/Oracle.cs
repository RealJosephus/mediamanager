using System.Reflection;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
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
using Microsoft.Extensions.Logging.Abstractions;

if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("This oracle requires the actual Windows runtime.");
Guid Id(int i) => Guid.Parse($"a9700000-0000-0000-0000-{i:000000000000}");
const string programDataPath = @"D:\private-playlist-oracle";
const string dataPath = @"D:\private-playlist-oracle\data";
var paths = Stub.Make<IServerApplicationPaths>((method,args) => method.Name switch {
    "get_ProgramDataPath" => programDataPath, "get_DataPath" => dataPath, "get_TempDirectory" => @"D:\private-playlist-oracle\tmp",
    _ => Stub.Default(method.ReturnType) });
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
BaseItem.FileSystem = fileSystem;
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method,args) => method.Name switch {
    "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration(), _ => Stub.Default(method.ReturnType) });
var parent = new Folder { Id = Id(1), Path = @"Q:\external-library", Name = "External real parent" };
var lookups = new List<string>();
BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method,args) => {
    lookups.Add(method.Name);
    return method.Name switch {
        "GetItemById" => (Guid)args![0]! == parent.Id ? parent : null,
        "GetCollectionFolders" => new List<Folder>(),
        _ => throw new NotSupportedException(method.Name) };
});
var user = new User("ControlledPathUser", "controlled-auth", "controlled-reset") { Id = Id(2) };
user.SetPermission(PermissionKind.EnableAllFolders, true);
user.SetPreference(PreferenceKind.BlockedTags, Array.Empty<string>());
user.SetPreference(PreferenceKind.AllowedTags, Array.Empty<string>());
user.SetPreference(PreferenceKind.BlockUnratedItems, Array.Empty<string>());
var inputs = new (string name, string? itemPath)[] {
    ("equal-root", dataPath), ("equal-root-trailing", dataPath + "\\"), ("direct-child", dataPath + "\\private.m3u"),
    ("nested-child", dataPath + "\\playlists\\private.m3u"), ("dot-child", dataPath + "\\.\\private.m3u"),
    ("dot-escape", dataPath + "\\..\\outside.m3u"), ("double-dot-escape", dataPath + "\\playlists\\..\\..\\outside.m3u"),
    ("normalized-enter", @"D:\private-playlist-oracle\other\..\data\private.m3u"),
    ("case-only", @"d:\PRIVATE-PLAYLIST-ORACLE\DATA\private.m3u"),
    ("boundary-alternate-separator", dataPath + "/private.m3u"),
    ("prefix-alternate-separators", "D:/private-playlist-oracle/data/private.m3u"),
    ("one-prefix-alternate-separator", "D:\\private-playlist-oracle/data\\private.m3u"),
    ("prefix-lookalike", dataPath + "x\\private.m3u"), ("unrelated", @"Q:\external-library\private.m3u"),
    ("null-path", null), ("empty-path", "") };
var sharedProperty = typeof(Playlist).GetProperty("IsSharedItem", BindingFlags.Instance | BindingFlags.NonPublic)!;
var results = new List<object>();
foreach (var input in inputs) {
    var playlist = new Playlist { Id = Id(3), ParentId = parent.Id, Path = input.itemPath!, Name = "Private raw path",
        OpenAccess = false, OwnerUserId = Id(4), Shares = [] };
    lookups.Clear();
    bool? contains = null; object? containsError = null;
    try { contains = fileSystem.ContainsSubPath(dataPath, input.itemPath!); }
    catch (Exception error) { containsError = new { type = error.GetType().Name, error.Message }; }
    var shared = (bool)sharedProperty.GetValue(playlist)!;
    var visible = playlist.IsVisible(user); var standalone = playlist.IsVisibleStandalone(user);
    results.Add(new { input.name, programDataPath, dataPath, path = playlist.Path, playlist.Id, playlist.ParentId,
        playlist.OpenAccess, playlist.OwnerUserId, shares = playlist.Shares, userId = user.Id,
        contains, containsError, isSharedItem = shared, isVisible = visible, isVisibleStandalone = standalone, libraryCalls = lookups.ToArray() });
}
var subpathControls = new List<object>();
foreach (var input in new (string name,string parent,string value)[] {
    ("parent-trailing-separator", dataPath + "\\", dataPath + "\\private"),
    ("parent-two-trailing-separators", dataPath + "\\\\", dataPath + "\\private"),
    ("parent-dot-not-normalized", dataPath + "\\.", dataPath + "\\private"),
    ("drive-root-equal", "D:\\", "D:\\"), ("drive-root-child", "D:\\", "D:\\child"),
    ("root-forward-prefix", "D:/private-playlist-oracle/data", "D:/private-playlist-oracle/data/child"),
    ("unix-looking-case-on-windows", "/Media/Data", "/media/data/child") })
    subpathControls.Add(new { input.name, input.parent, input.value, actual = fileSystem.ContainsSubPath(input.parent,input.value),
        trimmedParent = Path.TrimEndingDirectorySeparator(input.parent), Windows = OperatingSystem.IsWindows() });
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
        sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
Console.WriteLine(JsonSerializer.Serialize(new { actualFrozenPlaylistGetter = true, actualFrozenManagedFileSystem = true,
    actualFrozenVisibility = true, Windows = OperatingSystem.IsWindows(), runtime = RuntimeInformation.FrameworkDescription,
    os = RuntimeInformation.OSDescription, processId = Environment.ProcessId, directorySeparator = Path.DirectorySeparatorChar,
    alternateSeparator = Path.AltDirectorySeparatorChar, results, subpathControls, assemblies, phaseAcceptance = false,
    sourceBoundary = "Unmodified frozen ManagedFileSystem.ContainsSubPath and Playlist.IsSharedItem (private actual getter reflected), IsVisible and IsVisibleStandalone on real Windows. Actual ManagedFileSystem constructed with NullLogger and controlled application paths. DispatchProxy controls only configuration and entity lookup/empty collection membership; private Playlists have real Folder parent, no ownership/shares/open access, unconstrained user parental policy. No path, shared or visibility result is mocked. No DB, host, port or filesystem writes by oracle." }, new JsonSerializerOptions { WriteIndented = true }));
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method,object?[]? args) => Handler(method!,args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class { var proxy = Create<T,Stub>(); ((Stub)(object)proxy).Handler=handler; return proxy; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
