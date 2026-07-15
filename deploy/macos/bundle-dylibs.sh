#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

[[ "$#" -eq 2 ]] || { echo "Usage: bundle-dylibs.sh <executable> <library-directory>" >&2; exit 2; }
BINARY="$1"
LIBRARY_DIR="$2"
mkdir -p "$LIBRARY_DIR"
typeset -a queue
typeset -A seen
typeset -A source_by_name
typeset -A origin_by_target
queue=("$BINARY")
origin_by_target[$BINARY]="$BINARY"

resolve_dependency() {
  local dependency="$1" current="$2" candidate suffix rpath
  if [[ "$dependency" == /* ]]; then [[ -f "$dependency" ]] && echo "$dependency"; return; fi
  if [[ "$dependency" == @loader_path/* ]]; then
    candidate="$(dirname "$current")/${dependency#@loader_path/}"
    [[ -f "$candidate" ]] && echo "$candidate"
    return
  fi
  if [[ "$dependency" == @executable_path/* ]]; then
    candidate="$(dirname "$BINARY")/${dependency#@executable_path/}"
    [[ -f "$candidate" ]] && echo "$candidate"
    return
  fi
  if [[ "$dependency" == @rpath/* ]]; then
    suffix="${dependency#@rpath/}"
    while IFS= read -r rpath; do
      rpath="${rpath//@loader_path/$(dirname "$current")}"
      rpath="${rpath//@executable_path/$(dirname "$BINARY")}"
      candidate="$rpath/$suffix"
      [[ -f "$candidate" ]] && { echo "$candidate"; return; }
    done < <(otool -l "$current" | awk '/cmd LC_RPATH/{getline; getline; print $2}')
  fi
}

while (( ${#queue[@]} )); do
  current="${queue[1]}"
  queue=("${queue[@]:1}")
  [[ -n "${seen[$current]:-}" ]] && continue
  seen[$current]=1
  current_origin="${origin_by_target[$current]:-$current}"
  while IFS= read -r dependency; do
    case "$dependency" in
      /System/*|/usr/lib/*) continue ;;
    esac
    source_path="$(resolve_dependency "$dependency" "$current_origin")"
    [[ -n "$source_path" ]] || { echo "Unable to resolve $dependency required by $current" >&2; exit 1; }
    source_real="${source_path:A}"
    [[ "$source_real" == "${current_origin:A}" ]] && continue
    name="$(basename "$dependency")"
    target="$LIBRARY_DIR/$name"
    if [[ -n "${source_by_name[$name]:-}" ]]; then
      previous_source="${source_by_name[$name]}"
      [[ "$(shasum -a 256 "$source_real" | awk '{print $1}')" == "$(shasum -a 256 "$previous_source" | awk '{print $1}')" ]] || {
        echo "Conflicting native libraries named $name" >&2
        exit 1
      }
    else
      source_by_name[$name]="$source_real"
      origin_by_target[$target]="$source_real"
      if [[ "$source_real" != "${target:A}" ]]; then
        cp "$source_real" "$target"
        chmod u+w "$target"
      fi
      queue+=("$target")
    fi
    if [[ "$current" == "$BINARY" ]]; then replacement="@executable_path/../lib/$name"
    else replacement="@loader_path/$name"
    fi
    install_name_tool -change "$dependency" "$replacement" "$current"
  done < <(otool -L "$current" | tail -n +2 | awk '{print $1}')

  # Homebrew's SDL2 compatibility library loads SDL3 with dlopen(), so the
  # dependency is intentionally absent from LC_LOAD_DYLIB and otool -L. FFmpeg
  # does not use SDL for relay work, but the compatibility initializer still
  # requires SDL3 to be present when the process starts.
  if [[ "$(basename "$current")" == "libSDL2-2.0.0.dylib" ]] && strings "$current_origin" | grep -q 'libSDL3\.dylib'; then
    sdl3_source="$(resolve_dependency '@rpath/libSDL3.dylib' "$current_origin")"
    [[ -n "$sdl3_source" ]] || { echo "Unable to resolve the SDL3 runtime dependency required by $current" >&2; exit 1; }
    sdl3_target="$LIBRARY_DIR/libSDL3.dylib"
    if [[ ! -f "$sdl3_target" ]]; then
      cp "${sdl3_source:A}" "$sdl3_target"
      chmod u+w "$sdl3_target"
      source_by_name[libSDL3.dylib]="${sdl3_source:A}"
      origin_by_target[$sdl3_target]="${sdl3_source:A}"
      queue+=("$sdl3_target")
    fi
    while IFS= read -r sdl_rpath; do
      install_name_tool -delete_rpath "$sdl_rpath" "$current"
    done < <(otool -l "$current" | awk '/cmd LC_RPATH/{getline; getline; print $2}')
    install_name_tool -add_rpath '@loader_path' "$current"
  fi
  while IFS= read -r residual_rpath; do
    case "$residual_rpath" in
      /opt/homebrew/*|/usr/local/*) install_name_tool -delete_rpath "$residual_rpath" "$current" ;;
    esac
  done < <(otool -l "$current" | awk '/cmd LC_RPATH/{getline; getline; print $2}')
  [[ "$current" == "$BINARY" ]] || install_name_tool -id "@loader_path/$(basename "$current")" "$current"
done

for binary in "$BINARY" "$LIBRARY_DIR"/*(.N); do
  if otool -L "$binary" | tail -n +2 | awk '{print $1}' | grep -E '^(\/opt\/homebrew|\/usr\/local|@rpath)' >/dev/null; then
    echo "Non-relocatable dependency remains in $binary" >&2
    otool -L "$binary" >&2
    exit 1
  fi
done
