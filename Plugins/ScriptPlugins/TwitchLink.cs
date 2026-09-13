#:package RaidMax.IW4MAdmin.SharedLibraryCore@2026.1.6.1

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SharedLibraryCore;
using SharedLibraryCore.Commands;
using SharedLibraryCore.Configuration;
using SharedLibraryCore.Database.Models;
using SharedLibraryCore.Events.Management;
using SharedLibraryCore.Interfaces;
using SharedLibraryCore.Interfaces.Events;

/// <summary>
/// Twitch Link - lets players attach their Twitch channel to their profile with !twitch, and shows
/// when they are live.
///
/// The channel name is stored as persistent meta ("TwitchUsername") and copied onto the live client
/// when they join, so the webfront can show a Twitch icon next to their name on server cards,
/// scoreboards and their profile without any extra database work per refresh.
///
/// When Twitch API credentials are configured (Configuration/TwitchLinkSettings.json) the plugin polls
/// the Helix streams endpoint for every linked player who is currently in game and flags them as live
/// ("TwitchLive" on the client, mirrored to persistent meta so the profile page can show it too).
/// </summary>
public class TwitchLinkPlugin : IPluginV2
{
    public const string MetaKey = "TwitchUsername";
    public const string LiveKey = "TwitchLive";
    public const string TitleKey = "TwitchStreamTitle";

    public static void RegisterDependencies(IServiceCollection serviceCollection)
    {
        serviceCollection.AddConfiguration<TwitchLinkConfig>("TwitchLinkSettings", new TwitchLinkConfig());
    }

    public string Name => "Twitch Link";
    public string Author => "CUKServers";
    public string Version => "1.1";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    private readonly ILogger<TwitchLinkPlugin> _logger;
    private readonly IMetaServiceV2 _metaService;
    private readonly IManager _manager;
    private readonly TwitchLinkConfig _config;
    private readonly CancellationTokenSource _cts = new();

    private string _accessToken;
    private DateTime _accessTokenExpiresUtc = DateTime.MinValue;

    public TwitchLinkPlugin(ILogger<TwitchLinkPlugin> logger, IMetaServiceV2 metaService, IManager manager,
        TwitchLinkConfig config)
    {
        _logger = logger;
        _metaService = metaService;
        _manager = manager;
        _config = config;

        IManagementEventSubscriptions.ClientStateAuthorized += OnClientAuthorized;
        IManagementEventSubscriptions.ClientStateDisposed += OnClientDisposed;
        IManagementEventSubscriptions.Unload += OnUnload;

        var liveEnabled = _config.Enabled && !string.IsNullOrWhiteSpace(_config.ClientId) &&
                          !string.IsNullOrWhiteSpace(_config.ClientSecret);
        if (liveEnabled)
        {
            _ = Task.Run(() => PollLoopAsync(_cts.Token));
        }

        _logger.LogInformation("TwitchLink {Version} loaded. Live status polling={Live}", Version, liveEnabled ? "on" : "off (no credentials)");
    }

    #region Events

    private async Task OnClientAuthorized(ClientStateAuthorizeEvent authorizeEvent, CancellationToken token)
    {
        try
        {
            var client = authorizeEvent.Client;
            if (client is null || client.ClientId <= 0)
            {
                return;
            }

            var meta = await _metaService.GetPersistentMeta(MetaKey, client.ClientId, token);
            if (!string.IsNullOrWhiteSpace(meta?.Value))
            {
                client.SetAdditionalProperty(MetaKey, meta.Value);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "TwitchLink: could not load the Twitch channel for client {ClientId}", authorizeEvent.Client?.ClientId);
        }
    }

    private async Task OnClientDisposed(ClientStateDisposeEvent disposeEvent, CancellationToken token)
    {
        try
        {
            var client = disposeEvent.Client;
            if (client is null || client.ClientId <= 0)
            {
                return;
            }

            // Live status is only tracked while they are in game; clear it on the way out.
            if (client.GetAdditionalProperty<bool?>(LiveKey) == true)
            {
                await _metaService.RemovePersistentMeta(LiveKey, client.ClientId, token);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "TwitchLink: could not clear live status for client {ClientId}", disposeEvent.Client?.ClientId);
        }
    }

