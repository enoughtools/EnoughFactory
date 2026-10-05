// Build-time notice collector. It does not become part of the runtime binary.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type module struct{ Path, Version, Dir, Sum, GoModSum string }

func main() {
	if len(os.Args) != 2 {
		panic("license output directory is required")
	}
	output := os.Args[1]
	command := exec.Command("go", "list", "-m", "-json", "all")
	data, err := command.Output()
	check(err)
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	var manifest []module
	for {
		var dependency module
		err := decoder.Decode(&dependency)
		if err == io.EOF {
			break
		}
		check(err)
		manifest = append(manifest, dependency)
		if dependency.Dir == "" {
			continue
		}
		entries, err := os.ReadDir(dependency.Dir)
		check(err)
		destination := filepath.Join(output, strings.ReplaceAll(dependency.Path, "/", "__")+"@"+dependency.Version)
		check(os.MkdirAll(destination, 0755))
		for _, entry := range entries {
			name := strings.ToLower(entry.Name())
			if entry.IsDir() || !(strings.HasPrefix(name, "license") || strings.HasPrefix(name, "licence") || strings.HasPrefix(name, "notice") || strings.HasPrefix(name, "copying")) {
				continue
			}
			contents, err := os.ReadFile(filepath.Join(dependency.Dir, entry.Name()))
			check(err)
			check(os.WriteFile(filepath.Join(destination, entry.Name()), contents, 0644))
		}
	}
	contents, err := json.MarshalIndent(manifest, "", "  ")
	check(err)
	check(os.WriteFile(filepath.Join(output, "modules.json"), contents, 0644))
	fmt.Printf("Retained notices for %d Go modules\n", len(manifest))
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}
