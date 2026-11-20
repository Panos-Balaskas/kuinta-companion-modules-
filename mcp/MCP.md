# Kuinta tools Event Master - MCP server (voice / chat programming aid)

An MCP server that lets Claude (Claude Desktop, or any MCP client) program a Barco Event Master / Encore 3 for you:
"layer 1, input ppt1, destination 1, window 50% centre". **It is a programming aid. Test it thoroughly, away from a show.**

Everything is written to **preview** only. There is no cut / take / activate preset / delete tool on purpose.

## Tools
| Tool | What it does |
|---|---|
| `list_destinations`, `list_sources`, `list_presets`, `get_layers` | read only |
| `save_preset` | saves a preset from the preview (or program) of the named destinations |
| `rename_preset` | renames a preset |
| `assign_input` | puts an input on a layer (A/B: the one that is not on program, unless A or B is said) |
| `set_window` | size in percent of the destination + position (center, left, right, top, bottom, corners) |

Each write is verified by reading the processor back and the answer says what the unit really did.

**Not possible:** renaming inputs or destinations. The Barco JSON-RPC document has no method for it (only presets can be renamed), so it has to be done in Toolset.

## Install (Claude Desktop)
Needs Node.js 18 or newer on the computer that is on the same network as the processor.

1. Download / clone this repository.
2. Open the Claude Desktop config file and add the server (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kuinta-eventmaster": {
      "command": "node",
      "args": ["/full/path/to/kuinta-companion-modules-/mcp/server.js"],
      "env": { "EM_HOST": "192.168.0.100" }
    }
  }
}
```

3. Restart Claude Desktop. The tools appear in the chat; then say or type what you want.

| Variable | Meaning |
|---|---|
| `EM_HOST` | IP of the Event Master (required) |
| `EM_PORT` | JSON-RPC port, default 9999 |
| `EM_AUTH_MODE` | `none` (default), `operator` or `super_user` (multi-operator mode) |
| `EM_AUTH_VALUE` | operator index (0..2) or the super operator password |
| `EM_READONLY` | `1` = only the read tools are offered |

## Notes
* `set_window`: `size_percent` is the width of the window as a percent of the destination; the window keeps its aspect ratio (a 16:9 window stays 16:9). With `keep_aspect: false` the percent applies to width and height.
* Names are matched loosely ("ppt 1", "PPT1" and "ppt1" are the same). If a name is ambiguous the tool answers with the candidates instead of guessing.
* If the layer has a crop (mask) the answer says so.
* Test without hardware: `node tools/test/mcp.mjs`
