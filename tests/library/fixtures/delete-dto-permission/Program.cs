using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Playlists;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Configuration;
using Jellyfin.Server.Extensions;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Common.Net;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var current = new Capture();
var initialItems = current.Items.Values.Select(item => new {
    item.Id, item.Name, Type = item.GetType().FullName, item.Path, item.ParentId, item.OwnerId,
    item.IsFolder, IsRoot = item is Folder folder && folder.IsRoot, SourceType = item.SourceType.ToString(),
    OwnerUserId = item is Playlist playlist ? playlist.OwnerUserId : Guid.Empty,
    OpenAccess = item is Playlist shared && shared.OpenAccess,
    PhysicalLocationsList = item is CollectionFolder collection ? collection.PhysicalLocationsList : Array.Empty<string>()
}).ToArray();
var permissionMatrix = new List<object>();
foreach (var policy in input.GetProperty("permissionPolicies").EnumerateArray()) {
  foreach (var claim in input.GetProperty("claims").EnumerateArray()) {
    current.Reset(JsonSerializer.SerializeToElement(new { policy = policy.GetString(), claim = claim.GetString() }));
    var folders = current.Root.Children.OfType<Folder>().ToList();
    permissionMatrix.Add(new { policy = policy.GetString(), claim = claim.GetString(), items = current.Items.Values.Select(item => new {
        id = item.Id.ToString("N"), noUser = item.CanDelete(), user = item.CanDelete(current.User),
        precomputed = item.CanDelete(current.User, folders) }).ToArray() });
  }
}
var assemblyTypes = new[] { typeof(LibraryController), typeof(LibraryManager), typeof(BaseItem), typeof(User), typeof(ApiServiceCollectionExtensions) };
var assemblies = assemblyTypes.Select(type => type.Assembly).Distinct().Select(assembly => new {
    name = assembly.GetName().Name, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).ToArray();
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenPrecomputedDeletePermission = true,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), assemblies, initialItems, permissionMatrix }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
