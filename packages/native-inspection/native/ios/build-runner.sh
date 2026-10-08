#!/bin/sh
set -eu

task_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_build_dir=${1:-"$task_script_dir/.build"}
mkdir -p "$task_build_dir"
task_build_dir=$(CDPATH= cd -- "$task_build_dir" && pwd)
task_node=${ENOUGH_NATIVE_NODE:-node}
"$task_node" "$task_script_dir/../build-receipt.mjs" begin ios-simulator "$task_build_dir"

# Build-only: never boot, install into, reset, or launch a simulator here.
# Clear only this runner's derived products/intermediates to force current Swift compilation.
rm -rf -- "$task_build_dir/Build"
xcodebuild build-for-testing \
  -project "$task_script_dir/EnoughNativeInspection.xcodeproj" \
  -scheme EnoughNativeInspection \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$task_build_dir" \
  CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=NO

"$task_node" "$task_script_dir/../build-receipt.mjs" finish ios-simulator "$task_build_dir"

find "$task_build_dir/Build/Products" -maxdepth 1 -name '*.xctestrun' -print
