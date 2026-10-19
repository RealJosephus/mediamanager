import { validationPath } from '../validation/paths.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = validationPath(resolve('.agent-docs/oracle'));
await mkdir(root, { recursive: true });
const source = validationPath(resolve('.agent-docs/baselines/jellyfin-current/source'));
const auth = await readFile(`${source}/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs`, 'utf8');
const signature = 'public static Dictionary<string, string> GetParts(';
const start = auth.indexOf(signature);
let end = auth.indexOf('{', start) + 1;
let depth = 1;
while (depth) { if (auth[end] === '{') depth++; else if (auth[end] === '}') depth--; end++; }
const parts = auth.slice(start, end);
await writeFile(`${root}/Oracle.csproj`, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
  <ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" />
    <Compile Include="${source}/MediaBrowser.Common/Extensions/BaseExtensions.cs" Link="BaseExtensions.cs" />
    <Compile Include="${source}/MediaBrowser.Model/Cryptography/PasswordHash.cs" Link="PasswordHash.cs" />
    <Compile Include="${source}/MediaBrowser.Model/Cryptography/Constants.cs" Link="Constants.cs" />
    <Compile Include="${source}/MediaBrowser.Model/Cryptography/ICryptoProvider.cs" Link="ICryptoProvider.cs" />
    <Compile Include="${source}/Emby.Server.Implementations/Cryptography/CryptographyProvider.cs" Link="CryptographyProvider.cs" />
  </ItemGroup>
</Project>`);
await writeFile(`${root}/Program.cs`, `using System.Globalization;
using System.Text.Json;
using System.Net;
using MediaBrowser.Common.Extensions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Localization;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

var mode = args.FirstOrDefault() ?? "identity";
if (mode == "password-edge") {
    var crypto = new Emby.Server.Implementations.Cryptography.CryptographyProvider();
    var results = new List<object>();
    foreach (var input in new [] { "$a", "$a$", "$a$x=1", "$a$x=1$", "$a$x=1,", "$a$x=1,$", "$a$x=1$00", "$a$x=1$00$FF", "$a$x=1$00$", "$a$00$FF", "$a$00$FF$", "$a$00$\\n", "$a$x=1,,y=2" }) {
        try { results.Add(new { input, canonical = MediaBrowser.Model.Cryptography.PasswordHash.Parse(input).ToString() }); }
        catch (Exception ex) { results.Add(new { input, exception = ex.GetType().Name, error = ex.Message }); }
    }
    var integers = new List<object>();
    foreach(var input in new [] { "1", " 1 ", "\\u00A01\\u00A0", "\\u20281\\u2028", "\\t1\\r", "1\\0", "+1", "-0", "01", "1.0" }) {
        var valid = int.TryParse(input, CultureInfo.InvariantCulture, out var value);
        integers.Add(new { input, valid, value });
    }
    var unicode = new List<object>();
    foreach (var password in new string?[] { null, "", "\\uD800", "\\uFFFD" }) {
        try { unicode.Add(new { input = password is null ? "null" : password.Length == 0 ? "empty" : ((int)password[0]).ToString(), hash = crypto.CreatePasswordHash(password).ToString() }); }
        catch (Exception ex) { unicode.Add(new { input = password is null ? "null" : ((int)password[0]).ToString(), exception = ex.GetType().Name, error = ex.Message }); }
    }
    Console.WriteLine(JsonSerializer.Serialize(new { results, integers, unicode }));
} else if (mode == "json") {
    var assembly = System.Runtime.Loader.AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.GetFullPath(args[1]));
    var options = (JsonSerializerOptions)assembly.GetType("Jellyfin.Extensions.Json.JsonDefaults")!.GetProperty("CamelCaseOptions")!.GetValue(null)!;
    var value = new { ProviderIds = new Dictionary<string,string?> { ["Tmdb"] = "123", ["Imdb"] = "tt", ["Missing"] = null },
        NullValue = (string?)null, Values = new object?[] { null, 1 }, URL = "x", UserId = "y", IsHD = true };
    Console.WriteLine(JsonSerializer.Serialize(value, options));
} else if (mode == "password") {
    var crypto = new Emby.Server.Implementations.Cryptography.CryptographyProvider();
    var passwords = new[] { "test password", "中文密码", "" };
    Console.WriteLine(JsonSerializer.Serialize(passwords.Select(password => new { password, hash = crypto.CreatePasswordHash(password).ToString() })));
} else if (mode == "routes") {
    var directory = Path.GetFullPath(args[1]);
    System.Runtime.Loader.AssemblyLoadContext.Default.Resolving += (context, name) => {
        var path = Path.Combine(directory, name.Name + ".dll");
        return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
    };
    var rows = new List<object>();
    foreach (var assemblyName in new[] { "Jellyfin.Api.dll", "MediaBrowser.Providers.dll" }) {
        var assembly = System.Runtime.Loader.AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, assemblyName));
        foreach (var type in assembly.GetTypes().Where(type => type.Name.EndsWith("Controller") && !type.IsAbstract)) {
            foreach (var method in type.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.DeclaredOnly)) {
                var attributes = method.GetCustomAttributesData();
                if (!attributes.Any(attribute => attribute.AttributeType.Name.StartsWith("Http") && attribute.AttributeType.Name.EndsWith("Attribute"))) continue;
                var classAttributes = new List<object>();
                for (var baseType = type; baseType != null; baseType = baseType.BaseType) foreach (var attribute in baseType.GetCustomAttributesData()) classAttributes.Add(Describe(attribute));
                rows.Add(new { controller = type.FullName, action = method.Name, attributes = attributes.Select(Describe), classAttributes,
                    parameters = method.GetParameters().Select(parameter => new { name = parameter.Name, type = parameter.ParameterType.ToString(), optional = parameter.IsOptional,
                        defaultValue = parameter.HasDefaultValue ? parameter.DefaultValue?.ToString() : null, attributes = parameter.GetCustomAttributesData().Select(Describe) }) });
            }
        }
    }
    Console.WriteLine(JsonSerializer.Serialize(rows));
} else if (mode == "lower") {
    var mappings = new Dictionary<string, string>();
    for (int i = 0; i <= 0x10ffff; i++) {
        if (i >= 0xd800 && i <= 0xdfff) continue;
        var value = char.ConvertFromUtf32(i);
        var lower = value.ToLowerInvariant();
        if (lower != value) mappings[value] = lower;
    }
    Console.WriteLine(JsonSerializer.Serialize(mappings));
} else if (mode == "identity") {
    var cases = new[] { "abc", "MovieD:/电影/ABC.mkv", "İ", "ΟΣ", "ẞ", "𝔸", "𐐀", "A\\u030a", "" };
    Console.WriteLine(JsonSerializer.Serialize(cases.Select(value => new { input = value, lower = value.ToLowerInvariant(), md5 = value.GetMD5().ToString("N") })));
} else if (mode == "auth") {
    var lines = JsonSerializer.Deserialize<string[]>(File.ReadAllText(args[1]))!;
    Console.WriteLine(JsonSerializer.Serialize(lines.Select(value => new { input = value, parts = Auth.GetParts(value) })));
} else if (mode == "locale") {
    var cases = JsonSerializer.Deserialize<List<LocaleCase>>(File.ReadAllText(args[1]))!;
    var results = new List<object>();
    foreach (var item in cases) {
        var options = new RequestLocalizationOptions { DefaultRequestCulture = new RequestCulture("en-US"),
            SupportedCultures = new[] { new CultureInfo("en-US"), new CultureInfo("zh-CN") },
            SupportedUICultures = new[] { new CultureInfo("en-US"), new CultureInfo("zh-CN") }, ApplyCurrentCultureToResponseHeaders = true };
        var context = new DefaultHttpContext();
        context.Request.QueryString = new QueryString(item.query ?? "");
        if (item.cookie != null) context.Request.Headers.Cookie = item.cookie;
        if (item.header != null) context.Request.Headers.AcceptLanguage = item.header;
        var middleware = new RequestLocalizationMiddleware(ctx => {
            results.Add(new { input = item, culture = CultureInfo.CurrentCulture.Name, uiCulture = CultureInfo.CurrentUICulture.Name,
                contentLanguage = ctx.Response.Headers.ContentLanguage.ToString() });
            return Task.CompletedTask;
        }, Options.Create(options), NullLoggerFactory.Instance);
        await middleware.Invoke(context);
    }
    Console.WriteLine(JsonSerializer.Serialize(results));
}
static object Describe(System.Reflection.CustomAttributeData attribute) => new { type = attribute.AttributeType.FullName,
    arguments = attribute.ConstructorArguments.Select(value => value.Value?.ToString()),
    named = attribute.NamedArguments.ToDictionary(value => value.MemberName, value => value.TypedValue.Value?.ToString()) };
record LocaleCase(string? query, string? cookie, string? header);
static class Auth {
${parts}
}
`);
console.log(root);
