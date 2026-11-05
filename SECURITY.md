# Security Policy

## Supported versions

Security fixes go to `main` and to the next release. Only the latest release and `main` are supported; please check a problem against one of them before reporting it.

## Reporting a vulnerability

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/G33ks/foundryvtt-mcp/security/advisories/new)).

**Never open a public issue, discussion or pull request for a vulnerability.** If you are unsure whether something is a security problem, report it privately anyway.

A useful report says what an attacker can do, under which conditions (local process, web page in a local browser, Foundry player, network position), and how to reproduce it. Leave out real passwords, Foundry addresses and world data.

## Scope

In scope:

- **The connector**: the relay, the shared process, its pipe or socket and access token, its configuration file and logs.
- **The module bridge** between the shared process and the companion module, and the invisible GM browser session that hosts the module.
- **The companion module** in `foundry-module/`.

What the connector can do in a world matters here. It logs in with the account you give it, ideally an Assistant GM, and with `FOUNDRY_WRITE_ENABLED=true` it can create, change and delete what that account can. A way for anyone other than that user's AI client to make it act — another local process, a web page, a Foundry player — is a vulnerability.

Protections in place, which a report may show to be insufficient:

- the bridge listens on loopback only (`127.0.0.1` and `::1`);
- the WebSocket upgrade is refused unless its `Origin` is the Foundry URL;
- the server and the module authenticate each other with an HMAC-SHA256 challenge and response, keyed by a random secret that never leaves the shared process; until then a connection receives no command;
- relays must present a per-user token to reach the shared process.

Out of scope, to be reported to their own maintainers:

- FoundryVTT itself, game systems and other modules;
- MCP clients (Claude Desktop, Claude Code and others) and what an AI model decides to do with the tools it is given;
- the browser the invisible GM session runs.

## Response

This project has one maintainer and answers on a best-effort basis: there is no guaranteed response time. Reports are acknowledged as soon as possible, and fixes are published with a GitHub security advisory crediting the reporter, unless they prefer otherwise.
