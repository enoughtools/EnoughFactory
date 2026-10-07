#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

static void expect(const char *label, int result, int expected_result, int expected_error) {
  int actual_error = result == -1 ? errno : 0;
  if (result != expected_result || actual_error != expected_error) {
    fprintf(stderr, "%s: result=%d errno=%d; expected result=%d errno=%d\n", label, result, actual_error, expected_result, expected_error);
    exit(1);
  }
  printf("PASS %s result=%d errno=%d\n", label, result, actual_error);
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int masked = strcmp(argv[1], "shim") == 0;
  const char *provenance = "com.apple.provenance";
  const char *directory = argv[2];
  if (mkdir(directory, 0700) != 0) return 3;
  char file[4096], link[4096], missing[4096];
  snprintf(file, sizeof file, "%s/file", directory);
  snprintf(link, sizeof link, "%s/external-directory-link", directory);
  snprintf(missing, sizeof missing, "%s/missing", directory);
  int file_fd = open(file, O_RDWR | O_CREAT | O_EXCL, 0600);
  if (file_fd < 0 || write(file_fd, "preserve", 8) != 8) return 4;
  int directory_fd = open(directory, O_RDONLY | O_DIRECTORY);
  if (directory_fd < 0) return 5;
  char outside[] = "/tmp/enough-provenance-external.XXXXXX";
  if (!mkdtemp(outside) || symlink(outside, link) != 0) return 6;
  if (setxattr(outside, "user.sentinel", "keep", 4, 0) != 0) return 7;

  int expected_result = masked ? 0 : -1;
  int expected_error = masked ? 0 : EOPNOTSUPP;
  expect("directory setxattr provenance", setxattr(directory, provenance, "x", 1, 0), expected_result, expected_error);
  expect("directory lsetxattr provenance", lsetxattr(directory, provenance, "x", 1, 0), expected_result, expected_error);
  expect("directory fsetxattr provenance", fsetxattr(directory_fd, provenance, "x", 1, 0), expected_result, expected_error);
  expect("other unsupported attribute remains failure", setxattr(directory, "com.enoughfactory.unsupported", "x", 1, 0), -1, EOPNOTSUPP);
  expect("regular file setxattr remains failure", setxattr(file, provenance, "x", 1, 0), -1, EOPNOTSUPP);
  expect("regular file fsetxattr remains failure", fsetxattr(file_fd, provenance, "x", 1, 0), -1, EOPNOTSUPP);
  expect("symlink setxattr remains failure", setxattr(link, provenance, "x", 1, 0), -1, EOPNOTSUPP);
  expect("symlink lsetxattr remains failure", lsetxattr(link, provenance, "x", 1, 0), -1, EOPNOTSUPP);
  expect("missing path remains ENOENT", setxattr(missing, provenance, "x", 1, 0), -1, ENOENT);
  expect("invalid fd remains EBADF", fsetxattr(-1, provenance, "x", 1, 0), -1, EBADF);
  expect("invalid flags remain EINVAL", setxattr(directory, provenance, "x", 1, 0x40000000), -1, EINVAL);
  expect("supported attribute still succeeds", setxattr(directory, "user.enoughfactory", "value", 5, 0), 0, 0);
  expect("supported attribute EEXIST preserved", setxattr(directory, "user.enoughfactory", "changed", 7, XATTR_CREATE), -1, EEXIST);
  char value[16] = {0};
  if (getxattr(outside, "user.sentinel", value, sizeof value) != 4 || memcmp(value, "keep", 4)) return 8;
  memset(value, 0, sizeof value);
  if (pread(file_fd, value, sizeof value, 0) != 8 || memcmp(value, "preserve", 8)) return 9;
  struct stat before;
  if (lstat(link, &before) != 0 || !S_ISLNK(before.st_mode)) return 10;
  printf("PASS external symlink target attribute, file bytes and symlink preserved\n");
  close(file_fd);
  close(directory_fd);
  unlink(link);
  rmdir(outside);
  return 0;
}
