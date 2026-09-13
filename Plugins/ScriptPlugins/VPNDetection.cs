#:package RaidMax.IW4MAdmin.SharedLibraryCore@2026.1.6.1

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Data.Abstractions;
using Microsoft.EntityFrameworkCore;
using SharedLibraryCore.Database.Models;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SharedLibraryCore;
using SharedLibraryCore.Commands;
using SharedLibraryCore.Configuration;
using SharedLibraryCore.Events.Management;
using SharedLibraryCore.Helpers;
using SharedLibraryCore.Interfaces;
using SharedLibraryCore.Interfaces.Events;

/// <summary>
/// VPN Detection Plugin - checks connecting clients against a proxy/VPN lookup service and kicks
/// anyone using a VPN unless they have been whitelisted. Ported from the legacy VPNDetection.js
/// Jint script with a C#-first design (typed config, HttpClient, command classes, inlined EF query).
/// </summary>
public class VpnDetectionPlugin : IPluginV2
{
    public static void RegisterDependencies(IServiceCollection serviceCollection)
    {
        serviceCollection.AddConfiguration("VPNDetectionSettings", new VpnDetectionConfiguration());
    }

    public string Name => "VPN Detection Plugin";
    public string Author => "RaidMax";
    public string Version => "2.2";

    private const string VpnWhitelistKey = "Webfront::Profile::VPNWhitelist";
    private const string VpnAllowListKey = "Webfront::Nav::Admin::VPNAllowList";

    private static readonly HttpClient HttpClient = new() { Timeout = TimeSpan.FromSeconds(10) };

    private readonly ILogger<VpnDetectionPlugin> _logger;
    private readonly VpnDetectionConfiguration _config;
    private readonly IInteractionRegistration _interactionRegistration;
    private readonly IDatabaseContextFactory _contextFactory;
    private readonly ApplicationConfiguration _appConfig;
    private readonly HashSet<string> _blockedAsns;

    public VpnDetectionPlugin(
        ILogger<VpnDetectionPlugin> logger,
        VpnDetectionConfiguration config,
        IInteractionRegistration interactionRegistration,
        IDatabaseContextFactory contextFactory,
        IManager manager)
    {
        _logger = logger;
        _config = config;
        _interactionRegistration = interactionRegistration;
        _contextFactory = contextFactory;
        _appConfig = manager.GetApplicationSettings().Configuration();
        _blockedAsns = new HashSet<string>(
            _config.BlockedAsns.Select(NormalizeAsn).Where(asn => asn is not null),
            StringComparer.OrdinalIgnoreCase);

        IManagementEventSubscriptions.ClientStateAuthorized += OnClientAuthorized;

        RegisterInteractions();

        _logger.LogInformation("{Name} {Version} by {Author} loaded. Enabled={Enabled}, Whitelisted={Count}, Provider={Provider}, BlockedAsns={AsnCount}",
            Name, Version, Author, _config.Enabled, _config.VpnExceptionIds.Count,
            string.IsNullOrWhiteSpace(_config.ProxyCheckApiKey) ? "xdefcon" : "proxycheck.io", _blockedAsns.Count);
    }

