import { createHash } from "node:crypto";
import type { CheckCompatibilityEvidence } from "./types.ts";

/**
 * Swift Foundation 6.0.3 replays directory xattrs and fails when Linux rejects the
 * ambient macOS provenance namespace. This matches Foundation PR #1677's errno
 * correction, narrowed to one non-source attribute and real directory objects.
 * No candidate bytes, host attributes or immutable toolchain images are changed.
 */
export const SWIFT_CHECK_COMPATIBILITY_SOURCE = String.raw`#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>

typedef int (*path_setter)(const char *, const char *, const void *, size_t, int);
typedef int (*fd_setter)(int, const char *, const void *, size_t, int);
static path_setter original_setxattr;
static path_setter original_lsetxattr;
static fd_setter original_fsetxattr;
static pthread_once_t initialized = PTHREAD_ONCE_INIT;

static void initialize(void) {
  original_setxattr = (path_setter)dlsym(RTLD_NEXT, "setxattr");
  original_lsetxattr = (path_setter)dlsym(RTLD_NEXT, "lsetxattr");
  original_fsetxattr = (fd_setter)dlsym(RTLD_NEXT, "fsetxattr");
}

static int is_unsupported_provenance(const char *name, int error) {
  return (error == EOPNOTSUPP || error == ENOTSUP) && name &&
    strcmp(name, "com.apple.provenance") == 0;
}

static int path_result(int result, int error, const char *path, const char *name) {
  if (result == -1 && is_unsupported_provenance(name, error)) {
    struct stat entry;
    /* lstat deliberately refuses a symlink leaf, including for setxattr. */
    if (lstat(path, &entry) == 0 && S_ISDIR(entry.st_mode)) result = 0;
  }
  errno = error;
  return result;
}

int setxattr(const char *path, const char *name, const void *value, size_t size, int flags) {
  pthread_once(&initialized, initialize);
  if (!original_setxattr) { errno = ENOSYS; return -1; }
  int result = original_setxattr(path, name, value, size, flags);
  return path_result(result, errno, path, name);
}

int lsetxattr(const char *path, const char *name, const void *value, size_t size, int flags) {
  pthread_once(&initialized, initialize);
  if (!original_lsetxattr) { errno = ENOSYS; return -1; }
  int result = original_lsetxattr(path, name, value, size, flags);
  return path_result(result, errno, path, name);
}

int fsetxattr(int fd, const char *name, const void *value, size_t size, int flags) {
  pthread_once(&initialized, initialize);
  if (!original_fsetxattr) { errno = ENOSYS; return -1; }
  int result = original_fsetxattr(fd, name, value, size, flags);
  int error = errno;
  if (result == -1 && is_unsupported_provenance(name, error)) {
    struct stat entry;
    if (fstat(fd, &entry) == 0 && S_ISDIR(entry.st_mode)) result = 0;
  }
  errno = error;
  return result;
}
`;

const sourceSha256 = sha256(SWIFT_CHECK_COMPATIBILITY_SOURCE);
const marker = "ENOUGHFACTORY_CHECK_COMPATIBILITY_V1 ";
const scope = "check-command-and-descendants; suppress-only-EOPNOTSUPP/ENOTSUP-for-com.apple.provenance-on-real-directories" as const;
// The helper is executed by the pinned image's shell before loading candidate code.
// Its private path is not a host mount; the library and compiler output die with
// this container. The preload applies only to the assigned command and children.
const helper = `compatibility_directory=$(mktemp -d /tmp/enoughfactory-check-compatibility.XXXXXXXX) || exit 125
cat > "$compatibility_directory/provenance.c" <<'ENOUGHFACTORY_PROVENANCE_C'
${SWIFT_CHECK_COMPATIBILITY_SOURCE}ENOUGHFACTORY_PROVENANCE_C
clang -shared -fPIC -O2 -Wall -Wextra -Werror -pthread "$compatibility_directory/provenance.c" -o "$compatibility_directory/provenance.so" -ldl || exit 125
compatibility_compiled_sha=$(sha256sum "$compatibility_directory/provenance.so") || exit 125
compatibility_compiled_sha=\${compatibility_compiled_sha%% *}
printf '${marker}%s\\n' "$compatibility_compiled_sha"
`;
const helperSha256 = sha256(helper);

export function swiftCheckCompatibilityBootstrap(): { preparation: string; invocation: string } {
  return { preparation: helper, invocation: 'env LD_PRELOAD="$compatibility_directory/provenance.so" bash -lc "$1"' };
}

/** Only the trusted first line is evidence; later command output stays untouched. */
export function captureSwiftCheckCompatibility<T extends { stdout: string; stderr: string }>(result: T): T & { runtimeCompatibility: CheckCompatibilityEvidence } {
  const newline = result.stdout.indexOf("\n");
  const first = newline < 0 ? result.stdout : result.stdout.slice(0, newline);
  const compiledSha256 = first.startsWith(marker) ? first.slice(marker.length) : "";
  if (newline < 0 || !/^[a-f0-9]{64}$/.test(compiledSha256)) {
    throw new Error(`Swift check compatibility bootstrap produced no valid compiled-library evidence${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  return { ...result, stdout: result.stdout.slice(newline + 1), runtimeCompatibility: { id: "swift-foundation-provenance-v1", helperSha256, sourceSha256, compiledSha256, scope } };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
