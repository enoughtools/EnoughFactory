#!/usr/bin/env bash
# Read-only package/legal evidence extraction from a pinned Ubuntu cloud image.
# Requires qemu-utils, Python 3, util-linux, tar; run as root in the owned guest.
set -euo pipefail
image=$1
arch=$2
expected=$3
out=$4
nbd=${5:-/dev/nbd0}
mkdir -p "$out"
actual=$(sha256sum "$image" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo 'Pinned image hash mismatch' >&2; exit 1; }
qemu-img info --output=json "$image" > "$out/image-info.json"
python3 - "$arch" "$image" "$actual" "$out" <<'PYMETA'
import json,sys,datetime,pathlib
arch,image,digest,out=sys.argv[1:]
pathlib.Path(out,'image-manifest.json').write_text(json.dumps({'architecture':arch,'imagePath':image,'sha256':digest,'extractedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mountMode':'read-only, ext4 noload','format':'unmodified upstream Ubuntu 24.04 cloud image'},indent=2)+'\n')
PYMETA
mountpoint=$(mktemp -d /tmp/enoughfactory-ubuntu-image.XXXXXX)
connected=0
cleanup() {
  if mountpoint -q "$mountpoint"; then umount "$mountpoint"; fi
  if [ "$connected" = 1 ]; then qemu-nbd --disconnect "$nbd"; fi
  rmdir "$mountpoint"
}
trap cleanup EXIT
modprobe nbd max_part=16
[ ! -e "/sys/class/block/${nbd##*/}/pid" ] || { echo 'NBD device is already attached' >&2; exit 1; }
qemu-nbd --read-only --connect="$nbd" "$image"
connected=1
udevadm settle
[ "$(blockdev --getro "$nbd")" = 1 ]
lsblk --json --fs "$nbd" > "$out/partitions.json"
mount -t ext4 -o ro,noload "${nbd}p1" "$mountpoint"
[ -f "$mountpoint/var/lib/dpkg/status" ]
cp "$mountpoint/var/lib/dpkg/status" "$out/dpkg-status"
cp "$mountpoint/etc/os-release" "$out/os-release"
python3 - "$mountpoint" "$out" <<'PYDPKG'
import json,pathlib,re,sys,hashlib,os
root,out=map(pathlib.Path,sys.argv[1:])
records=[]
for para in (root/'var/lib/dpkg/status').read_text().split('\n\n'):
    fields={}; key=None
    for line in para.splitlines():
        if line.startswith((' ','\t')) and key:
            fields[key]+='\n'+line
        elif ':' in line:
            key,value=line.split(':',1); fields[key]=value.lstrip(' ')
    if fields.get('Status')!='install ok installed': continue
    source=fields.get('Source',fields['Package'])
    match=re.fullmatch(r'([^\s]+)(?: \(([^)]+)\))?',source)
    records.append({'binaryPackage':fields['Package'],'binaryVersion':fields['Version'],'architecture':fields['Architecture'],'sourceField':fields.get('Source'),'sourcePackage':match[1] if match else source,'sourceVersion':match[2] if match and match[2] else fields['Version'],'status':fields['Status']})
(out/'package-sources.json').write_text(json.dumps(records,indent=2)+'\n')
copyrights=[]
notice_paths=[]
for folder,dirs,files in os.walk(root/'usr/share/doc',followlinks=True):
    if 'copyright' in files: notice_paths.append(pathlib.Path(folder)/'copyright')
for p in sorted(notice_paths):
    if p.is_file():
        data=p.read_bytes()
        copyrights.append({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'symlink':os.readlink(p) if p.is_symlink() else None})
notice_paths={x['path'] for x in copyrights}
for item in records:
    notice='usr/share/doc/'+item['binaryPackage']+'/copyright'
    item['copyrightPath']=notice if notice in notice_paths else None
(out/'package-sources.json').write_text(json.dumps(records,indent=2)+'\n')
(out/'copyright-manifest.json').write_text(json.dumps(copyrights,indent=2)+'\n')
(out/'notice-file-list.txt').write_text(''.join(x['path']+'\n' for x in copyrights)+'usr/share/common-licenses\n')
snaps=[]
for folder in ['var/lib/snapd/snaps','var/lib/snapd/seed/snaps']:
    directory=root/folder
    if not directory.exists(): continue
    for p in sorted(directory.rglob('*')):
        if p.is_file():
            data=p.read_bytes()
            snaps.append({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'symlink':os.readlink(p) if p.is_symlink() else None})
(out/'snap-file-manifest.json').write_text(json.dumps(snaps,indent=2)+'\n')
PYDPKG
tar --dereference -C "$mountpoint" -czf "$out/copyright-and-common-licenses.tar.gz" -T "$out/notice-file-list.txt"
# Preserve image construction metadata and exact apt/source configuration.
python3 - "$mountpoint" "$out" <<'PYCONFIG'
import pathlib,sys
root,out=map(pathlib.Path,sys.argv[1:])
paths=['etc/cloud','etc/apt','etc/os-release','etc/lsb-release','var/lib/snapd/seed','var/lib/snapd/snaps','var/lib/snapd/state.json','usr/share/doc/cloud-init','usr/share/doc/ubuntu-minimal','usr/share/doc/ubuntu-server-minimal']
(out/'construction-file-list.txt').write_text(''.join(p+'\n' for p in paths if (root/p).exists()))
PYCONFIG
tar --dereference -C "$mountpoint" -czf "$out/image-construction-and-snaps.tar.gz" -T "$out/construction-file-list.txt"
sha256sum "$image" | cut -d ' ' -f 1 > "$out/image-post-extraction.sha256"
[ "$(cat "$out/image-post-extraction.sha256")" = "$expected" ]
echo "Extracted $arch evidence to $out"
