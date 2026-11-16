# Kuinta tools Event Master (kteventmaster)

Bitfocus Companion module for Barco Event Master and Encore 3 (E2 / S3-4K / EX / Encore 3), JSON-RPC on port 9999.

This module is a **programming aid**. It is **essential to test it thoroughly before using it in a show.** Check every button and workflow on your own unit and firmware first.
See `companion/HELP.md` for the actions, presets and the ShuttlePRO workflow.

> Not affiliated with or endorsed by Barco. Barco, Event Master and Encore are trademarks of Barco NV.
> Released under the MIT license (see `LICENSE`, `THIRD_PARTY_NOTICES.md`), provided as is, without warranty.

## Install
Companion > Modules > **Import module package** > `kteventmaster-<ver>.tgz`, then Connections > Add > "Event Master" (manufacturer Kuinta tools).
Developer mode also works: put this folder inside the Developer Modules Path and run `npm install` in it.

## Build the .tgz
`./build-module.sh VENDOR_DIR` (Go 1.24+, same vendor checkouts as the ShowTimer module, see `tools/bundle/main.go`).
`npm run package` / `companion-module-build` produced a package without the code for this project, do not use it.

## Test without hardware
`node mock-server.js` is a fake Event Master. `tools/test/host.cjs` is a mock Companion host (real nodejs-ipc protocol):
`WRITE_FORMAT=any node tools/test/host.cjs dist/pkg mock-server.js 19911` (also run with `array` / `object`).
