# Development

## Build the .tgz
`./build-module.sh VENDOR_DIR` (Go 1.24+, same vendor checkouts as the ShowTimer module, see `tools/bundle/main.go`).
`npm run package` / `companion-module-build` produced a package without the code for this project, do not use it.

## Test without hardware
`node mock-server.js` is a fake Event Master. `tools/test/host.cjs` is a mock Companion host (real nodejs-ipc protocol):
`WRITE_FORMAT=any node tools/test/host.cjs dist/pkg mock-server.js 19911` (also run with `array` / `object`).

## MCP server tests


```bash
node tools/test/mcp.mjs
```

Runs `mcp/server.js` over stdio against `mock-server.js`. See [mcp/MCP.md](mcp/MCP.md).
