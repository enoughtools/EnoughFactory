#!/usr/bin/env python3
"""Resolve and deliver complete source packages for EnoughFactory's pinned Ubuntu guests.

Uses only the Python standard library plus gpgv for signed archive verification.
No host package manager, Docker daemon, apt configuration or keyring is changed.
"""

import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import io
import json
import lzma
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

KIT = pathlib.Path(__file__).resolve().parent
KEY_URL = "https://archive.ubuntu.com/ubuntu/pool/main/u/ubuntu-keyring/ubuntu-keyring_2023.11.28.1_all.deb"
KEY_SHA256 = "36de43b15853ccae0028e9a767613770c704833f82586f28eb262f0311adb8a8"
SIGNERS = {"F6ECB3762474EDA9D21B7022871920D1991BC93C", "790BC7277767219C42C86F933B4FE6ACC0B21F32"}
SUITES = ["noble", "noble-updates", "noble-security", "noble-backports"]
COMPONENTS = ["main", "restricted", "universe", "multiverse"]
ARCHES = {"arm64": "arm64", "x64": "amd64"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def source_files(lock):
    unique = {}
    for package in lock["packages"]:
        for file in package["files"]:
            key = package["name"] + "/" + file["filename"]
            if key in unique:
                previous = unique[key][1]
                if previous["sha256"] != file["sha256"] or previous["size"] != file["size"]:
                    raise ValueError(f"Conflicting source bytes for {key}")
            else:
                unique[key] = (package, file)
    return unique


def download(url, destination, digest=None, size=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and (size is None or destination.stat().st_size == size) and (digest is None or sha256(destination) == digest):
        return destination
    temp = destination.with_suffix(destination.suffix + ".partial")
    for attempt in range(5):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "EnoughFactory-OS-Source-Companion/1"})
            with urllib.request.urlopen(request, timeout=120) as response, temp.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if size is not None and temp.stat().st_size != size:
                raise ValueError(f"Size mismatch for {url}")
            if digest is not None and sha256(temp) != digest:
                raise ValueError(f"SHA-256 mismatch for {url}")
            temp.replace(destination)
            return destination
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            temp.unlink(missing_ok=True)
            if attempt == 4:
                raise
            time.sleep(min(2 ** attempt, 8))


def deb822(text):
    current = {}
    field = None
    for line in text.splitlines() + [""]:
        if not line:
            if current:
                yield current
                current = {}
            field = None
        elif line[:1].isspace() and field:
            current[field] += "\n" + line[1:]
        elif ":" in line:
            field, value = line.split(":", 1)
            current[field] = value.strip()


def signed_payload(raw):
    text = raw.decode()
    if text.startswith("-----BEGIN PGP SIGNED MESSAGE-----"):
        text = text.split("\n\n", 1)[1].split("-----BEGIN PGP SIGNATURE-----", 1)[0]
        text = "\n".join(line[2:] if line.startswith("- ") else line for line in text.splitlines())
    return text


def archive_keyring(cache):
    package = download(KEY_URL, cache / "ubuntu-keyring.deb", KEY_SHA256)
    raw = package.read_bytes()
    if raw[:8] != b"!<arch>\n":
        raise ValueError("Invalid Ubuntu keyring Debian package")
    offset = 8
    while offset < len(raw):
        header = raw[offset:offset + 60]
        name = header[:16].decode().strip().rstrip("/")
        size = int(header[48:58])
        data = raw[offset + 60:offset + 60 + size]
        offset += 60 + size + size % 2
        if name.startswith("data.tar"):
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                member = archive.getmember("./usr/share/keyrings/ubuntu-archive-keyring.gpg")
                path = cache / "ubuntu-archive-keyring.gpg"
                path.write_bytes(archive.extractfile(member).read())
                return path
    raise ValueError("Ubuntu archive keyring absent from pinned package")