    private void RegisterInteractions()
    {
        _interactionRegistration.UnregisterInteraction(VpnWhitelistKey);
        _interactionRegistration.UnregisterInteraction(VpnAllowListKey);

        // Per-profile toggle button: whitelist a client, or disallow an already-whitelisted one.
        _interactionRegistration.RegisterInteraction(VpnWhitelistKey, (clientId, game, token) =>
        {
            var loc = Utilities.CurrentLocalization.LocalizationIndex;
            var interaction = new InteractionData
            {
                InteractionId = VpnWhitelistKey,
                ActionPath = "DynamicAction",
                EntityId = clientId,
                MinimumPermission = EFClient.Permission.Moderator,
                Source = Name,
                ActionMeta =
                {
                    ["InteractionId"] = "command",
                    ["ShouldRefresh"] = "true"
                }
            };

            if (clientId.HasValue && _config.VpnExceptionIds.Contains(clientId.Value))
            {
                interaction.Name = loc["WEBFRONT_VPN_BUTTON_DISALLOW"];
                interaction.DisplayMeta = "ph-x-circle";
                interaction.ActionMeta["Data"] = "disallowvpn";
                interaction.ActionMeta["ActionButtonLabel"] = loc["WEBFRONT_VPN_ACTION_DISALLOW_CONFIRM"];
                interaction.ActionMeta["Name"] = loc["WEBFRONT_VPN_ACTION_DISALLOW_TITLE"];
            }
            else
            {
                interaction.Name = loc["WEBFRONT_VPN_ACTION_ALLOW"];
                interaction.DisplayMeta = "ph-check-circle";
                interaction.ActionMeta["Data"] = "whitelistvpn";
                interaction.ActionMeta["ActionButtonLabel"] = loc["WEBFRONT_VPN_ACTION_ALLOW_CONFIRM"];
                interaction.ActionMeta["Name"] = loc["WEBFRONT_VPN_ACTION_ALLOW_TITLE"];
            }

            return Task.FromResult<IInteractionData>(interaction);
        });

        // Admin nav page listing whitelisted clients, each with a disallow button.
        _interactionRegistration.RegisterInteraction(VpnAllowListKey, (clientId, game, token) =>
        {
            var loc = Utilities.CurrentLocalization.LocalizationIndex;
            var interaction = new InteractionData
            {
                Name = loc["WEBFRONT_NAV_VPN_TITLE"],
                Description = loc["WEBFRONT_NAV_VPN_DESC"],
                DisplayMeta = "ph-shield-check",
                InteractionId = VpnAllowListKey,
                MinimumPermission = EFClient.Permission.Moderator,
                InteractionType = InteractionType.TemplateContent,
                Source = Name,
                Action = async (sourceId, targetId, g, meta, ct) =>
                {
                    var clients = await GetClientsDataAsync(_config.VpnExceptionIds, ct);

                    var disallowInteraction = new Dictionary<string, string>
                    {
                        ["InteractionId"] = "command",
                        ["Data"] = "disallowvpn",
                        ["ActionButtonLabel"] = loc["WEBFRONT_VPN_ACTION_DISALLOW_CONFIRM"],
                        ["Name"] = loc["WEBFRONT_VPN_ACTION_DISALLOW_TITLE"]
                    };
                    var encodedMeta = Uri.EscapeDataString(JsonSerializer.Serialize(disallowInteraction));

                    var provider = string.IsNullOrWhiteSpace(_config.ProxyCheckApiKey) ? "xdefcon" : "proxycheck.io";
                    var asnCount = _config.BlockedAsns.Count;

                    // Rendered inside the webfront's card container; follows WebfrontCore/REDESIGN-GUIDE.md.
                    var html = $@"<div class=""flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line"">
                            <div class=""flex items-center gap-2 min-w-0"">
                                <span class=""w-8 h-8 shrink-0 rounded-lg bg-secondary/15 text-secondary flex items-center justify-center""><i class=""ph ph-shield-check text-lg""></i></span>
                                <div class=""min-w-0"">
                                    <h2 class=""text-sm font-semibold text-foreground leading-tight"">Whitelisted players</h2>
                                    <p class=""text-xs text-muted leading-tight"">These players can connect through a VPN or a blocked network without being kicked.</p>
                                </div>
                            </div>
                            <div class=""ml-auto flex items-center gap-2 text-[11px]"">
                                <span class=""inline-flex items-center gap-1 px-2 py-1 rounded-full bg-surface-alt text-subtle font-mono tabular-nums""><i class=""ph ph-users""></i>{clients.Count}</span>
                                <span class=""inline-flex items-center gap-1 px-2 py-1 rounded-full bg-surface-alt text-subtle"" title=""Lookup provider""><i class=""ph ph-globe-hemisphere-west""></i>{provider}</span>
                                <span class=""inline-flex items-center gap-1 px-2 py-1 rounded-full bg-surface-alt text-subtle font-mono tabular-nums"" title=""Blocked networks (ASNs)""><i class=""ph ph-prohibit""></i>{asnCount} ASN</span>
                            </div>
                        </div>";

                    if (clients.Count == 0)
                    {
                        html += @"<div class=""flex flex-col items-center justify-center gap-2 py-12 text-muted text-sm"">
                                <i class=""ph ph-shield-check text-3xl text-secondary""></i>
                                <span>No players are whitelisted.</span>
                                <span class=""text-xs text-muted/70"">Use the shield button on a player's profile, or <code class=""font-mono"">!whitelistvpn</code> in game.</span>
                            </div>";
                    }
                    else
                    {
                        html += @"<div class=""overflow-x-auto""><table class=""w-full text-sm"">
                            <thead><tr class=""text-[10px] font-semibold uppercase tracking-wider text-muted"">
                                <th class=""text-left px-4 py-2.5 border-b border-line"">Player</th>
                                <th class=""text-left px-4 py-2.5 border-b border-line"">Level</th>
                                <th class=""text-left px-4 py-2.5 border-b border-line whitespace-nowrap"">Last seen</th>
                                <th class=""text-left px-4 py-2.5 border-b border-line"">Client ID</th>
                                <th class=""text-right px-4 py-2.5 border-b border-line""></th>
                            </tr></thead><tbody class=""divide-y divide-line"">";

                        foreach (var client in clients.OrderByDescending(c => c.LastConnection))
                        {
                            var cleanName = System.Net.WebUtility.HtmlEncode(client.Name.StripColors());
                            var initial = cleanName.Length > 0 ? cleanName[..1].ToUpperInvariant() : "?";
                            var levelClass = GetLevelColorClass(client.Level);
                            var levelName = System.Net.WebUtility.HtmlEncode(client.Level.ToLocalizedLevelName());
                            var lastSeen = DescribeAge(client.LastConnection);
                            var lastSeenTitle = client.LastConnection.ToUniversalTime().ToString("yyyy-MM-dd HH:mm 'UTC'");

                            html += $@"<tr class=""hover:bg-surface-hover transition-colors"">
                                    <td class=""px-4 py-2.5 align-middle"">
                                        <a href=""/client/{client.ClientId}"" class=""inline-flex items-center gap-2.5 min-w-0 group"">
                                            <span class=""w-7 h-7 shrink-0 rounded-full bg-surface-alt border border-line text-[11px] font-bold text-subtle flex items-center justify-center"">{initial}</span>
                                            <span class=""font-semibold text-foreground group-hover:text-primary transition-colors truncate"">{cleanName}</span>
                                        </a>
                                    </td>
                                    <td class=""px-4 py-2.5 align-middle"">
                                        <span class=""inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border border-current bg-transparent {levelClass}"">{levelName}</span>
                                    </td>
                                    <td class=""px-4 py-2.5 align-middle text-muted whitespace-nowrap"" title=""{lastSeenTitle}"">{lastSeen}</td>
                                    <td class=""px-4 py-2.5 align-middle font-mono tabular-nums text-muted"">#{client.ClientId}</td>
                                    <td class=""px-4 py-2.5 align-middle text-right"">
                                        <button type=""button"" class=""profile-action inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-error/40 bg-surface-alt text-xs font-semibold text-error hover:bg-error/10 transition-colors""
                                                data-action=""DynamicAction"" data-action-id=""{client.ClientId}"" data-action-meta=""{encodedMeta}"">
                                            <i class=""ph ph-x-circle text-base""></i>
                                            <span>{loc["WEBFRONT_VPN_BUTTON_DISALLOW"]}</span>
                                        </button>
                                    </td>
                                </tr>";
                        }

                        html += "</tbody></table></div>";
                    }

                    return html;
                }
            };

            return Task.FromResult<IInteractionData>(interaction);
        });
    }

