# MCP Client Configuration Examples

This document provides configuration examples for connecting various AI assistants to your FoundryVTT MCP Server.

Every example assumes the settings are in the shared configuration file, written by `node dist/index.js init` (see the README's [Quick Start](../README.md#-quick-start)). A client entry then holds only the command: every MCP client on the machine reads the same file.

## Claude Desktop

**Settings** → **Developer** → **Edit Config** opens the file. Add the entry inside `"mcpServers"`, next to any entries already there, then quit Claude desktop completely and start it again.

### Location
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Configuration

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "node",
      "args": ["/path/to/foundryvtt-mcp/dist/index.js"]
    }
  }
}
```

On Windows, write the path with forward slashes (`C:/Users/you/foundryvtt-mcp/dist/index.js`) or doubled backslashes; `init` prints the entry with the right path.

> The server connects to FoundryVTT over **Socket.IO** with a world user
> account (Assistant GM). The companion module **FoundryVTT MCP Bridge** adds
> the canvas, dice, compendium and upload tools. Setting `FOUNDRY_API_KEY`
> additionally enables the optional, read-only REST diagnostics tools.

### Alternative: an `env` block (not recommended)

Settings can also be given in the entry itself:

```json
{
  "mcpServers": {
    "foundryvtt": {
      "command": "node",
      "args": ["/path/to/foundryvtt-mcp/dist/index.js"],
      "env": {
        "FOUNDRY_URL": "http://localhost:30000",
        "FOUNDRY_USERNAME": "mcp-api",
        "FOUNDRY_PASSWORD": "your_password"
      }
    }
  }
}
```

They win over the file for this client only, but one shared process serves every client with one configuration: a client whose `env` block disagrees with it is told, in its first tool result, which of its settings are ignored. Keep the settings in the file.

## Claude Code

```bash
claude mcp add foundryvtt --scope user -- node "/path/to/foundryvtt-mcp/dist/index.js"
```

`--scope user` registers it for all your projects; `--scope local` for the current project only, on this machine. `claude mcp list` shows the entry.

## Custom MCP Client (Node.js)

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['./dist/index.js'],
  cwd: '/path/to/foundryvtt-mcp'
});

const client = new Client({
  name: "foundry-client",
  version: "1.0.0"
}, {
  capabilities: {}
});

await client.connect(transport);

// Example: Roll dice
const rollResult = await client.request({
  method: "tools/call",
  params: {
    name: "roll_dice",
    arguments: {
      formula: "1d20+5",
      reason: "Initiative roll"
    }
  }
});

console.log(rollResult);

// Example: Search for actors
const actorSearch = await client.request({
  method: "tools/call",
  params: {
    name: "search_actors",
    arguments: {
      query: "goblin",
      limit: 5
    }
  }
});

console.log(actorSearch);

// Example: Access resources
const worldActors = await client.request({
  method: "resources/read",
  params: {
    uri: "foundry://world/actors"
  }
});

console.log(worldActors);
```

## Custom MCP Client (Python)

```python
import asyncio
import json
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    server_params = StdioServerParameters(
        command="node",
        args=["./dist/index.js"],
        cwd="/path/to/foundryvtt-mcp"
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            # Initialize the client
            await session.initialize()

            # Roll dice
            roll_result = await session.call_tool(
                "roll_dice",
                arguments={"formula": "2d6+3", "reason": "Damage roll"}
            )
            print("Roll result:", roll_result)

            # Generate NPC
            npc_result = await session.call_tool(
                "generate_npc",
                arguments={"race": "elf", "role": "merchant", "level": 5}
            )
            print("Generated NPC:", npc_result)

            # Read world data
            world_data = await session.read_resource("foundry://world/info")
            print("World info:", world_data)

if __name__ == "__main__":
    asyncio.run(main())
```

## Settings Reference

The configuration file (`%LOCALAPPDATA%\foundryvtt-mcp\config.env` on Windows, `~/.config/foundryvtt-mcp/config.env` on macOS and Linux) takes one `KEY='value'` per line:

```env
# Required — Socket.IO connection (the primary transport)
FOUNDRY_URL='http://localhost:30000'
FOUNDRY_USERNAME='mcp-api'
FOUNDRY_PASSWORD='your password'

# The companion module bridge (init always writes it)
FOUNDRY_MODULE_BRIDGE_ENABLED='true'

# Optional — enables game-state mutations (write tools). Default: false.
FOUNDRY_WRITE_ENABLED='true'

# Optional — the read-only REST API diagnostics tools, alongside Socket.IO.
# FOUNDRY_API_KEY='your_api_key_here'

# Optional
# LOG_LEVEL='debug'
# FOUNDRY_TIMEOUT='15000'
```

The full list is in the README, [Environment Variables](../README.md#environment-variables).

## Testing Your Configuration

1. **Test the MCP server standalone**:
   ```bash
   cd /path/to/foundryvtt-mcp
   node dist/index.js init --check
   ```

2. **Test the MCP client connection**: ask the assistant for the connector's health status (`get_health_status`).

3. **Inspect the shared process**:
   ```bash
   node dist/index.js status
   ```
   For more detail, set `LOG_LEVEL='debug'` in the configuration file, run `node dist/index.js stop`, and read `daemon.log` (its path is in `status`).

## Example Prompts for AI Assistants

Once connected, try these prompts with your AI assistant:

### Basic Commands
- "Roll 1d20+5 for an attack roll"
- "Search for goblin actors in the current world"
- "What's the current scene information?"
- "Generate a random human merchant NPC"

### Advanced Queries
- "Create appropriate loot for a level 8 party after defeating a young dragon"
- "Generate a random forest encounter for a 4th level party"
- "Look up the grappling rules"
- "Suggest tactics for fighting undead creatures"

### Data Access
- "Show me all actors in the world"
- "What spells are available in the compendium?"
- "List the current game settings"
- "Get detailed information about the current scene"

## Troubleshooting

### Common Issues

1. **"Server not found" or connection errors**
   - Check the path to `dist/index.js` is correct
   - Ensure the server was built: `npm run build`
   - Verify FoundryVTT is running

2. **"Tool not available" errors**
   - Check if FoundryVTT is accessible
   - Run `node dist/index.js status`: it shows where each setting comes from
   - Try `node dist/index.js init --check` to diagnose

3. **"Empty results" or limited functionality**
   - Ensure a **world is loaded** in FoundryVTT (the server needs an active world, not the setup screen)
   - Verify the user account has sufficient permissions (Assistant GM or higher)
   - The optional REST API module / `FOUNDRY_API_KEY` adds diagnostics tools, but is not required for core data access

4. **Permission or authentication errors**
   - Check FoundryVTT user permissions
   - Verify the API key is valid (only when `FOUNDRY_API_KEY` is set)
   - Ensure FoundryVTT allows external connections

### Getting Debug Information

Add `LOG_LEVEL='debug'` to the configuration file, then run `node dist/index.js stop`: the shared process started by the next call logs in detail to `daemon.log`. See [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

## Performance Tips

1. **Reads are served from memory**: the world is loaded once and kept current by FoundryVTT's own updates
2. **Limit search results**: Use the `limit` parameter to avoid large data transfers
3. **Batch operations**: Group related requests when possible
4. **Monitor logs**: Watch for performance warnings in debug mode

## Security Considerations

1. **API Keys**: Never commit API keys to version control
2. **Network Access**: Run on internal networks when possible
3. **User Permissions**: Limit FoundryVTT user permissions to necessary functions
4. **Monitoring**: Monitor logs for unusual activity

---

For more detailed setup instructions, see the main [SETUP_GUIDE.md](../SETUP_GUIDE.md).
