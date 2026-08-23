namespace Integrations.SevenDaysToDie;

public sealed record SevenDaysToDiePlayer(
    int Slot,
    int EntityId,
    long NetworkId,
    string Name,
    string Address,
    int Ping,
    int Level);
