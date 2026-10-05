#!/usr/bin/env python3
"""Build the owned engine's runc and docker-init without using any Docker daemon.

Python 3.10+, POSIX shell and make are the only host prerequisites. The pinned
Go and Zig toolchains supply the cross compiler, Linux headers and musl libc.
The output retains sources, libseccomp objects/archive, Go external-link objects,
and an exact command/input/output manifest for rebuilding and LGPL relinking.
"""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import shlex
import shutil
import subprocess
import tarfile
import urllib.request


HERE = pathlib.Path(__file__).resolve().parent
PINS = json.loads((HERE / "native-pins.json").read_text())


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fetch(pin, cache):
    name = pin["url"].rsplit("/", 1)[1]
    # GitHub codeload URLs end in the tag rather than an archive filename.
    if not name.endswith((".gz", ".xz")):
        name = pin["root"] + ".tar.gz"
    archive = cache / name
    if not archive.exists():
        print("Downloading", pin["url"], flush=True)
        temporary = archive.with_suffix(archive.suffix + ".download")
        urllib.request.urlretrieve(pin["url"], temporary)
        temporary.replace(archive)
    actual = sha256(archive)
    if actual != pin["sha256"]:
        raise RuntimeError(f"Hash mismatch for {archive}: {actual}")
    return archive


def extract(archive, parent, root):
    destination = parent / root
    if not destination.exists():
        parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as t:
            for member in t.getmembers():
                candidate = (parent / member.name).resolve()
                if not candidate.is_relative_to(parent.resolve()):
                    raise RuntimeError("Archive contains an escaping path")
                if member.issym() or member.islnk():
                    target = ((candidate.parent if member.issym() else parent) / member.linkname).resolve()
                    if not target.is_relative_to(parent.resolve()):
                        raise RuntimeError("Archive contains an escaping link")
            t.extractall(parent)
    return destination


def shell_script(path, body):
    path.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
    path.chmod(0o755)
    return path