    private static string GetLevelColorClass(EFClient.Permission permission) => permission switch
    {
        EFClient.Permission.Console => "text-level-console",
        EFClient.Permission.Owner => "text-level-owner",
        EFClient.Permission.Creator => "text-level-owner",
        EFClient.Permission.SeniorAdmin => "text-level-senioradmin",
        EFClient.Permission.Administrator => "text-level-administrator",
        EFClient.Permission.Moderator => "text-level-moderator",
        EFClient.Permission.Trusted => "text-level-trusted",
        EFClient.Permission.Flagged => "text-level-flagged",
        EFClient.Permission.Banned => "text-red-500 font-bold",
        _ => "text-slate-400"
    };

    private static string DescribeAge(DateTime when)
    {
        var age = DateTime.UtcNow - when.ToUniversalTime();
        if (age < TimeSpan.Zero) age = TimeSpan.Zero;
        if (age.TotalMinutes < 1) return "just now";
        if (age.TotalHours < 1) return $"{(int)age.TotalMinutes} min ago";
        if (age.TotalDays < 1) return $"{(int)age.TotalHours} h ago";
        if (age.TotalDays < 30) return $"{(int)age.TotalDays} d ago";
        if (age.TotalDays < 365) return $"{(int)(age.TotalDays / 30)} mo ago";
        return $"{(int)(age.TotalDays / 365)} y ago";
    }

