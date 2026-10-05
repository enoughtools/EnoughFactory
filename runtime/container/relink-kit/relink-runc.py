#!/usr/bin/env python3
"""Relink the retained runc application objects against replacement libseccomp.

This uses the original external-link argv, remapping paths into the extracted
source kit. No Docker daemon or Go compilation is needed. Use Zig 0.15.2 as
pinned in native-pins.json. --libseccomp accepts an archive or directory holding
libseccomp.a. To modify inlined library header code as well, use build-native.py
with --libseccomp-source instead of relinking the existing application objects.
"""

import argparse
import json
import pathlib
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", required=True, type=pathlib.Path)
    parser.add_argument("--libseccomp", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--zig", required=True, type=pathlib.Path)
    args = parser.parse_args()
    kit = args.kit.resolve()
    library = args.libseccomp.resolve()
    if library.is_dir():
        library = library / "libseccomp.a"
    if not library.is_file():
        raise RuntimeError("Replacement libseccomp archive is missing")
    zig = args.zig.resolve()
    if subprocess.check_output([zig, "version"], text=True).strip() != "0.15.2":
        raise RuntimeError("Expected the pinned Zig 0.15.2 toolchain")
    original = json.loads((kit / "external-link-command.json").read_text())
    go_object = next(pathlib.Path(a) for a in original if a.endswith("/go.o"))
    old_kit = str(go_object.parent.parent)
    argv = [str(zig), *[a.replace(old_kit, str(kit)) for a in original[1:]]]
    argv[argv.index("-o") + 1] = str(args.output.resolve())
    if "-lseccomp" not in argv:
        raise RuntimeError("Recorded link command has no libseccomp input")
    argv = [str(library) if arg == "-lseccomp" else arg for arg in argv]
    # Confirm all explicit application objects survive source-kit relocation.
    for arg in argv:
        if arg.endswith(".o") and not pathlib.Path(arg).is_file():
            raise RuntimeError("Retained application object is missing: " + arg)
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(argv, check=True)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
