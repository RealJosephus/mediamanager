using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Emby.Server.Implementations.Session;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Entities.Security;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Server.Implementations.Users;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

public static class DirectCapture {
    public static async Task<object[]> Run(JsonElement scenarios) {
        var results = new List<object>();
        foreach (var scenario in scenarios.EnumerateArray()) {
            var name = scenario.GetString()!;
            var user = new User("Direct", "fixture", "fixture") { Id = Capture.UserId, InvalidLoginAttemptCount = 4, LastLoginDate = DateTime.UnixEpoch };
            user.Permissions.Clear(); user.Permissions.Add(new(PermissionKind.IsDisabled, name == "disabled-user"));
            user.Permissions.Add(new(PermissionKind.EnableRemoteAccess, name != "remote-denied-user"));
            if (name == "session-limit") user.MaxActiveSessions = 1;
            var devices = new List<Device> { new(user.Id, "Target app", "1.2", "Target", "target-device") { AccessToken = "old-token" } };
            var calls = new List<string>();
            var users = Stub.Make<IUserManager>((m, a) => {
                switch (m.Name) {
                    case "GetUserById": return name == "missing-user" ? null : user;
                    case "GetUserByName":
                        calls.Add("username-fallback");
                        return ((UserManager)RuntimeHelpers.GetUninitializedObject(typeof(UserManager))).GetUserByName((string)a![0]!);
                    case "UpdateUserAsync": calls.Add("user-activity"); return Task.CompletedTask;
                    case "GetUserDto": return new UserDto { Id = user.Id, Name = user.Username };
                    case "AuthenticateUser": throw new InvalidOperationException("Direct authentication invoked the password provider.");
                    default: return Stub.Default(m.ReturnType);
                }
            });
            var deviceManager = Stub.Make<IDeviceManager>((m, a) => {
                switch (m.Name) {
                    case "CanAccessDevice": calls.Add("device-check"); return name != "device-denied";
                    case "GetDevices": return new QueryResult<Device> { Items = devices.ToArray(), TotalRecordCount = devices.Count };
                    case "DeleteDevice":
                        calls.Add("delete-token");
                        if (name == "delete-failure") return Task.FromException(new IOException("Controlled delete failure"));
                        devices.Remove((Device)a![0]!); return Task.CompletedTask;
                    case "CreateDevice":
                        calls.Add("create-token");
                        if (name == "insert-failure") return Task.FromException<Device>(new IOException("Controlled insert failure"));
                        var d = (Device)a![0]!; devices.Add(d); return Task.FromResult(d);
                    case "ToClientCapabilitiesDto": return new ClientCapabilitiesDto();
                    default: return Stub.Default(m.ReturnType);
                }
            });
            T Empty<T>() where T : class => Stub.Make<T>((m, a) => Stub.Default(m.ReturnType));
            var configuration = Stub.Make<IServerConfigurationManager>((m, a) => m.Name == "get_Configuration" ? new ServerConfiguration() : Stub.Default(m.ReturnType));
            var host = Stub.Make<IServerApplicationHost>((m, a) => m.Name == "get_SystemId" ? "direct-server" : Stub.Default(m.ReturnType));
            await using var manager = new SessionManager(NullLogger<SessionManager>.Instance, Empty<IEventManager>(), Empty<IUserDataManager>(), configuration,
                Empty<ILibraryManager>(), users, Empty<IMusicManager>(), Empty<IDtoService>(), Empty<IImageProcessor>(), host, deviceManager, Empty<IMediaSourceManager>(), Empty<IHostApplicationLifetime>());
            if (name == "session-limit") await manager.LogSessionActivity("Phone", "1", "phone", "Phone", null!, user);
            calls.Clear(); user.LastActivityDate = null;
            var request = new AuthenticationRequest { UserId = name == "empty-user" ? Guid.Empty : name == "missing-user" ? Guid.NewGuid() : user.Id,
                App = "Target app", AppVersion = "1.2", DeviceName = "Target", DeviceId = "target-device" };
            object? session = null; string? error = null; var status = 200;
            try {
                var result = await manager.AuthenticateDirect(request);
                session = new { result.SessionInfo.DeviceId, result.SessionInfo.DeviceName, result.SessionInfo.Client, result.SessionInfo.ApplicationVersion, result.SessionInfo.RemoteEndPoint };
            } catch (Exception e) {
                error = e.GetType().Name;
                status = e is ArgumentException ? 400 : e is MediaBrowser.Controller.Authentication.AuthenticationException ? 401 : e is MediaBrowser.Controller.Net.SecurityException ? 403 : 500;
            }
            results.Add(new { name, status, error, calls, session, deviceCount = devices.Count, oldTokenRetained = devices.Any(d => d.AccessToken == "old-token"),
                loginUnchanged = user.LastLoginDate == DateTime.UnixEpoch, user.InvalidLoginAttemptCount });
        }
        return results.ToArray();
    }
}
