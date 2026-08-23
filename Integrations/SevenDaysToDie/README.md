# 7 Days to Die integration

IW4MAdmin communicates with each 7 Days to Die server directly through its Telnet console. The native
`server-output.log` supplies chat events; no protocol-translating bridge or generated game log is required.

For a server on the same host, set `ManualLogPath` to the absolute path of `server-output.log` as seen by
IW4MAdmin. When IW4MAdmin runs in a container, mount that file or its containing directory read-only.

For a remote server, run [IW4MAdmin-GameLogServer](https://github.com/RaidMax/IW4MAdmin-GameLogServer) on
the game host. Set `GameLogServerUrl` to its HTTP endpoint and set `ManualLogPath` to the absolute
`server-output.log` path on that remote host.

Each entry in `IW4MAdminSettings.json` represents one game server and has its own `IPAddress`, Telnet
`Port`, `Password`, `ManualLogPath`, and optional `GameLogServerUrl`. This supports any mix of local and
remote 7 Days to Die servers.

Example server entry:

```json
{
  "IPAddress": "203.0.113.10",
  "Port": 8081,
  "Password": "your-telnet-password",
  "RConParserVersion": "7 Days to Die Parser",
  "EventParserVersion": "7 Days to Die Parser",
  "ManualLogPath": "/absolute/path/to/server-output.log",
  "GameLogServerUrl": "http://203.0.113.10:1625"
}
```

Omit `GameLogServerUrl` when IW4MAdmin can read `ManualLogPath` directly.
