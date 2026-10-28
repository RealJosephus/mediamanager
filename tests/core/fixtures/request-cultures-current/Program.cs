using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Localization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Localization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var supported = LocalizationManager.GetSupportedUICultures();
var localizationAssembly = typeof(LocalizationManager).Assembly;
var prefix = typeof(LocalizationManager).Namespace + ".Core.";
var resourceCodes = localizationAssembly.GetManifestResourceNames()
    .Where(name => name.StartsWith(prefix, StringComparison.Ordinal) && name.EndsWith(".json", StringComparison.Ordinal))
    .Select(name => name[prefix.Length..^5]).Order(StringComparer.Ordinal).ToArray();
var resolution = new List<object>();
foreach (var code in resourceCodes)
{
    try
    {
        var culture = CultureInfo.GetCultureInfo(code.Replace('_', '-'));
        resolution.Add(new { code, accepted = true, name = culture.Name });
    }
    catch (CultureNotFoundException error)
    {
        resolution.Add(new { code, accepted = false, error = error.GetType().Name });
    }
}

var observations = new List<object>();
using var loggerFactory = LoggerFactory.Create(builder => { });
foreach (var defaultValue in input.RootElement.GetProperty("defaults").EnumerateArray())
{
    var serverCulture = defaultValue.GetString()!;
    var options = new RequestLocalizationOptions
    {
        SupportedCultures = supported,
        SupportedUICultures = supported,
        DefaultRequestCulture = new RequestCulture(serverCulture),
        ApplyCurrentCultureToResponseHeaders = true,
        FallBackToParentCultures = true,
        FallBackToParentUICultures = true
    };
    foreach (var sample in input.RootElement.GetProperty("cases").EnumerateArray())
    {
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
        CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
        var context = new DefaultHttpContext();
        if (sample.TryGetProperty("query", out var query)) context.Request.QueryString = new QueryString(query.GetString());
        if (sample.TryGetProperty("cookie", out var cookie)) context.Request.Headers.Cookie = cookie.GetString();
        if (sample.TryGetProperty("header", out var header)) context.Request.Headers.AcceptLanguage = header.GetString();
        var middleware = new RequestLocalizationMiddleware(current =>
        {
            var feature = current.Features.Get<IRequestCultureFeature>();
            observations.Add(new { name = sample.GetProperty("name").GetString(), serverCulture,
                culture = CultureInfo.CurrentCulture.Name, uiCulture = CultureInfo.CurrentUICulture.Name,
                contentLanguage = current.Response.Headers.ContentLanguage.ToString(), provider = feature?.Provider?.GetType().Name });
            return Task.CompletedTask;
        }, Options.Create(options), loggerFactory);
        await middleware.Invoke(context);
    }
}

object DescribeAssembly(Assembly assembly) => new { name = assembly.GetName().Name, filename = assembly.Location,
    sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) };
var report = new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualNativeSupportedUICultures = true,
    actualAspNetRequestLocalization = true, resourceCodes, resolution, supportedCultures = supported.Select(culture => culture.Name).ToArray(),
    observations, assemblies = new[] { DescribeAssembly(localizationAssembly), DescribeAssembly(typeof(RequestLocalizationMiddleware).Assembly),
        DescribeAssembly(typeof(CultureInfo).Assembly) } };
File.WriteAllText(args[1], JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
