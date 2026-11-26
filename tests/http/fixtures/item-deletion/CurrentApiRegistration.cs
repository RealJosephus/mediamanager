#if CURRENT_ITEM_DELETION_ORACLE
using System.Reflection;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.DependencyInjection;

// The historical Program.cs and its project are bound to their original recording.
internal static class CurrentApiRegistration
{
    public static IMvcBuilder AddJellyfinApi(this IServiceCollection services, IEnumerable<Assembly> plugins, NetworkConfiguration network)
        => services.AddJellyfinApi(plugins, network, new ServerConfiguration());
}
#endif