    private Task OnUnload(IManager manager, CancellationToken token)
    {
        IManagementEventSubscriptions.ClientStateAuthorized -= OnClientAuthorized;
        IManagementEventSubscriptions.ClientStateDisposed -= OnClientDisposed;
        IManagementEventSubscriptions.Unload -= OnUnload;
        _cts.Cancel();
        _logger.LogInformation("TwitchLink unloaded");
        return Task.CompletedTask;
    }

    #endregion

    #region Live status polling

    private async Task PollLoopAsync(CancellationToken token)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(30, _config.PollSeconds)));
            while (await timer.WaitForNextTickAsync(token))
            {
                try
                {
                    await RefreshLiveStatusAsync(token);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "TwitchLink: live status refresh failed");
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task RefreshLiveStatusAsync(CancellationToken token)
    {
        var linked = _manager.GetActiveClients()
            .Select(client => new { client, channel = client.GetAdditionalProperty<string>(MetaKey)?.ToLowerInvariant() })
            .Where(entry => !string.IsNullOrWhiteSpace(entry.channel))
            .ToList();

        if (linked.Count == 0)
        {
            return;
        }

        var channels = linked.Select(entry => entry.channel).Distinct().ToList();
        var live = await GetLiveStreamsAsync(channels, token);

        foreach (var entry in linked)
        {
            var wasLive = entry.client.GetAdditionalProperty<bool?>(LiveKey) == true;
            var isLive = live.TryGetValue(entry.channel, out var title);

            if (wasLive == isLive)
            {
                continue;
            }

            entry.client.SetAdditionalProperty(LiveKey, isLive);
            entry.client.SetAdditionalProperty(TitleKey, isLive ? title : null);

            if (isLive)
            {
                await _metaService.SetPersistentMeta(LiveKey, "1", entry.client.ClientId, token);
                _logger.LogInformation("TwitchLink: {Client} is now live on twitch.tv/{Channel}", entry.client.CleanedName, entry.channel);
            }
            else
            {
                await _metaService.RemovePersistentMeta(LiveKey, entry.client.ClientId, token);
                _logger.LogInformation("TwitchLink: {Client} stopped streaming", entry.client.CleanedName);
            }
        }
    }

    /// <summary>
    /// Returns the channels (lower-case login) that are currently live, with their stream title.
    /// </summary>
    private async Task<Dictionary<string, string>> GetLiveStreamsAsync(List<string> channels, CancellationToken token)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // Helix accepts up to 100 user_login values per request.
        foreach (var batch in channels.Chunk(100))
        {
            var query = string.Join("&", batch.Select(channel => "user_login=" + Uri.EscapeDataString(channel)));
            var json = await CallHelixAsync("https://api.twitch.tv/helix/streams?first=100&" + query, token);
            if (json is null)
            {
                continue;
            }

            using var document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("data", out var data))
            {
                continue;
            }

            foreach (var stream in data.EnumerateArray())
            {
                var login = stream.TryGetProperty("user_login", out var loginElement) ? loginElement.GetString() : null;
                if (string.IsNullOrEmpty(login))
                {
                    continue;
                }

                var title = stream.TryGetProperty("title", out var titleElement) ? titleElement.GetString() : null;
                result[login.ToLowerInvariant()] = title ?? string.Empty;
            }
        }

        return result;
    }

    private async Task<string> CallHelixAsync(string url, CancellationToken token)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var accessToken = await GetAccessTokenAsync(token);
            if (accessToken is null)
            {
                return null;
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("Client-Id", _config.ClientId);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

            using var response = await Http.SendAsync(request, token);
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            {
                _accessToken = null; // token revoked or expired early, fetch a fresh one and retry once
                continue;
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("TwitchLink: Helix returned {Status} for {Url}", (int)response.StatusCode, url.Split('?')[0]);
                return null;
            }

            return await response.Content.ReadAsStringAsync(token);
        }

        return null;
    }

    private async Task<string> GetAccessTokenAsync(CancellationToken token)
    {
        if (_accessToken is not null && DateTime.UtcNow < _accessTokenExpiresUtc)
        {
            return _accessToken;
        }

        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = _config.ClientId,
            ["client_secret"] = _config.ClientSecret,
            ["grant_type"] = "client_credentials"
        });

        using var response = await Http.PostAsync("https://id.twitch.tv/oauth2/token", content, token);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("TwitchLink: could not get a Twitch access token ({Status}); check ClientId/ClientSecret", (int)response.StatusCode);
            return null;
        }

        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
        _accessToken = document.RootElement.GetProperty("access_token").GetString();
        var expiresIn = document.RootElement.TryGetProperty("expires_in", out var expiresElement) ? expiresElement.GetInt32() : 3600;
        _accessTokenExpiresUtc = DateTime.UtcNow.AddSeconds(Math.Max(60, expiresIn - 300));
        return _accessToken;
    }

    #endregion
}

