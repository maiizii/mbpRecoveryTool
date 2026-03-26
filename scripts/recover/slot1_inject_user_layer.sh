#!/bin/sh
set -eu
IMG="$1"
MNT=/mnt/slot1_userdata_rw_inject_$(date +%Y%m%d%H%M%S)
SRC_BASE="$2"
DST_REL=data/com.zhiliaoapp.musically

cleanup() {
  sync || true
  umount "$MNT" >/dev/null 2>&1 || true
  rmdir "$MNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$MNT"
mount -o loop,rw "$IMG" "$MNT"
DST="$MNT/$DST_REL"

copy_tree() {
  name="$1"
  src="$SRC_BASE/$name"
  dst="$DST/$name"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -a "$src"/. "$dst"/
    echo "COPIED_DIR $name"
  else
    echo "SKIP_MISSING $name"
  fi
}

echo '[1] inject selected user-layer dirs'
copy_tree shared_prefs
copy_tree files
copy_tree databases
copy_tree app_webview

sync

echo '[2] quick listing after inject'
find "$DST" -maxdepth 2 \( -type d -o -type f \) | grep -E '/(shared_prefs|files|databases|app_webview)(/|$)' | sed -n '1,200p' || true

echo '[done]'