    private Task OnClientAuthorized(ClientStateAuthorizeEvent clientEvent, CancellationToken token)
    {
        if (clientEvent.Client.IsBot || !_config.Enabled)
        {
            return Task.CompletedTask;
        }

        return CheckForVpnAsync(clientEvent.Client, token);
    }

    private async Task CheckForVpnAsync(EFClient origin, CancellationToken token)
    {
        if (_config.VpnExceptionIds.Contains(origin.ClientId))
        {
            _logger.LogInformation("{Origin} is whitelisted, so we are not checking VPN status", origin.ToString());
            return;
        }

        if (origin.IPAddressString is null)
        {
            _logger.LogDebug("{Client} does not have an IP address yet, so we are not checking their VPN status",
                origin.ToString());
            return;
        }

        try
        {
            var result = string.IsNullOrWhiteSpace(_config.ProxyCheckApiKey)
                ? await LookupXdefconAsync(origin, token)
                : await LookupProxyCheckAsync(origin, token);

            if (result is null)
            {
                return;
            }

            var blockedAsn = !string.IsNullOrEmpty(result.Asn) && _blockedAsns.Contains(result.Asn);

            if (!result.IsProxy && !blockedAsn)
            {
                _logger.LogDebug("{Client} is not using a VPN (ASN {Asn})", origin.ToString(), result.Asn ?? "unknown");
                return;
            }

            _logger.LogInformation("{Origin} was blocked by VPN detection ({IP}, ASN {Asn}, proxy={Proxy}, rule={Rule}, blockedAsn={BlockedAsn})",
                origin.ToString(), origin.IPAddressString, result.Asn ?? "unknown", result.IsProxy, result.IsCustomRule, blockedAsn);

            string message;
            if ((blockedAsn || result.IsCustomRule) && !string.IsNullOrWhiteSpace(_config.BlockedNetworkKickMessage))
            {
                message = _config.BlockedNetworkKickMessage;
            }
            else
            {
                var loc = Utilities.CurrentLocalization.LocalizationIndex;
                var additionalInfo = string.IsNullOrEmpty(_appConfig.ContactUri)
                    ? string.Empty
                    : loc["SERVER_KICK_VPNS_NOTALLOWED_INFO"] + " " + _appConfig.ContactUri;
                message = (loc["SERVER_KICK_VPNS_NOTALLOWED"] + " " + additionalInfo).TrimEnd();
            }

            origin.Kick(message, origin.CurrentServer.AsConsoleClient());
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "There was a problem checking client IP ({IP}) for VPN", origin.IPAddressString);
        }
    }

    private sealed record LookupResult(bool IsProxy, bool IsCustomRule, string Asn);

    /// <summary>
    /// proxycheck.io v2 lookup (used when an API key is configured). Returns the proxy flag,
    /// whether the hit came from a custom rule on the proxycheck dashboard, and the ASN.
    /// </summary>
    private async Task<LookupResult> LookupProxyCheckAsync(EFClient origin, CancellationToken token)
    {
        var url = $"https://proxycheck.io/v2/{origin.IPAddressString}?vpn=1&asn=1&key={_config.ProxyCheckApiKey}&tag={origin.ClientId}";
        var body = await GetAsync(url, token);

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;

        var status = root.TryGetProperty("status", out var statusEl) ? statusEl.GetString() : null;
        if (status == "error")
        {
            var msg = root.TryGetProperty("message", out var msgEl) ? msgEl.GetString() : body;
            _logger.LogWarning("There was a problem checking client IP ({IP}) for VPN - {Message}", origin.IPAddressString, msg);
            return null;
        }

        if (!root.TryGetProperty(origin.IPAddressString, out var entry) || entry.ValueKind != JsonValueKind.Object)
        {
            _logger.LogWarning("ProxyCheck returned no result for client IP ({IP})", origin.IPAddressString);
            return null;
        }

        var isProxy = status == "ok" && entry.TryGetProperty("proxy", out var proxyEl) && proxyEl.GetString() == "yes";
        var isRule = entry.TryGetProperty("type", out var typeEl) && typeEl.GetString() == "rule";
        var asn = entry.TryGetProperty("asn", out var asnEl) ? NormalizeAsn(asnEl.GetString()) : null;

        return new LookupResult(isProxy, isRule, asn);
    }

    /// <summary>
    /// Key-less fallback lookup (api.xdefcon.com). No ASN data, so the ASN blocklist is not applied.
    /// </summary>
    private async Task<LookupResult> LookupXdefconAsync(EFClient origin, CancellationToken token)
    {
        var body = await GetAsync($"https://api.xdefcon.com/proxy/check/?ip={origin.IPAddressString}", token);

        try
        {
            using var json = JsonDocument.Parse(body);
            var root = json.RootElement;
            var isProxy = root.TryGetProperty("success", out var success) && success.ValueKind == JsonValueKind.True
                          && root.TryGetProperty("proxy", out var proxy) && proxy.ValueKind == JsonValueKind.True;
            return new LookupResult(isProxy, false, null);
        }
        catch
        {
            _logger.LogWarning("There was a problem checking client IP ({IP}) for VPN - {Message}", origin.IPAddressString, body);
            return null;
        }
    }

    private async Task<string> GetAsync(string url, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd($"IW4MAdmin-{_appConfig.Id}");
        using var response = await HttpClient.SendAsync(request, token);
        return await response.Content.ReadAsStringAsync(token);
    }

    private static string NormalizeAsn(string asn)
    {
        if (string.IsNullOrWhiteSpace(asn))
        {
            return null;
        }

        asn = asn.Trim().ToUpperInvariant();
        return asn.StartsWith("AS") ? asn : "AS" + asn;
    }

    private async Task<List<ClientWhitelistEntry>> GetClientsDataAsync(IReadOnlyCollection<int> clientIds,
        CancellationToken token)
    {
        if (clientIds.Count == 0)
        {
            return [];
        }

        var ids = clientIds.ToList();
        await using var context = _contextFactory.CreateContext(false);
        return await context.Clients
            .Where(client => ids.Contains(client.ClientId))
            .Select(client => new ClientWhitelistEntry(client.ClientId, client.CurrentAlias.Name, client.Level,
                client.LastConnection))
            .ToListAsync(token);
    }

    public void Dispose()
    {
        IManagementEventSubscriptions.ClientStateAuthorized -= OnClientAuthorized;
        _interactionRegistration.UnregisterInteraction(VpnWhitelistKey);
        _interactionRegistration.UnregisterInteraction(VpnAllowListKey);
        _logger.LogInformation("{Name} unloaded", Name);
    }

    private sealed record ClientWhitelistEntry(int ClientId, string Name, EFClient.Permission Level, DateTime LastConnection);
}

