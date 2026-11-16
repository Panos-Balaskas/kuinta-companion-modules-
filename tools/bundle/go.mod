module blackbox-eventmaster-bundle

go 1.24

require github.com/evanw/esbuild v0.28.2

require golang.org/x/sys v0.20.0 // indirect

replace github.com/evanw/esbuild => /home/claude/tools/esbuild

replace golang.org/x/sys => /home/claude/tools/sys
