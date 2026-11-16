#!/usr/bin/env bash
# Packages the Companion module as dist/kteventmaster-<ver>.tgz (Companion > Modules > Import module package).
# One CommonJS main.js with @companion-module/base 1.11.3 bundled in, same layout as the ShowTimer module.
# Needs Go 1.24+ and the vendor checkouts listed in tools/bundle/main.go (same VENDOR_DIR as the ShowTimer build).
#   ./build-module.sh [VENDOR_DIR]
set -euo pipefail
cd "$(dirname "$0")"
VENDOR="${1:-../../vendor}"
VER=$(node -p "require('./companion/manifest.json').version")
rm -rf dist && mkdir -p dist/pkg/companion
(cd tools/bundle && GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off go build -o ../../dist/.bundle .)
./dist/.bundle "$VENDOR" main.js && rm dist/.bundle
cp companion/HELP.md dist/pkg/companion/
node -e "
const fs=require('fs');
const m=JSON.parse(fs.readFileSync('companion/manifest.json','utf8'));
m.runtime.apiVersion='1.11.3';
fs.writeFileSync('dist/pkg/companion/manifest.json',JSON.stringify(m,null,'\t')+'\n');
const p=require('./package.json');
fs.writeFileSync('dist/pkg/package.json',JSON.stringify({name:p.name,version:p.version,license:p.license,type:'commonjs',dependencies:{}},null,2));
"
(cd dist && tar -czf "kteventmaster-$VER.tgz" pkg)
ls -la dist
