#!/usr/bin/env sh
set -eu

CONFIG="${1:-./config.json}"
TARGET="${MYT_TARGET_NAME:-1774005912899_3_T0003}"
BASELINE="${MYT_BASELINE:-/mmc/restored_user_snapshots_20260320_201119/mytCustom_4_HZEDI9QV_4_1774008080879__uid_4377_upgraded_zeroop/userdata.img}"
MBP="${MYT_MBP:-/mmc/mbp/7515749848698913838.mbp}"
USER_ID="${MYT_USER_ID:-7515749848698913838}"

echo "== smoke:list =="
node src/index.js list --config="$CONFIG" >/tmp/myt-smoke-list.json
sed -n '1,16p' /tmp/myt-smoke-list.json

echo
echo "== smoke:stage-status =="
node src/index.js stage-status --config="$CONFIG" --target-name="$TARGET" >/tmp/myt-smoke-stage.json
sed -n '1,18p' /tmp/myt-smoke-stage.json

echo
echo "== smoke:probe =="
node src/index.js probe --config="$CONFIG" --target-name="$TARGET" >/tmp/myt-smoke-probe.json
sed -n '1,22p' /tmp/myt-smoke-probe.json

echo
echo "== smoke:precheck =="
node src/index.js precheck --config="$CONFIG" --target-name="$TARGET" --baseline="$BASELINE" --mbp="$MBP" --user-id="$USER_ID" >/tmp/myt-smoke-precheck.json
sed -n '1,26p' /tmp/myt-smoke-precheck.json

echo
echo "== smoke:recover(dry-run) =="
node src/index.js recover --config="$CONFIG" --target-name="$TARGET" --baseline="$BASELINE" --mbp="$MBP" --user-id="$USER_ID" >/tmp/myt-smoke-recover.json
sed -n '1,36p' /tmp/myt-smoke-recover.json

echo
echo "smoke test done"
