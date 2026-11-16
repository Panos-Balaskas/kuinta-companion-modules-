// bundle builds dist/pkg/main.js: the module plus @companion-module/base and its
// runtime dependencies in one CommonJS file, like `companion-module-build` does.
// It works offline from source checkouts, so no npm registry is needed.
//
// Usage: go run ./tools/bundle VENDOR_DIR [ENTRY.js]   (ENTRY defaults to src/main.js; this module uses main.js)
//   VENDOR_DIR/base               bitfocus/companion-module-base @ v1.11.3
//   VENDOR_DIR/src/colord         omgovich/colord 2.x
//   VENDOR_DIR/src/ejson          primus/ejson 2.2.3
//   VENDOR_DIR/src/eventemitter3  primus/eventemitter3 5.0.1
//   VENDOR_DIR/src/ee4/eventemitter3  primus/eventemitter3 4.0.7 (for p-queue)
//   VENDOR_DIR/src/p-queue        sindresorhus/p-queue v6.6.2
//   VENDOR_DIR/src/p-timeout      sindresorhus/p-timeout v3.2.0
//   VENDOR_DIR/src/p-finally      sindresorhus/p-finally v1.0.0
//   VENDOR_DIR/src/mimic-fn       sindresorhus/mimic-fn v3.1.0
//   VENDOR_DIR/tsconfig.bundle.json   compiler options for the TypeScript sources
//   VENDOR_DIR/base/generated/validate_manifest.js   stub (tooling only, unused at runtime)
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: bundle VENDOR_DIR")
		os.Exit(2)
	}
	v, _ := filepath.Abs(os.Args[1])
	entry := "src/main.js"
	if len(os.Args) > 2 {
		entry = os.Args[2]
	}
	src := filepath.Join(v, "src")
	pkgs := map[string]string{
		"@companion-module/base": filepath.Join(v, "base/src/index.ts"),
		"colord":                 filepath.Join(src, "colord/src/index.ts"),
		"ejson":                  filepath.Join(src, "ejson/index.js"),
		"eventemitter3":          filepath.Join(src, "eventemitter3/index.js"),
		"p-queue":                filepath.Join(src, "p-queue/source/index.ts"),
		"p-timeout":              filepath.Join(src, "p-timeout/index.js"),
		"p-finally":              filepath.Join(src, "p-finally/index.js"),
		"mimic-fn":               filepath.Join(src, "mimic-fn/index.js"),
	}
	ee4 := filepath.Join(src, "ee4/eventemitter3/index.js")
	pqueueDir := filepath.Join(src, "p-queue")

	plugin := api.Plugin{
		Name: "vendor",
		Setup: func(b api.PluginBuild) {
			b.OnResolve(api.OnResolveOptions{Filter: `^[^./]`}, func(a api.OnResolveArgs) (api.OnResolveResult, error) {
				if a.Path == "eventemitter3" && strings.HasPrefix(a.Importer, pqueueDir) {
					return api.OnResolveResult{Path: ee4}, nil
				}
				if p, ok := pkgs[a.Path]; ok {
					return api.OnResolveResult{Path: p}, nil
				}
				return api.OnResolveResult{}, nil // node built-ins
			})
		},
	}

	r := api.Build(api.BuildOptions{
		EntryPoints:      []string{entry},
		Bundle:           true,
		Platform:         api.PlatformNode,
		Target:           api.ES2022,
		Format:           api.FormatCommonJS,
		Outfile:          "dist/pkg/main.js",
		MinifySyntax:     true,
		MinifyWhitespace: false,
		LegalComments:    api.LegalCommentsEndOfFile,
		Plugins:          []api.Plugin{plugin},
		Tsconfig:         filepath.Join(v, "tsconfig.bundle.json"),
		Write:            true,
		LogLevel:         api.LogLevelWarning,
	})
	if len(r.Errors) > 0 {
		os.Exit(1)
	}
}