/// <summary>
/// Whitelists a player's client id from VPN detection.
/// Usage: !whitelistvpn &lt;player&gt;
/// </summary>
public class WhitelistVpnCommand : Command
{
    private readonly VpnDetectionConfiguration _config;
    private readonly IConfigurationHandlerV2<VpnDetectionConfiguration> _configHandler;

    public WhitelistVpnCommand(CommandConfiguration config, ITranslationLookup translationLookup,
        VpnDetectionConfiguration scriptConfig, IConfigurationHandlerV2<VpnDetectionConfiguration> configHandler)
        : base(config, translationLookup)
    {
        Name = "whitelistvpn";
        Description = "whitelists a player's client id from VPN detection";
        Alias = "wv";
        Permission = EFClient.Permission.SeniorAdmin;
        RequiresTarget = true;
        Arguments =
        [
            new CommandArgument { Name = "player", Required = true }
        ];
        _config = scriptConfig;
        _configHandler = configHandler;
    }

    public override async Task ExecuteAsync(GameEvent gameEvent)
    {
        var targetId = gameEvent.Target.ClientId;
        if (!_config.VpnExceptionIds.Contains(targetId))
        {
            _config.VpnExceptionIds.Add(targetId);
            await _configHandler.Set(_config);
        }

        gameEvent.Origin.Tell($"Successfully whitelisted {gameEvent.Target.Name}");
    }
}