def release_indexes(cache, snapshot):
    keyring = archive_keyring(cache)
    base = f"https://snapshot.ubuntu.com/ubuntu/{snapshot}/"
    releases = {}
    for suite in SUITES:
        path = download(base + f"dists/{suite}/InRelease", cache / "indexes" / suite / "InRelease")
        result = subprocess.run(["gpgv", "--status-fd", "1", "--keyring", str(keyring), str(path)], capture_output=True, text=True)
        valid = {line.split()[2] for line in result.stdout.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")}
        if result.returncode != 0 or not valid.intersection(SIGNERS):
            raise ValueError(f"Untrusted Ubuntu {suite} InRelease: {result.stderr}")
        fields = next(deb822(signed_payload(path.read_bytes())))
        indexes = {}
        for line in fields["SHA256"].splitlines():
            if not line.strip():
                continue
            digest, size, relative = line.split()
            indexes[relative] = {"sha256": digest, "size": int(size)}
        releases[suite] = {"url": base + f"dists/{suite}/InRelease", "sha256": sha256(path), "signer": sorted(valid.intersection(SIGNERS))[0], "indexes": indexes}
    return base, releases


def historical_source(cache, name, version):
    """Locate publication dates via Launchpad; trust signed snapshot indexes."""
    query = urllib.parse.urlencode({"ws.op": "getPublishedSources", "source_name": name, "version": version, "exact_match": "true", "distro_series": "https://api.launchpad.net/1.0/ubuntu/noble"})
    url = "https://api.launchpad.net/1.0/ubuntu/+archive/primary?" + query
    metadata = cache / "publication-metadata" / (name + "_" + urllib.parse.quote(version, safe="") + ".json")
    download(url, metadata)
    keyring = archive_keyring(cache)
    for publication in json.loads(metadata.read_text())["entries"]:
        if not publication.get("date_published"):
            continue
        published = datetime.datetime.fromisoformat(publication["date_published"])
        at = published + datetime.timedelta(hours=12)
        if publication.get("date_superseded"):
            end = datetime.datetime.fromisoformat(publication["date_superseded"])
            if at >= end:
                at = published + (end - published) / 2
        snapshot = at.strftime("%Y%m%dT%H%M%SZ")
        suite = {"Release": "noble", "Updates": "noble-updates", "Security": "noble-security", "Proposed": "noble-proposed", "Backports": "noble-backports"}.get(publication["pocket"])
        if suite is None:
            continue
        component = publication["component_name"]
        base = f"https://snapshot.ubuntu.com/ubuntu/{snapshot}/"
        directory = cache / "historical-indexes" / snapshot / suite
        path = download(base + f"dists/{suite}/InRelease", directory / "InRelease")
        result = subprocess.run(["gpgv", "--status-fd", "1", "--keyring", str(keyring), str(path)], capture_output=True, text=True)
        valid = {line.split()[2] for line in result.stdout.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")}
        if result.returncode != 0 or not valid.intersection(SIGNERS):
            raise ValueError(f"Untrusted historical Ubuntu InRelease: {result.stderr}")
        relative = f"{component}/source/Sources.xz"
        hashes = next(deb822(signed_payload(path.read_bytes())))["SHA256"]
        index = None
        for line in hashes.splitlines():
            fields = line.split()
            if fields and fields[2] == relative:
                index = {"sha256": fields[0], "size": int(fields[1])}
                break
        if index is None:
            continue
        index_path = download(base + f"dists/{suite}/{relative}", directory / relative, index["sha256"], index["size"])
        with lzma.open(index_path, "rt") as stream:
            record = next((record for record in deb822(stream.read()) if record["Package"] == name and record["Version"] == version), None)
        if record:
            evidence = {"sourceName": name, "sourceVersion": version, "snapshot": snapshot, "publicationMetadata": {"url": url, "sha256": sha256(metadata)}, "release": {"url": base + f"dists/{suite}/InRelease", "sha256": sha256(path), "signer": sorted(valid.intersection(SIGNERS))[0]}, "sourceIndex": {"url": base + f"dists/{suite}/{relative}", **index}}
            return record, suite, relative, base, evidence
    raise ValueError(f"Exact source {name}={version} absent from inspected signed historical snapshots")


def resolve(args):
    cache = args.cache.resolve()
    base, releases = release_indexes(cache, args.snapshot)
    manifests = {}
    wanted = {}
    for arch in ARCHES:
        path = KIT / f"Ubuntu-24.04-20260926-{arch}-package.manifest"
        manifests[arch] = {"path": path.name, "sha256": sha256(path)}
        for line in path.read_text().splitlines():
            name, version = line.split()
            name = name.split(":", 1)[0]
            wanted[(arch, name, version)] = None
    jobs = []
    for suite in SUITES:
        for component in COMPONENTS:
            for kind, arch in [("Sources", None)] + [("Packages", arch) for arch in ARCHES]:
                relative = f"{component}/source/Sources.xz" if kind == "Sources" else f"{component}/binary-{ARCHES[arch]}/Packages.xz"
                if relative in releases[suite]["indexes"]:
                    info = releases[suite]["indexes"][relative]
                    jobs.append((suite, component, kind, arch, relative, info))
    def fetch_index(job):
        suite, component, kind, arch, relative, info = job
        path = cache / "indexes" / suite / relative
        download(base + f"dists/{suite}/" + relative, path, info["sha256"], info["size"])
        return job, path
    sources = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for job, path in pool.map(fetch_index, jobs):
            suite, component, kind, arch, relative, info = job
            with lzma.open(path, "rt") as f:
                records = deb822(f.read())
                for record in records:
                    if kind == "Sources":
                        sources.setdefault((record["Package"], record["Version"]), (record, suite, component, relative))
                    else:
                        key = (arch, record["Package"], record["Version"])
                        if key in wanted and wanted[key] is None:
                            source = record.get("Source", record["Package"])
                            match = re.fullmatch(r"([^ ]+)(?: \(([^)]+)\))?", source)
                            if not match:
                                raise ValueError(f"Invalid Source field: {source}")
                            built_using = []
                            for field in ["Built-Using", "Static-Built-Using"]:
                                for dependency in record.get(field, "").replace("\n", " ").split(","):
                                    if not dependency.strip():
                                        continue
                                    included = re.fullmatch(r"\s*([^ ]+)\s*\(=\s*([^)]+)\)\s*", dependency)
                                    if not included:
                                        raise ValueError(f"Unpinned {field} identity: {dependency}")
                                    built_using.append({"name": included[1], "version": included[2].strip(), "field": field})
                            wanted[key] = {"name": match[1], "version": match[2] or record["Version"], "binaryIndex": f"{suite}/{relative}", "binarySha256": record["SHA256"], "builtUsing": built_using}
    missing = [key for key, source in wanted.items() if source is None]
    if missing:
        raise ValueError(f"Pinned snapshot is missing {len(missing)} exact binary versions: {missing}. Choose an exact historical snapshot; never substitute newer source.")
    unique = sorted({(source["name"], source["version"]) for source in wanted.values()} | {(included["name"], included["version"]) for source in wanted.values() for included in source["builtUsing"]})
    packages = []
    historical_evidence = []
    for name, version in unique:
        if (name, version) not in sources:
            record, suite, relative, source_base, evidence = historical_source(cache, name, version)
            historical_evidence.append(evidence)
        else:
            record, suite, component, relative = sources[(name, version)]
            source_base = base
        files = []
        for line in record["Checksums-Sha256"].splitlines():
            if not line.strip():
                continue
            digest, size, filename = line.split()
            if pathlib.PurePosixPath(filename).name != filename:
                raise ValueError(f"Unsafe source filename: {filename}")
            files.append({"filename": filename, "sha256": digest, "size": int(size), "url": source_base + record["Directory"] + "/" + urllib.parse.quote(filename)})
        if not any(file["filename"].endswith(".dsc") for file in files):
            raise ValueError(f"Missing source descriptor for {name}={version}")
        binaries = [{"arch": key[0], "name": key[1], "version": key[2], "sourceName": source["name"], "sourceVersion": source["version"], "binaryIndex": source["binaryIndex"], "binarySha256": source["binarySha256"], "builtUsing": source["builtUsing"]} for key, source in sorted(wanted.items()) if (source["name"], source["version"]) == (name, version)]
        packages.append({"name": name, "version": version, "sourceIndex": source_base + f"dists/{suite}/{relative}", "files": files, "binaries": binaries, "builtInto": [{"arch": key[0], "binary": key[1], "binaryVersion": key[2], "field": included["field"]} for key, source in sorted(wanted.items()) for included in source["builtUsing"] if (included["name"], included["version"]) == (name, version)]})
    pins = json.loads((KIT.parent / "pins.json").read_text())
    lock = {"formatVersion": 1, "ubuntuRelease": "24.04", "imageRelease": "20260926", "snapshot": args.snapshot, "images": pins["images"], "manifests": manifests, "keyring": {"url": KEY_URL, "sha256": KEY_SHA256}, "archiveEvidence": releases, "historicalSourceEvidence": historical_evidence, "packages": packages, "sourceFileBytes": sum(file["size"] for package in packages for file in package["files"])}
    atomic_json(args.lock, lock)
    print(f"Resolved {len(wanted)} exact binaries to {len(packages)} complete source packages ({lock['sourceFileBytes']:,} bytes).", flush=True)


def fetch_sources(args):
    lock_hash = sha256(args.lock)
    lock = json.loads(args.lock.read_text())
    files = list(source_files(lock).values())
    def fetch(pair):
        package, file = pair
        path = args.cache / "sources" / package["name"] / file["filename"]
        download(file["url"], path, file["sha256"], file["size"])
        return path
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for i, path in enumerate(pool.map(fetch, files), 1):
            if i % 30 == 0 or i == len(files):
                print(f"Verified source files: {i}/{len(files)}", flush=True)
    # Source descriptors enumerate upstream and Ubuntu/debian patch archives. Verify
    # that every descriptor dependency is in the signed source index and delivered.
    for package in lock["packages"]:
        directory = args.cache / "sources" / package["name"]
        descriptor = next(file for file in package["files"] if file["filename"].endswith(".dsc"))
        fields = next(deb822(signed_payload((directory / descriptor["filename"]).read_bytes())))
        if fields["Source"] != package["name"] or fields["Version"] != package["version"]:
            raise ValueError(f"Source descriptor identity mismatch: {package['name']}")
        locked = {file["filename"]: file for file in package["files"]}
        for line in fields["Checksums-Sha256"].splitlines():
            if not line.strip():
                continue
            digest, size, filename = line.split()
            if filename not in locked or locked[filename]["sha256"] != digest or locked[filename]["size"] != int(size):
                raise ValueError(f"Incomplete descriptor source set: {package['name']}/{filename}")
    if sha256(args.lock) != lock_hash:
        raise ValueError("Source lock changed during download; run download again against the updated lock")
    atomic_json(args.cache / "download-evidence.json", {"lockSha256": lock_hash, "sourcePackages": len(lock["packages"]), "sourceFiles": len(files), "verifiedBytes": sum(file["size"] for _, file in files)})


def archive_sources(args):
    lock_hash = sha256(args.lock)
    lock = json.loads(args.lock.read_text())
    evidence_path = args.cache / "download-evidence.json"
    if not evidence_path.exists() or json.loads(evidence_path.read_text())["lockSha256"] != sha256(args.lock):
        raise ValueError("Run download against this lock before creating release archives")
    args.output.mkdir(parents=True, exist_ok=True)
    groups = [[]]
    current_size = 0
    for package in lock["packages"]:
        size = sum(file["size"] for file in package["files"])
        if groups[-1] and current_size + size > args.part_bytes:
            groups.append([])
            current_size = 0
        groups[-1].append(package)
        current_size += size
    parts = []
    written_members = set()
    for i, group in enumerate(groups, 1):
        name = f"EnoughFactory-Ubuntu-24.04-20260926-sources-part{i:02}.tar.gz"
        path = args.output / name
        # gzip mtime and tar member timestamps are fixed for reproducible output.
        with path.open("wb") as out, gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=1) as compressed, tarfile.open(fileobj=compressed, mode="w|") as archive:
            for package in group:
                for file in package["files"]:
                    member_name = f"sources/{package['name']}/{file['filename']}"
                    if member_name in written_members:
                        continue
                    written_members.add(member_name)
                    source = args.cache / "sources" / package["name"] / file["filename"]
                    if source.stat().st_size != file["size"] or sha256(source) != file["sha256"]:
                        raise ValueError(f"Source file changed before archive: {source}")
                    info = tarfile.TarInfo(member_name)
                    info.size = file["size"]
                    info.mtime = 0
                    info.mode = 0o644
                    with source.open("rb") as stream:
                        archive.addfile(info, stream)
            for companion in [args.lock, KIT / "README.md", KIT / "prepare-source-companion.py"]:
                raw = companion.read_bytes()
                info = tarfile.TarInfo("source-kit/" + companion.name)
                info.size = len(raw)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(raw))
        if path.stat().st_size >= 2_000_000_000:
            raise ValueError("Source archive exceeds GitHub's per-asset limit; reduce --part-bytes")
        parts.append({"filename": name, "sha256": sha256(path), "size": path.stat().st_size, "packages": [{"name": package["name"], "version": package["version"]} for package in group]})
        print(f"Created {name} ({path.stat().st_size:,} bytes)", flush=True)
    shutil.copyfile(args.lock, args.output / "Ubuntu-sources.lock.json")
    shutil.copyfile(KIT / "README.md", args.output / "Ubuntu-source-companion-README.md")
    evidence_path = args.output / "Ubuntu-archive-evidence.tar.gz"
    with tarfile.open(evidence_path, "w:gz", compresslevel=1) as archive:
        for directory in ["indexes", "historical-indexes", "publication-metadata"]:
            if (args.cache / directory).exists():
                archive.add(args.cache / directory, arcname=directory)
        for filename in ["ubuntu-keyring.deb", "ubuntu-archive-keyring.gpg", "download-evidence.json"]:
            archive.add(args.cache / filename, arcname=filename)
        for filename in ["image-evidence", "Ubuntu-24.04-20260926-arm64-package.manifest", "Ubuntu-24.04-20260926-x64-package.manifest", "extract-image-notices.sh"]:
            archive.add(KIT / filename, arcname=filename)
    evidence = {"filename": evidence_path.name, "sha256": sha256(evidence_path), "size": evidence_path.stat().st_size}
    index = {"formatVersion": 1, "lockSha256": sha256(args.lock), "ubuntuImages": lock["images"], "sourcePackages": len(lock["packages"]), "sourceFiles": len(source_files(lock)), "parts": parts, "evidence": evidence, "delivery": "Upload every listed part, the evidence archive, Ubuntu-sources.lock.json, this index and README as public assets to the same GitHub release as the EnoughFactory binary installers. Do not remove these assets while distributing the binary release."}
    if sha256(args.lock) != lock_hash:
        raise ValueError("Source lock changed during archive creation; rerun download/archive against the final lock")
    atomic_json(args.output / "Ubuntu-source-companion.json", index)
    (args.output / "Ubuntu-source-companion-SHA256SUMS").write_text("".join(f"{part['sha256']}  {part['filename']}\n" for part in parts) + f"{evidence['sha256']}  {evidence['filename']}\n{sha256(args.lock)}  Ubuntu-sources.lock.json\n")


