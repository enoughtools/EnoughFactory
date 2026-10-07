/** Provisioning only: prepare the next ordinary boot, without checking a mounted filesystem. */
export const ROOT_FILESYSTEM_BOOT_TOOLS_SCRIPT = `
enoughfactory_kernel="$(uname -r)"
case "$enoughfactory_kernel" in
  ''|*[!a-zA-Z0-9._+-]*) echo 'The private runtime reported an invalid kernel version.' >&2; exit 1 ;;
esac
enoughfactory_initrd="/boot/initrd.img-$enoughfactory_kernel"
for enoughfactory_tool in fsck e2fsck fsck.ext4 logsave lsinitramfs update-initramfs; do
  if ! command -v "$enoughfactory_tool" >/dev/null 2>&1; then
    echo "The private runtime is missing the boot filesystem tool: $enoughfactory_tool" >&2
    exit 1
  fi
done
enoughfactory_boot_tools_present() {
  enoughfactory_listing="$(lsinitramfs "$enoughfactory_initrd")" || return 1
  for enoughfactory_required in fsck e2fsck fsck.ext4 logsave; do
    if ! printf '%s\\n' "$enoughfactory_listing" | awk -v required="$enoughfactory_required" '
      $0 == "usr/sbin/" required || $0 == "sbin/" required { found = 1 }
      END { exit !found }
    '; then
      return 1
    fi
  done
}
if ! enoughfactory_boot_tools_present; then
  update-initramfs -u -k "$enoughfactory_kernel"
  if ! enoughfactory_boot_tools_present; then
    echo 'The private runtime boot image still lacks required filesystem checking tools after rebuilding.' >&2
    exit 1
  fi
fi
unset -f enoughfactory_boot_tools_present
unset enoughfactory_kernel enoughfactory_initrd enoughfactory_tool enoughfactory_listing enoughfactory_required
`;