/// <summary>
/// Disallows a player from connecting with a VPN (removes them from the whitelist).
/// Usage: !disallowvpn &lt;player&gt;
/// </summary>
public class DisallowVpnCommand : Command
{
    private readonly VpnDetectionConfiguration _config;
    private readonly IConfigurationHandlerV2<VpnDetectionConfiguration> _configHandler;

    public DisallowVpnCommand(CommandConfiguration config, ITranslationLookup translationLookup,
        VpnDetectionConfiguration scriptConfig, IConfigurationHandlerV2<VpnDetectionConfiguration> configHandler)
        : base(config, translationLookup)
    {
        Name = "disallowvpn";
        Description = "disallows a player from connecting with a VPN";
        Alias = "dv";
        Permission = EFClient.Permission.SeniorAdmin;
        RequiresTarget = true;
        Arguments =
        [
            new CommandArgument { Name = "player", Required = true }
        ];
        _config = scriptConfig;
        _configHandler = configHandler;
    }

    public override async Task ExecuteAsync(GameEvent gameEvent)
    {
        var targetId = gameEvent.Target.ClientId;
        if (_config.VpnExceptionIds.RemoveAll(id => id == targetId) > 0)
        {
            await _configHandler.Set(_config);
        }

        gameEvent.Origin.Tell($"Successfully disallowed {gameEvent.Target.Name} from connecting with VPN");
    }
}

/// <summary>
/// Configuration for the VPN Detection plugin.
/// </summary>
public class VpnDetectionConfiguration
{
    /// <summary>
    /// Indicates whether VPN checking is enabled.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Client ids that are exempt from VPN detection.
    /// </summary>
    public List<int> VpnExceptionIds { get; set; } = new();

    /// <summary>
    /// proxycheck.io API key. When set, lookups use proxycheck.io (with ASN data) instead of the
    /// key-less xdefcon fallback.
    /// </summary>
    public string ProxyCheckApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Autonomous system numbers ("AS12345") that are always blocked, e.g. datacenter / hosting
    /// providers. Only applied when proxycheck.io is in use, because the fallback has no ASN data.
    /// </summary>
    public List<string> BlockedAsns { get; set; } = new();

    /// <summary>
    /// Kick message used when a client is blocked by the ASN list or a proxycheck custom rule.
    /// Leave empty to use the standard VPN kick message.
    /// </summary>
    public string BlockedNetworkKickMessage { get; set; } = string.Empty;
}