def run(args, cwd, env, log, records):
    record = {"argv": [str(x) for x in args], "cwd": str(cwd), "log": str(log)}
    # Only build-related environment values are retained, never credentials.
    record["environment"] = {k: env[k] for k in (
        "GOOS", "GOARCH", "GOTOOLCHAIN", "CGO_ENABLED", "CC", "AR", "RANLIB",
        "PKG_CONFIG", "CGO_CFLAGS", "CGO_LDFLAGS", "GOCACHE", "GOMODCACHE",
        "ZIG_GLOBAL_CACHE_DIR", "ZIG_LOCAL_CACHE_DIR", "SOURCE_DATE_EPOCH"
    ) if k in env}
    records.append(record)
    print(shlex.join(record["argv"]), flush=True)
    with open(log, "wb") as output:
        result = subprocess.run(record["argv"], cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        print(log.read_text(errors="replace")[-12000:], flush=True)
        raise RuntimeError(f"Build failed with exit {result.returncode}; see {log}")


def build_arch(arch, output, work, sources, zig, go, jobs, records):
    target = {"x64": "x86_64-linux-musl", "arm64": "aarch64-linux-musl"}[arch]
    goarch = {"x64": "amd64", "arm64": "arm64"}[arch]
    out = output / arch
    retained = out / "relink"
    build = work / arch
    sysroot = retained / "sysroot"
    for directory in [out, build, retained / "libseccomp-objects", retained / "runc-link-objects",
                      sysroot / "lib" / "pkgconfig", sysroot / "include"]:
        directory.mkdir(parents=True, exist_ok=True)
    wrappers = build / "wrappers"
    wrappers.mkdir(exist_ok=True)
    linker_log = retained / "external-link-command.json"
    cc = wrappers / "cc"
    # Log the final external linker invocation, not transient compile commands.
    # -tmpdir below keeps all objects named in this command after Go returns.
    cc.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                  f"argv = [{str(zig)!r}, 'cc', '-target', {target!r}] + sys.argv[1:]\n"
                  "if any(x.endswith('/go.o') for x in sys.argv[1:]):\n"
                  f"    open({str(linker_log)!r}, 'w').write(json.dumps(argv, indent=2) + '\\n')\n"
                  "os.execv(argv[0], argv)\n")
    cc.chmod(0o755)
    ar = shell_script(wrappers / "ar", f"exec {shlex.quote(str(zig))} ar \"$@\"")
    ranlib = shell_script(wrappers / "ranlib", f"exec {shlex.quote(str(zig))} ranlib \"$@\"")
    pkg_config = wrappers / "pkg-config"
    # This adapter intentionally supports exactly the one cgo package we build.
    pkg_config.write_text("#!/usr/bin/env python3\nimport sys\n"
                          "args=sys.argv[1:]\n"
                          "if 'libseccomp' not in args: sys.exit('Only libseccomp is supported')\n"
                          f"if '--cflags' in args: print('-I{sysroot / 'include'}')\n"
                          f"elif '--libs' in args: print('-L{sysroot / 'lib'} -lseccomp')\n"
                          "elif '--modversion' in args: print('2.6.0')\n"
                          "elif '--exists' not in args: sys.exit('Unsupported pkg-config request')\n")
    pkg_config.chmod(0o755)
    env = os.environ.copy()
    env.update({"CC": str(cc), "AR": str(ar), "RANLIB": str(ranlib), "PKG_CONFIG": str(pkg_config),
                "GOOS": "linux", "GOARCH": goarch, "GOTOOLCHAIN": "local", "CGO_ENABLED": "1",
                "SOURCE_DATE_EPOCH": "1790284342", "GOCACHE": str(work / "go-cache"),
                "GOMODCACHE": str(work / "go-mod-cache"), "ZIG_GLOBAL_CACHE_DIR": str(work / "zig-cache"),
                "ZIG_LOCAL_CACHE_DIR": str(build / "zig-local-cache")})
    libbuild = build / "libseccomp"
    libbuild.mkdir(exist_ok=True)
    host_system = "apple-darwin" if platform.system() == "Darwin" else "linux-gnu"
    host_cpu = "aarch64" if platform.machine() in ("arm64", "aarch64") else "x86_64"
    run([sources["libseccomp"] / "configure", "--host=" + target, "--build=" + host_cpu + "-" + host_system,
         "--prefix=" + str(sysroot), "--enable-static", "--disable-shared", "--disable-python", "CFLAGS=-O2 -fPIC"],
        libbuild, env, retained / "libseccomp-configure.log", records)
    run(["make", f"-j{jobs}", "-C", "src", "libseccomp.la"], libbuild, env,
        retained / "libseccomp-build.log", records)
    shutil.copy2(libbuild / "src" / ".libs" / "libseccomp.a", sysroot / "lib" / "libseccomp.a")
    shutil.copy2(libbuild / "include" / "seccomp.h", sysroot / "include" / "seccomp.h")
    shutil.copy2(sources["libseccomp"] / "include" / "seccomp-syscalls.h", sysroot / "include" / "seccomp-syscalls.h")
    shutil.copy2(libbuild / "libseccomp.pc", sysroot / "lib" / "pkgconfig" / "libseccomp.pc")
    shutil.copy2(libbuild / "configure.h", retained / "libseccomp-configure.h")
    for obj in (libbuild / "src").glob("*.o"):
        shutil.copy2(obj, retained / "libseccomp-objects" / obj.name)
    for obj in (libbuild / "src" / ".libs").glob("*.o"):
        shutil.copy2(obj, retained / "libseccomp-objects" / obj.name)
    env["CGO_CFLAGS"] = "-O2 -g -I" + str(sysroot / "include")
    env["CGO_LDFLAGS"] = "-L" + str(sysroot / "lib")
    # Match Moby's runc tags: retain seccomp, omit optional libpathrs. Static
    # non-PIE musl is intentional: it avoids a dependency on a host libc loader.
    tags = "seccomp urfave_cli_no_docs netgo osusergo"
    ldflags = ("-X main.gitCommit=" + PINS["runc"]["commit"] +
               " -linkmode external -extldflags -static -tmpdir " + str(retained / "runc-link-objects"))
    run([go, "build", "-mod=vendor", "-buildvcs=false", "-trimpath", f"-p={jobs}", "-tags", tags,
         "-ldflags", ldflags, "-o", out / "runc", "."], sources["runc"], env, retained / "runc-build.log", records)
    version_header = retained / "tiniConfig.h"
    version_header.write_text('#define TINI_VERSION "0.19.0"\n#define TINI_GIT ""\n')
    tini_obj = retained / "tini.o"
    # Tini 0.19.0 assumes glibc exposes basename through string.h and predates
    # Clang's strict-prototype warning. libgen.h supplies the correct musl
    # declaration without changing upstream source or runtime behavior.
    tini_flags = ["-std=gnu99", "-Werror", "-Wextra", "-Wall", "-pedantic-errors", "-O2",
                  "-Wno-strict-prototypes", "-include", "libgen.h",
                  "-fstack-protector-strong", "-Wformat", "-D_FORTIFY_SOURCE=2", "-I" + str(retained)]
    run([cc, *tini_flags, "-c", sources["tini"] / "src" / "tini.c", "-o", tini_obj], build, env,
        retained / "tini-compile.log", records)
    # Dynamic symbol/export flags from upstream CMake do not apply to this
    # static executable and are not accepted by Zig's linker argument parser.
    run([cc, "-static", "-Wl,-z,relro",
         tini_obj, "-o", out / "docker-init"], build, env, retained / "tini-link.log", records)
    run([go, "version", "-m", out / "runc"], build, env, retained / "runc-go-build-info.txt", records)
    run(["file", out / "runc", out / "docker-init"], build, env, retained / "elf-file.txt", records)
    return {"architecture": arch, "target": target, "buildTags": tags.split(), "seccomp": True,
            "libc": "musl 1.2.5 (Zig 0.15.2)", "binaries": {
                name: {"path": str(out / name), "sha256": sha256(out / name), "bytes": (out / name).stat().st_size}
                for name in ("runc", "docker-init")},
            "relinkFiles": [{"path": str(p), "sha256": sha256(p)} for p in sorted(retained.rglob("*")) if p.is_file()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--work", type=pathlib.Path, help="Retained toolchains, unpacked sources and build work")
    parser.add_argument("--cache", type=pathlib.Path, help="Verified download cache")
    parser.add_argument("--arch", choices=["x64", "arm64"], action="append")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--libseccomp-source", type=pathlib.Path,
                        help="Configured libseccomp source tree to rebuild against a recipient's modifications")
    args = parser.parse_args()
    output = args.output.resolve()
    work = (args.work or output / "build-work").resolve()
    cache = (args.cache or work / "downloads").resolve()
    for directory in (output, work, cache):
        directory.mkdir(parents=True, exist_ok=True)
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    cpu = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(platform.machine())
    host = f"{system}-{cpu}"
    if host not in PINS["zig"]["hosts"]:
        raise RuntimeError(f"Unsupported build host: {host}")
    inputs, sources = {}, {}
    for name in ("runc", "libseccomp", "tini"):
        archive = fetch(PINS[name], cache)
        inputs[name] = {**PINS[name], "archive": str(archive)}
        sources[name] = extract(archive, work / "sources", PINS[name]["root"])
    if args.libseccomp_source:
        sources["libseccomp"] = args.libseccomp_source.resolve()
        inputs["libseccomp"]["replacementSource"] = str(sources["libseccomp"])
    toolchains = {}
    for name in ("zig", "go"):
        pin = PINS[name]["hosts"][host]
        archive = fetch(pin, cache)
        directory = extract(archive, work / "toolchains" / name, pin["root"])
        toolchains[name] = {"version": PINS[name]["version"], **pin, "archive": str(archive), "directory": str(directory)}
    zig = pathlib.Path(toolchains["zig"]["directory"]) / "zig"
    go = pathlib.Path(toolchains["go"]["directory"]) / "bin" / "go"
    if subprocess.check_output([go, "version"], text=True).strip() != f"go version go1.26.8 {system}/{cpu}":
        raise RuntimeError("Go toolchain version mismatch")
    if subprocess.check_output([zig, "version"], text=True).strip() != "0.15.2":
        raise RuntimeError("Zig toolchain version mismatch")
    records, builds = [], []
    for arch in args.arch or ["x64", "arm64"]:
        builds.append(build_arch(arch, output, work, sources, zig, go, args.jobs, records))
    source_files = [{"component": name, "path": str(p), "sha256": sha256(p)}
                    for name, root in sources.items() for p in sorted(root.rglob("*")) if p.is_file()]
    manifest = {"schemaVersion": 1, "host": host, "inputs": inputs, "toolchains": toolchains,
                "sourceDirectories": {k: str(v) for k, v in sources.items()}, "sourceFiles": source_files,
                "commands": records, "builds": builds, "buildScriptSha256": sha256(pathlib.Path(__file__).resolve()),
                "pinsSha256": sha256(HERE / "native-pins.json")}
    (output / "native-build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copy2(HERE / "native-pins.json", output / "native-pins.json")
    shutil.copy2(pathlib.Path(__file__).resolve(), output / "build-native.py")
    print("Native build manifest:", output / "native-build-manifest.json", flush=True)


if __name__ == "__main__":
    main()
