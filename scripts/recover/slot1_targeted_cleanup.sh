#!/bin/sh
set -eu
IMG="$1"
CHECKLIST="$2"
MNT=/mnt/slot1_userdata_rw_targeted_$(date +%Y%m%d%H%M%S)
APP_REL=data/com.zhiliaoapp.musically
OLD_UID="$3"
NEW_UID="$4"
OLD_USERNAME="$5"
NEW_USERNAME="$6"
OLD_NAME="$7"
NEW_NAME="$8"

TMP_FILES=""
cleanup() {
  sync || true
  for f in $TMP_FILES; do
    rm -f "$f" >/dev/null 2>&1 || true
  done
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

escape_sed_pat() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

escape_sed_repl() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

make_tmp() {
  t="/tmp/cleanup_$(date +%s)_$$_$(basename "$1")"
  TMP_FILES="$TMP_FILES $t"
  printf '%s' "$t"
}

rewrite_file_content() {
  f="$1"
  [ -f "$f" ] || return 0
  uid_hits=$(count_literal_in_file "$OLD_UID" "$f")
  username_hits=$(count_literal_in_file "$OLD_USERNAME" "$f")
  name_hits=$(count_literal_in_file "$OLD_NAME" "$f")
  [ "$uid_hits" -gt 0 ] || [ "$username_hits" -gt 0 ] || [ "$name_hits" -gt 0 ] || return 0

  tmp=$(make_tmp "$f")
  sed \
    -e "s|$(escape_sed_pat "$OLD_UID")|$(escape_sed_repl "$NEW_UID")|g" \
    -e "s|$(escape_sed_pat "$OLD_USERNAME")|$(escape_sed_repl "$NEW_USERNAME")|g" \
    -e "s|$(escape_sed_pat "$OLD_NAME")|$(escape_sed_repl "$NEW_NAME")|g" \
    "$f" > "$tmp"

  if cmp -s "$f" "$tmp"; then
    rm -f "$tmp"
    return 0
  fi

  cat "$tmp" > "$f"
  rm -f "$tmp"
  TOTAL_UID=$((TOTAL_UID + uid_hits))
  TOTAL_USERNAME=$((TOTAL_USERNAME + username_hits))
  TOTAL_NAME=$((TOTAL_NAME + name_hits))
  TOTAL_FILES=$((TOTAL_FILES + 1))
  echo "REWROTE $f uid=$uid_hits username=$username_hits name=$name_hits"
}

rewrite_file_if_textlike() {
  kind="$1"
  f="$2"
  case "$kind" in
    content_hits)
      rewrite_file_content "$f"
      ;;
    *)
      if [ -f "$f" ]; then
        rm -f "$f"
        DELETED_FILES=$((DELETED_FILES + 1))
        echo "DELETED_BINARY $f kind=$kind"
      fi
      ;;
  esac
}

mkdir -p "$MNT"
mount -o loop,rw "$IMG" "$MNT"
APP="$MNT/$APP_REL"

if [ ! -d "$APP" ]; then
  echo "APP_MISSING $APP"
  exit 21
fi
if [ ! -f "$CHECKLIST" ]; then
  echo "CHECKLIST_MISSING $CHECKLIST"
  exit 22
fi

TOTAL_UID=0
TOTAL_USERNAME=0
TOTAL_NAME=0
TOTAL_FILES=0
DELETED_FILES=0
RESIDUAL_UID=0
RESIDUAL_USERNAME=0
RESIDUAL_NAME=0
BEFORE_UID=0
BEFORE_USERNAME=0
BEFORE_NAME=0
TOUCHED="$(make_tmp touched.lst)"

: > "$TOUCHED"

echo '[0] checklist prescan (acceptance baseline)'
while IFS='	' read -r kind field relpath; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in \#*) continue ;; esac
  [ -n "${relpath:-}" ] || continue
  abs="$APP/$relpath"
  before_uid_hits=$(count_literal_in_file "$OLD_UID" "$abs")
  before_username_hits=$(count_literal_in_file "$OLD_USERNAME" "$abs")
  before_name_hits=$(count_literal_in_file "$OLD_NAME" "$abs")
  BEFORE_UID=$((BEFORE_UID + before_uid_hits))
  BEFORE_USERNAME=$((BEFORE_USERNAME + before_username_hits))
  BEFORE_NAME=$((BEFORE_NAME + before_name_hits))
done < "$CHECKLIST"
echo "ACCEPTANCE_BEFORE old_uid=$BEFORE_UID old_username=$BEFORE_USERNAME old_name=$BEFORE_NAME"

echo '[1] checklist-driven cleanup'
while IFS='	' read -r kind field relpath; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in \#*) continue ;; esac
  [ -n "${relpath:-}" ] || continue
  abs="$APP/$relpath"
  printf '%s\n' "$abs" >> "$TOUCHED"
  rewrite_file_if_textlike "$kind" "$abs"
done < "$CHECKLIST"

echo "REWRITE_SUMMARY files=$TOTAL_FILES old_uid=$TOTAL_UID old_username=$TOTAL_USERNAME old_name=$TOTAL_NAME deleted_binary=$DELETED_FILES"

sync

echo '[2] checklist verify (same counting as precise scan)'
while IFS='	' read -r kind field relpath; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in \#*) continue ;; esac
  [ -n "${relpath:-}" ] || continue
  abs="$APP/$relpath"
  old_uid_hits=$(count_literal_in_file "$OLD_UID" "$abs")
  old_username_hits=$(count_literal_in_file "$OLD_USERNAME" "$abs")
  old_name_hits=$(count_literal_in_file "$OLD_NAME" "$abs")

  RESIDUAL_UID=$((RESIDUAL_UID + old_uid_hits))
  RESIDUAL_USERNAME=$((RESIDUAL_USERNAME + old_username_hits))
  RESIDUAL_NAME=$((RESIDUAL_NAME + old_name_hits))

  if [ "$old_uid_hits" -gt 0 ] || [ "$old_username_hits" -gt 0 ] || [ "$old_name_hits" -gt 0 ]; then
    echo "RESIDUAL_HIT kind=$kind field=$field path=$abs old_uid=$old_uid_hits old_username=$old_username_hits old_name=$old_name_hits"
  fi
done < "$CHECKLIST"

echo "RESIDUAL_SUMMARY old_uid=$RESIDUAL_UID old_username=$RESIDUAL_USERNAME old_name=$RESIDUAL_NAME"
echo "ACCEPTANCE_AFTER old_uid=$RESIDUAL_UID old_username=$RESIDUAL_USERNAME old_name=$RESIDUAL_NAME"
if [ "$RESIDUAL_UID" -eq 0 ] && [ "$RESIDUAL_USERNAME" -eq 0 ] && [ "$RESIDUAL_NAME" -eq 0 ]; then
  echo "CLEAN_PASS=1"
else
  echo "CLEAN_PASS=0"
fi

echo '[touched-files-top100]'
sort -u "$TOUCHED" | sed -n '1,100p'

echo '[done]'
