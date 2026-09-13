#:package RaidMax.IW4MAdmin.SharedLibraryCore@2026.1.6.1

using System;
using System.Linq;
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
/// Twitch Link - lets players attach their Twitch channel to their profile with !twitch.
///
/// The channel name is stored as persistent meta ("TwitchUsername") and copied onto the live client
/// when they join, so the webfront can show a Twitch icon next to their name on server cards,
/// scoreboards and their profile without any extra database work per refresh.
/// </summary>
public class TwitchLinkPlugin : IPluginV2
{
    public const string MetaKey = "TwitchUsername";

    public static void RegisterDependencies(IServiceCollection serviceCollection)
    {
    }

    public string Name => "Twitch Link";
    public string Author => "CUKServers";
    public string Version => "1.0";

    private readonly ILogger<TwitchLinkPlugin> _logger;
    private readonly IMetaServiceV2 _metaService;

    public TwitchLinkPlugin(ILogger<TwitchLinkPlugin> logger, IMetaServiceV2 metaService)
    {
        _logger = logger;
        _metaService = metaService;

        IManagementEventSubscriptions.ClientStateAuthorized += OnClientAuthorized;
        IManagementEventSubscriptions.Unload += OnUnload;

        _logger.LogInformation("TwitchLink {Version} loaded", Version);
    }

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

    private Task OnUnload(IManager manager, CancellationToken token)
    {
        IManagementEventSubscriptions.ClientStateAuthorized -= OnClientAuthorized;
        IManagementEventSubscriptions.Unload -= OnUnload;
        _logger.LogInformation("TwitchLink unloaded");
        return Task.CompletedTask;
    }
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
            gameEvent.Origin.SetAdditionalProperty(TwitchLinkPlugin.MetaKey, null);
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
