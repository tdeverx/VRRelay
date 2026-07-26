#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

export COPYFILE_DISABLE=1
export LC_ALL=C
export TZ=UTC

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="${VRRELAY_RUNTIME_MANIFEST:-$ROOT/deploy/runtime-manifest.json}"
MANIFEST="${MANIFEST:A}"
OUTPUT_DIR="${1:-$ROOT/dist/macos/ffmpeg-build}"
OUTPUT_DIR="${OUTPUT_DIR:A}"
SOURCE_ARCHIVE_DIR="${VRRELAY_FFMPEG_SOURCE_DIR:-}"
if [[ -n "$SOURCE_ARCHIVE_DIR" ]]; then
  SOURCE_ARCHIVE_DIR="${SOURCE_ARCHIVE_DIR:A}"
  [[ -d "$SOURCE_ARCHIVE_DIR" ]] || { echo "FFmpeg source directory not found: $SOURCE_ARCHIVE_DIR" >&2; exit 2; }
fi

[[ "$(uname -s)" == Darwin ]] || { echo 'The macOS FFmpeg build requires macOS' >&2; exit 2; }
[[ "$(uname -m)" == arm64 ]] || { echo 'The macOS FFmpeg build requires an arm64 host' >&2; exit 2; }

for tool in node curl shasum tar xcrun xcodebuild make pkg-config meson ninja autoreconf otool lipo; do
  command -v "$tool" >/dev/null || { echo "Missing macOS FFmpeg build tool: $tool" >&2; exit 2; }
done

if command -v glibtoolize >/dev/null; then
  LIBTOOLIZE="$(command -v glibtoolize)"
elif command -v libtoolize >/dev/null; then
  LIBTOOLIZE="$(command -v libtoolize)"
else
  echo 'Missing macOS FFmpeg build tool: glibtoolize or libtoolize' >&2
  exit 2
fi
export LIBTOOLIZE

recipe_fields="$(node - "$MANIFEST" <<'NODE'
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ffmpeg = manifest.components.find((component) => component.name === 'ffmpeg');
const recipe = ffmpeg?.sourceBuilds?.['darwin-arm64'];
if (!recipe) throw new Error('runtime manifest is missing the darwin-arm64 FFmpeg source build');
for (const field of ['target', 'minimumMacOS', 'linkage', 'ffmpegCommit']) {
  if (!recipe[field] || /[\t\r\n]/.test(recipe[field]))
    throw new Error(`invalid darwin-arm64 FFmpeg source build field: ${field}`);
}
if (!/^[0-9a-f]{40}$/.test(recipe.ffmpegCommit))
  throw new Error('invalid darwin-arm64 FFmpeg source revision');
const ffmpegInput = recipe.inputs?.find((input) => input.name === 'ffmpeg');
if (ffmpegInput?.revision !== recipe.ffmpegCommit)
  throw new Error('macOS FFmpeg input revision does not match the shared runtime revision');
process.stdout.write(
  `${recipe.target}\t${recipe.minimumMacOS}\t${recipe.linkage}\t${recipe.ffmpegCommit}`
);
NODE
)"
IFS=$'\t' read -r BUILD_TARGET MINIMUM_MACOS BUILD_LINKAGE FFMPEG_COMMIT <<< "$recipe_fields"
[[ "$BUILD_TARGET" == arm64-apple-darwin ]] || { echo "Unsupported FFmpeg build target: $BUILD_TARGET" >&2; exit 1; }
[[ "$MINIMUM_MACOS" == 15.0 ]] || { echo "Unsupported minimum macOS version: $MINIMUM_MACOS" >&2; exit 1; }
[[ "$BUILD_LINKAGE" == static-third-party ]] || { echo "Unsupported FFmpeg linkage: $BUILD_LINKAGE" >&2; exit 1; }
FFMPEG_SHORT_COMMIT="${FFMPEG_COMMIT[1,10]}"

typeset -a SOURCE_NAMES
typeset -A SOURCE_VERSION SOURCE_LICENSE SOURCE_FILE SOURCE_URL SOURCE_SHA256 SOURCE_DIR
while IFS=$'\t' read -r name version license file url sha256; do
  [[ "$name" =~ '^[a-z0-9-]+$' ]] || { echo "Invalid FFmpeg source input name: $name" >&2; exit 1; }
  [[ -z "${SOURCE_FILE[$name]:-}" ]] || { echo "Duplicate FFmpeg source input: $name" >&2; exit 1; }
  SOURCE_NAMES+=("$name")
  SOURCE_VERSION[$name]="$version"
  SOURCE_LICENSE[$name]="$license"
  SOURCE_FILE[$name]="$file"
  SOURCE_URL[$name]="$url"
  SOURCE_SHA256[$name]="$sha256"