/// <summary>
/// !twitch &lt;channel | clear&gt; - link (or unlink) your Twitch channel. Accepts a bare channel name
/// or a pasted twitch.tv URL.
/// </summary>
public class TwitchCommand : Command
{
    private static readonly Regex ChannelPattern = new("^[A-Za-z0-9_]{3,25}$", RegexOptions.Compiled);
    private readonly IMetaServiceV2 _metaService;

    public TwitchCommand(CommandConfiguration config, ITranslationLookup translationLookup, IMetaServiceV2 metaService)
        : base(config, translationLookup)
    {
        Name = "twitch";
        Description = "link your Twitch channel to your profile (use \"clear\" to remove it)";
        Alias = "ttv"; // "tw" is already taken by a GameInterface command
        Permission = EFClient.Permission.User;
        RequiresTarget = false;
        Arguments =
        [
            new CommandArgument { Name = "channel", Required = true }
        ];
        _metaService = metaService;
    }

    public override async Task ExecuteAsync(GameEvent gameEvent)
    {
        var input = (gameEvent.Data ?? string.Empty).Trim();
        var token = gameEvent.Owner.Manager.CancellationToken;

        if (input.Equals("clear", StringComparison.OrdinalIgnoreCase) ||
            input.Equals("remove", StringComparison.OrdinalIgnoreCase) ||
            input.Equals("off", StringComparison.OrdinalIgnoreCase))
        {
            await _metaService.RemovePersistentMeta(TwitchLinkPlugin.MetaKey, gameEvent.Origin.ClientId, token);
            await _metaService.RemovePersistentMeta(TwitchLinkPlugin.LiveKey, gameEvent.Origin.ClientId, token);
            gameEvent.Origin.SetAdditionalProperty(TwitchLinkPlugin.MetaKey, null);
            gameEvent.Origin.SetAdditionalProperty(TwitchLinkPlugin.LiveKey, false);
            gameEvent.Origin.Tell("^5Twitch ^7link removed from your profile.");
            return;
        }

        var channel = NormaliseChannel(input);
        if (channel is null)
        {
            gameEvent.Origin.Tell("^1Invalid Twitch channel. ^7Use ^5!twitch yourname ^7or paste your twitch.tv link.");
            return;
        }

        await _metaService.SetPersistentMeta(TwitchLinkPlugin.MetaKey, channel, gameEvent.Origin.ClientId, token);
        gameEvent.Origin.SetAdditionalProperty(TwitchLinkPlugin.MetaKey, channel);
        gameEvent.Origin.Tell($"^5Twitch ^7linked: ^5twitch.tv/{channel} ^7(use ^5!twitch clear ^7to remove)");
    }

    private static string NormaliseChannel(string input)
    {
        var value = input.Trim().TrimEnd('/');

        // Accept https://twitch.tv/name, twitch.tv/name, www.twitch.tv/name, @name
        var slash = value.LastIndexOf('/');
        if (slash >= 0)
        {
            value = value[(slash + 1)..];
        }

        value = value.TrimStart('@');
        var query = value.IndexOf('?');
        if (query >= 0)
        {
            value = value[..query];
        }

        return ChannelPattern.IsMatch(value) ? value.ToLowerInvariant() : null;
    }
}

/// <summary>
/// Configuration for the Twitch Link plugin (Configuration/TwitchLinkSettings.json).
/// </summary>
public class TwitchLinkConfig
{
    /// <summary>Enables live-status polling (linking with !twitch always works).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Twitch application client id (dev.twitch.tv).</summary>
    public string ClientId { get; set; } = "";

    /// <summary>Twitch application client secret.</summary>
    public string ClientSecret { get; set; } = "";

    /// <summary>How often to check which linked in-game players are streaming (minimum 30).</summary>
    public int PollSeconds { get; set; } = 60;
}