def verify_archives(args):
    index = json.loads((args.output / "Ubuntu-source-companion.json").read_text())
    lock = json.loads((args.output / "Ubuntu-sources.lock.json").read_text())
    if sha256(args.output / "Ubuntu-sources.lock.json") != index["lockSha256"]:
        raise ValueError("Source companion lock hash mismatch")
    expected = {"sources/" + key: file for key, (_, file) in source_files(lock).items()}
    evidence = index["evidence"]
    evidence_path = args.output / evidence["filename"]
    if evidence_path.stat().st_size != evidence["size"] or sha256(evidence_path) != evidence["sha256"]:
        raise ValueError("Archive provenance evidence hash mismatch")
    actual = set()
    for part in index["parts"]:
        path = args.output / part["filename"]
        if path.stat().st_size != part["size"] or sha256(path) != part["sha256"]:
            raise ValueError(f"Source companion archive mismatch: {path}")
        with tarfile.open(path, "r|gz") as archive:
            for member in archive:
                if member.name.startswith("source-kit/"):
                    continue
                if member.name not in expected or member.name in actual or not member.isfile():
                    raise ValueError(f"Unexpected or duplicate source member: {member.name}")
                actual.add(member.name)
                file = expected[member.name]
                h = hashlib.sha256()
                stream = archive.extractfile(member)
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(chunk)
                if member.size != file["size"] or h.hexdigest() != file["sha256"]:
                    raise ValueError(f"Source companion member mismatch: {member.name}")
    if actual != set(expected):
        raise ValueError(f"Missing {len(set(expected) - actual)} source files")
    print(f"Verified {len(actual)} source files in {len(index['parts'])} release archives.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["resolve", "download", "archive", "verify"])
    parser.add_argument("--snapshot", default="20260926T235959Z")
    parser.add_argument("--lock", type=pathlib.Path, default=KIT / "Ubuntu-sources.lock.json")
    parser.add_argument("--cache", type=pathlib.Path, default=KIT.parents[2] / ".cache" / "ubuntu-source-companion")
    parser.add_argument("--output", type=pathlib.Path, default=KIT.parents[2] / "dist" / "ubuntu-source-companion")
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--part-bytes", type=int, default=900_000_000)
    args = parser.parse_args()
    {"resolve": resolve, "download": fetch_sources, "archive": archive_sources, "verify": verify_archives}[args.command](args)


if __name__ == "__main__":
    main()
