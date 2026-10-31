#!/usr/bin/env bash
# Gather scanimage, the Fujitsu backend and every non-system library they load
# from a Homebrew `sane-backends` install, so the scanner app carries its own
# driver and the collector never installs Homebrew. Writes
# dist/sane-bundle.tar.gz; the app unpacks it on first run (src/sane.ts).
#
# The libraries keep their Homebrew install names: the app runs scanimage with
# DYLD_LIBRARY_PATH on the bundle's lib/, which dyld searches by leaf name
# before the absolute path, so nothing is relinked and every signature holds.
set -euo pipefail
cd "$(dirname "$0")/.."

PREFIX="$(brew --prefix sane-backends)"
ETC="$(brew --prefix)/etc/sane.d"
OUT="dist/sane"
rm -rf "$OUT" dist/sane-bundle.tar.gz
mkdir -p "$OUT/bin" "$OUT/lib/sane" "$OUT/etc"

cp "$PREFIX/bin/scanimage" "$OUT/bin/"
cp "$PREFIX/lib/libsane.1.dylib" "$OUT/lib/"
cp "$PREFIX/lib/sane/libsane-fujitsu.1.so" "$OUT/lib/sane/"
# The dll meta-backend loads only what dll.conf lists.
echo fujitsu > "$OUT/etc/dll.conf"
cp "$ETC/fujitsu.conf" "$OUT/etc/"

# Every Homebrew library reachable from what is in the bundle, transitively.
deps() { otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -E "^$(brew --prefix)/" || true; }
queue=("$OUT/bin/scanimage" "$OUT/lib/libsane.1.dylib" "$OUT/lib/sane/libsane-fujitsu.1.so")
while ((${#queue[@]})); do
  file="${queue[0]}"; queue=("${queue[@]:1}")
  while read -r dep; do
    [ -n "$dep" ] || continue
    leaf="$(basename "$dep")"
    if [ ! -e "$OUT/lib/$leaf" ]; then
      cp "$dep" "$OUT/lib/$leaf"
      chmod u+w "$OUT/lib/$leaf"
      queue+=("$OUT/lib/$leaf")
    fi
  done < <(deps "$file")
done

tar -czf dist/sane-bundle.tar.gz -C "$OUT" .
echo "dist/sane-bundle.tar.gz: $(du -h dist/sane-bundle.tar.gz | cut -f1) ($(ls "$OUT/lib" | wc -l | tr -d ' ') libraries)"