done < <(node - "$MANIFEST" <<'NODE'
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ffmpeg = manifest.components.find((component) => component.name === 'ffmpeg');
const inputs = ffmpeg?.sourceBuilds?.['darwin-arm64']?.inputs;
if (!Array.isArray(inputs) || inputs.length === 0)
  throw new Error('runtime manifest has no darwin-arm64 FFmpeg source inputs');
for (const input of inputs) {
  const values = ['name', 'version', 'license', 'file', 'url', 'sha256'].map((field) => input[field]);
  if (values.some((value) => typeof value !== 'string' || !value || /[\t\r\n]/.test(value)))
    throw new Error(`invalid FFmpeg source input: ${input.name ?? 'unknown'}`);
  process.stdout.write(`${values.join('\t')}\n`);
}
NODE
)

for required in ffmpeg x264 libass freetype fribidi harfbuzz libunibreak zimg; do
  [[ -n "${SOURCE_FILE[$required]:-}" ]] || { echo "Missing FFmpeg source input: $required" >&2; exit 1; }
done
[[ "${#SOURCE_NAMES[@]}" -eq 8 ]] || { echo 'Unexpected FFmpeg source input set' >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vrrelay-ffmpeg.XXXXXX")"
cleanup() {
  if [[ "${VRRELAY_KEEP_FFMPEG_BUILD:-0}" == 1 ]]; then
    echo "Retained FFmpeg build workspace: $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT INT TERM

DOWNLOADS="$WORK/downloads"
EXTRACTED="$WORK/extracted"
PREFIX="$WORK/prefix"
BUILD="$WORK/build"
mkdir -p "$DOWNLOADS" "$EXTRACTED" "$PREFIX" "$BUILD" "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR/ffmpeg" "$OUTPUT_DIR/ffmpeg-build-metadata.json" \
  "$OUTPUT_DIR/vrrelay-ffmpeg-${SOURCE_VERSION[ffmpeg]}-darwin-arm64-source.tar.xz"
rm -rf "$OUTPUT_DIR/licenses"

for name in "${SOURCE_NAMES[@]}"; do
  archive="$DOWNLOADS/${SOURCE_FILE[$name]}"
  if [[ -n "$SOURCE_ARCHIVE_DIR" ]]; then
    [[ -f "$SOURCE_ARCHIVE_DIR/${SOURCE_FILE[$name]}" ]] || {
      echo "Pinned FFmpeg source archive not found: $SOURCE_ARCHIVE_DIR/${SOURCE_FILE[$name]}" >&2
      exit 1
    }
    cp "$SOURCE_ARCHIVE_DIR/${SOURCE_FILE[$name]}" "$archive"
  else
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
      "${SOURCE_URL[$name]}" --output "$archive"
  fi
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  [[ "$actual" == "${SOURCE_SHA256[$name]}" ]] || {
    echo "SHA-256 mismatch for ${SOURCE_FILE[$name]}: $actual" >&2
    exit 1
  }
  destination="$EXTRACTED/$name"
  mkdir -p "$destination"
  tar -xf "$archive" -C "$destination"
  directories=("$destination"/*(/N))
  [[ "${#directories[@]}" -eq 1 ]] || {
    echo "Expected one source directory in ${SOURCE_FILE[$name]}" >&2
    exit 1
  }
  SOURCE_DIR[$name]="${directories[1]}"
done

FFMPEG_DEMUX_SOURCE="${SOURCE_DIR[ffmpeg]}/fftools/ffmpeg_demux.c"
grep -Fq 'DemuxStream *slowest = NULL;' "$FFMPEG_DEMUX_SOURCE" &&
  grep -Fq 'int64_t progress = INT64_MAX;' "$FFMPEG_DEMUX_SOURCE" &&
  grep -Fq 'd->resume_progress = progress;' "$FFMPEG_DEMUX_SOURCE" &&
  grep -Fq 'av_usleep(progress - limit);' "$FFMPEG_DEMUX_SOURCE" || {
  echo "Pinned FFmpeg revision $FFMPEG_COMMIT lacks the shared read-rate fix" >&2
  exit 1
}

SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
CC="$(xcrun --find clang)"
CXX="$(xcrun --find clang++)"
AR="$(xcrun --find ar)"
RANLIB="$(xcrun --find ranlib)"
STRIP="$(xcrun --find strip)"
export SDKROOT CC CXX AR RANLIB STRIP
export MACOSX_DEPLOYMENT_TARGET="$MINIMUM_MACOS"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=$MINIMUM_MACOS -isysroot $SDKROOT -I$PREFIX/include"
export CXXFLAGS="$CFLAGS"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-arch arm64 -mmacosx-version-min=$MINIMUM_MACOS -isysroot $SDKROOT -L$PREFIX/lib"
JOBS="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 2)"
[[ "$JOBS" =~ '^[1-9][0-9]*$' ]] || JOBS=2

(
  cd "${SOURCE_DIR[freetype]}"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --with-zlib=no --with-bzip2=no --with-png=no --with-harfbuzz=no --with-brotli=no
  make -j"$JOBS"
  make install
)

meson setup "$BUILD/harfbuzz" "${SOURCE_DIR[harfbuzz]}" \
  --prefix="$PREFIX" --libdir=lib --buildtype=release --default-library=static \
  -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled \
  -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
  -Dpng=disabled -Dzlib=disabled -Dicu=disabled -Dgraphite2=disabled \
  -Dfreetype=enabled -Dcoretext=disabled -Dfontations=disabled \
  -Dharfrust=disabled -Dkbts=disabled -Dwasm=disabled \
  -Draster=disabled -Dvector=disabled -Dgpu=disabled -Dgpu_demo=disabled \
  -Dsubset=disabled -Dbenchmark=disabled
meson compile -C "$BUILD/harfbuzz" -j "$JOBS"
meson install -C "$BUILD/harfbuzz"

(
  cd "${SOURCE_DIR[fribidi]}"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-debug --disable-dependency-tracking --disable-silent-rules
  make -j"$JOBS"
  make install
)

(
  cd "${SOURCE_DIR[libunibreak]}"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-silent-rules
  make -j"$JOBS"
  make install
)

(
  cd "${SOURCE_DIR[libass]}"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-fontconfig \
    --disable-test --disable-profile
  make -j"$JOBS"
  make install
)

(
  cd "${SOURCE_DIR[zimg]}"
  "$LIBTOOLIZE" --copy --force
  autoreconf --force --install --verbose
  ./configure --prefix="$PREFIX" --disable-shared --enable-static
  make -j"$JOBS"
  make install
)

(
  cd "${SOURCE_DIR[x264]}"
  ./configure --prefix="$PREFIX" --host=aarch64-apple-darwin --enable-static --enable-pic \
    --disable-cli --disable-opencl --disable-lsmash --disable-swscale --disable-ffms
  make -j"$JOBS"
  make install
)

typeset -a FFMPEG_CONFIGURE_ARGS
FFMPEG_CONFIGURE_ARGS=(
  "--prefix=$PREFIX"
  --arch=arm64
  --target-os=darwin
  --cc="$CC"
  --cxx="$CXX"
  --enable-static
  --disable-shared
  --disable-autodetect
  --enable-gpl
  --enable-version3
  --enable-libx264
  --enable-libass
  --enable-libzimg
  --enable-videotoolbox
  --enable-audiotoolbox
  --enable-iconv
  --enable-zlib
  --disable-indevs
  --enable-indev=lavfi
  --disable-outdevs
  --disable-ffplay
  --disable-ffprobe
  --disable-doc
  --disable-debug
  "--extra-version=22-g$FFMPEG_SHORT_COMMIT"
  --pkg-config-flags=--static
  "--extra-cflags=$CFLAGS"
  "--extra-cxxflags=$CXXFLAGS"
  "--extra-ldflags=$LDFLAGS"
  --extra-libs=-lc++
)

(
  cd "${SOURCE_DIR[ffmpeg]}"
  ./configure "${FFMPEG_CONFIGURE_ARGS[@]}"
  make -j"$JOBS"
  make install
)

cp "$PREFIX/bin/ffmpeg" "$OUTPUT_DIR/ffmpeg"
chmod 0755 "$OUTPUT_DIR/ffmpeg"
[[ "$(lipo -archs "$OUTPUT_DIR/ffmpeg")" == arm64 ]] || {
  echo 'Built FFmpeg is not a thin arm64 executable' >&2
  exit 1
}

loads="$(otool -L "$OUTPUT_DIR/ffmpeg" | tail -n +2 | awk '{print $1}')"
if print -r -- "$loads" | grep -Ev '^(/System/Library/|/usr/lib/)' >/dev/null; then
  echo 'Built FFmpeg contains a non-system dynamic dependency' >&2
  otool -L "$OUTPUT_DIR/ffmpeg" >&2
  exit 1
fi

"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -version > "$WORK/ffmpeg-version.txt"
"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -encoders > "$WORK/ffmpeg-encoders.txt" 2>/dev/null
"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -filters > "$WORK/ffmpeg-filters.txt" 2>/dev/null
"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -muxers > "$WORK/ffmpeg-muxers.txt" 2>/dev/null
"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -protocols > "$WORK/ffmpeg-protocols.txt" 2>/dev/null
grep -Fq "ffmpeg version ${SOURCE_VERSION[ffmpeg]}-22-g$FFMPEG_SHORT_COMMIT" \
  "$WORK/ffmpeg-version.txt"
grep -Fq -- '--enable-gpl' "$WORK/ffmpeg-version.txt"
grep -Fq -- '--enable-version3' "$WORK/ffmpeg-version.txt"
if grep -Fq -- '--enable-nonfree' "$WORK/ffmpeg-version.txt"; then
  echo 'The macOS FFmpeg build unexpectedly enables nonfree components' >&2
  exit 1
fi

check_manifest_capabilities() {
  local manifest_key="$1" output_file="$2" value
  while IFS= read -r value; do
    [[ -n "$value" ]] || continue
    grep -Eq "(^|[[:space:]])${value}([[:space:]]|$)" "$output_file" || {
      echo "Built FFmpeg is missing $manifest_key capability: $value" >&2
      exit 1
    }
  done < <(node - "$MANIFEST" "$manifest_key" <<'NODE'
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ffmpeg = manifest.components.find((component) => component.name === 'ffmpeg');
const recipe = ffmpeg?.sourceBuilds?.['darwin-arm64'];
for (const value of recipe?.[process.argv[3]] ?? []) console.log(value);
NODE
)
}
check_manifest_capabilities requiredEncoders "$WORK/ffmpeg-encoders.txt"
check_manifest_capabilities requiredFilters "$WORK/ffmpeg-filters.txt"
check_manifest_capabilities requiredMuxers "$WORK/ffmpeg-muxers.txt"
check_manifest_capabilities requiredProtocols "$WORK/ffmpeg-protocols.txt"

"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=320x180:rate=24 \
  -f lavfi -i sine=frequency=880:sample_rate=48000 -t 1 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -ac 2 -b:a 96k -f mpegts "$WORK/smoke.ts"
"$OUTPUT_DIR/ffmpeg" -nostdin -hide_banner -loglevel error -i "$WORK/smoke.ts" -f null -

LICENSE_DIR="$OUTPUT_DIR/licenses"
mkdir -p "$LICENSE_DIR"
copy_license() {
  local name="$1" output="$2"
  shift 2
  local candidate
  for candidate in "$@"; do
    if [[ -f "${SOURCE_DIR[$name]}/$candidate" ]]; then
      cp "${SOURCE_DIR[$name]}/$candidate" "$LICENSE_DIR/$output"
      return
    fi
  done
  echo "Unable to locate license material for $name" >&2
  exit 1
}
copy_license ffmpeg FFmpeg-GPLv3.txt COPYING.GPLv3
copy_license x264 x264-GPLv2.txt COPYING
copy_license libass libass-ISC.txt COPYING
copy_license freetype FreeType-FTL.txt LICENSE.TXT docs/FTL.TXT
copy_license fribidi FriBidi-LGPL.txt COPYING COPYING.LGPL2.1
copy_license harfbuzz HarfBuzz-MIT.txt COPYING
copy_license libunibreak libunibreak-Zlib.txt LICENCE LICENSE
copy_license zimg zimg-WTFPL.txt COPYING

node - "$MANIFEST" "$OUTPUT_DIR/ffmpeg" "$OUTPUT_DIR/ffmpeg-build-metadata.json" \
  "$SDKROOT" "$CC" "${FFMPEG_CONFIGURE_ARGS[@]}" <<'NODE'
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const [manifestPath, ffmpegPath, outputPath, sdkRoot, compiler, ...configureArgs] = process.argv.slice(2);
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const ffmpeg = manifest.components.find((component) => component.name === 'ffmpeg');
const recipe = ffmpeg.sourceBuilds['darwin-arm64'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const commandVersion = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8' }).trim().split(/\r?\n/, 1)[0];
const metadata = {
  schemaVersion: 1,
  target: recipe.target,
  minimumMacOS: recipe.minimumMacOS,
  linkage: recipe.linkage,
  manifestSha256: sha256(manifestBytes),
  inputs: recipe.inputs,
  configureArgs,
  toolchain: {
    sdkRoot,
    xcode: commandVersion('xcodebuild', ['-version']),
    clang: commandVersion(compiler, ['--version']),
    meson: commandVersion('meson', ['--version']),
    ninja: commandVersion('ninja', ['--version']),
    pkgConfig: commandVersion('pkg-config', ['--version'])
  },
  output: {
    file: 'ffmpeg',
    sha256: sha256(readFileSync(ffmpegPath)),
    versionOutput: commandVersion(ffmpegPath, ['-hide_banner', '-version'])
  }
};
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
NODE

BUNDLE_ROOT="$WORK/source-bundle/vrrelay-ffmpeg-macos-source"
mkdir -p "$BUNDLE_ROOT/sources" "$BUNDLE_ROOT/recipe" "$BUNDLE_ROOT/build-config" "$BUNDLE_ROOT/licenses"
cp "$DOWNLOADS"/* "$BUNDLE_ROOT/sources/"
cp "$MANIFEST" "$BUNDLE_ROOT/recipe/runtime-manifest.json"
cp "$ROOT/deploy/macos/build-ffmpeg.sh" "$BUNDLE_ROOT/recipe/build-ffmpeg.sh"
cp "$OUTPUT_DIR/ffmpeg-build-metadata.json" "$BUNDLE_ROOT/"
cp "$LICENSE_DIR"/* "$BUNDLE_ROOT/licenses/"
for config in config.h config.asm ffbuild/config.mak; do
  [[ -f "${SOURCE_DIR[ffmpeg]}/$config" ]] || continue
  cp "${SOURCE_DIR[ffmpeg]}/$config" "$BUNDLE_ROOT/build-config/$(basename "$config")"
done
cat > "$BUNDLE_ROOT/REBUILD.md" <<EOF
# Rebuilding the VRRelay macOS FFmpeg runtime

This archive contains every checksum-pinned upstream source input used by the
VRRelay macOS arm64 FFmpeg build. The checked-in recipe is
\`recipe/build-ffmpeg.sh\`; its authoritative metadata is the bundled
\`recipe/runtime-manifest.json\`.

The build requires an Apple Silicon Mac, the macOS SDK, Xcode command-line
tools, Node.js, pkg-config, Meson, Ninja, Autoconf, Automake, and GNU Libtool.
It targets macOS $MINIMUM_MACOS. Extract this archive beside a clean VRRelay
source checkout at the matching release tag and rebuild without network source
downloads with:

\`VRRELAY_RUNTIME_MANIFEST=/absolute/archive/recipe/runtime-manifest.json \\
VRRELAY_FFMPEG_SOURCE_DIR=/absolute/archive/sources \\
/absolute/VRRelay/deploy/macos/build-ffmpeg.sh /absolute/output\`

Code-signing keys are distribution credentials and are not build-source inputs.

The FFmpeg output is GPL-3.0-or-later because the recipe enables GPL/version-3
mode and links x264. FriBidi is a statically linked LGPL component; distributors
must preserve its license and corresponding-source/relinking obligations.
EOF

node - "$BUNDLE_ROOT" <<'NODE'
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const root = process.argv[2];
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry !== 'SHA256SUMS') files.push(path);
  }
}
walk(root);
const lines = files.map((path) => {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return `${digest}  ${relative(root, path)}`;
});
writeFileSync(join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`);
NODE

SOURCE_BUNDLE="$OUTPUT_DIR/vrrelay-ffmpeg-${SOURCE_VERSION[ffmpeg]}-darwin-arm64-source.tar.xz"
tar -cJf "$SOURCE_BUNDLE" -C "$WORK/source-bundle" vrrelay-ffmpeg-macos-source
shasum -a 256 "$OUTPUT_DIR/ffmpeg" "$OUTPUT_DIR/ffmpeg-build-metadata.json" "$SOURCE_BUNDLE"
