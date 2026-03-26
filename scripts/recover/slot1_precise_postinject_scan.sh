#!/bin/sh
set -eu
IMG="$1"
CHECKLIST="$2"
MNT=/mnt/slot1_userdata_ro_precise_scan_$(date +%Y%m%d%H%M%S)
APP_REL=data/com.zhiliaoapp.musically
OLD_UID="$3"
OLD_USERNAME="$4"
OLD_NAME="$5"
NEW_UID="$6"
NEW_USERNAME="$7"
NEW_NAME="$8"

cleanup() {
  umount "$MNT" >/dev/null 2>&1 || true
  rmdir "$MNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

count_literal_in_file() {
  needle="$1"
  file="$2"
  [ -n "$needle" ] || { echo 0; return; }
  [ -f "$file" ] || { echo 0; return; }
  grep -a -o -F -- "$needle" "$file" 2>/dev/null | wc -l | tr -d ' '
}

mkdir -p "$MNT"
mount -o ro,loop "$IMG" "$MNT"
APP="$MNT/$APP_REL"

if [ ! -d "$APP" ]; then
  echo "APP_MISSING $APP"
  exit 21
fi
if [ ! -f "$CHECKLIST" ]; then
  echo "CHECKLIST_MISSING $CHECKLIST"
  exit 22
fi

OLD_UID_COUNT=0
OLD_USERNAME_COUNT=0
OLD_NAME_COUNT=0
NEW_UID_COUNT=0
NEW_USERNAME_COUNT=0
NEW_NAME_COUNT=0

echo '[checklist-counts]'
while IFS='	' read -r kind field relpath; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in \#*) continue ;; esac
  [ -n "${relpath:-}" ] || continue
  f="$APP/$relpath"

  old_uid_hits=$(count_literal_in_file "$OLD_UID" "$f")
  old_username_hits=$(count_literal_in_file "$OLD_USERNAME" "$f")
  old_name_hits=$(count_literal_in_file "$OLD_NAME" "$f")
  new_uid_hits=$(count_literal_in_file "$NEW_UID" "$f")
  new_username_hits=$(count_literal_in_file "$NEW_USERNAME" "$f")
  new_name_hits=$(count_literal_in_file "$NEW_NAME" "$f")

  OLD_UID_COUNT=$((OLD_UID_COUNT + old_uid_hits))
  OLD_USERNAME_COUNT=$((OLD_USERNAME_COUNT + old_username_hits))
  OLD_NAME_COUNT=$((OLD_NAME_COUNT + old_name_hits))
  NEW_UID_COUNT=$((NEW_UID_COUNT + new_uid_hits))
  NEW_USERNAME_COUNT=$((NEW_USERNAME_COUNT + new_username_hits))
  NEW_NAME_COUNT=$((NEW_NAME_COUNT + new_name_hits))

  if [ "$old_uid_hits" -gt 0 ] || [ "$old_username_hits" -gt 0 ] || [ "$old_name_hits" -gt 0 ]; then
    echo "OLD_HIT kind=$kind field=$field path=$f old_uid=$old_uid_hits old_username=$old_username_hits old_name=$old_name_hits new_uid=$new_uid_hits new_username=$new_username_hits new_name=$new_name_hits"
  fi
done < "$CHECKLIST"

echo "old_uid=$OLD_UID_COUNT"
echo "old_username=$OLD_USERNAME_COUNT"
echo "old_name=$OLD_NAME_COUNT"
echo "new_uid=$NEW_UID_COUNT"
echo "new_username=$NEW_USERNAME_COUNT"
echo "new_name=$NEW_NAME_COUNT"

echo '[done]'
