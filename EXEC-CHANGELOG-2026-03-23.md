# EXEC CHANGELOG - 2026-03-23

## 目的
记录本轮 `recovery-web-v1` 在真实恢复链路中的每次关键调整，避免后续把“临时救火动作”“正式工具方案”“已验证结论”混在一起。

---

## 2026-03-23 23:29 GMT+8
### 用户新增要求
- 每次调整、修改都必须落文本记录。
- 连续执行过程中，不能只口头说明，必须形成书面变更轨迹，避免后续混淆。

### 当前记录规则（从此刻起生效）
1. 每次涉及恢复链路、传输方式、目录结构、脚本路径、正式/临时方案切换，都写入本文件。
2. 明确区分：
   - `正式工具方案`
   - `临时验证动作`
   - `已验证结论`
   - `待固化项`
3. 若后续代码实现与临时动作不一致，以本日志中最新“正式工具方案”定义为准。

---

## 2026-03-23 23:30 GMT+8
### 已验证结论
- 单个 22M 用户层成品包通过 SCP 直传到盒子，稳定性不足，发生过多次中断/卡住。
- 把多个动作（scp、远端解包、清旧、注入、复扫）串成一条长命令，容易因为分段错误导致整条链路失真，不适合作为正式工具方案。
- 盒子端目录 `/mmc/mbp_extract_7612103501766149133_live/data/data/com.zhiliaoapp.musically` 已经能够接收到用户层目录内容，说明“远端落地目录 + 分层注入”方向可行。

### 临时验证动作（不固化进工具）
- 使用 `tar | ssh tar` 的流式推送方式，把本地已解出的用户层目录直接推到盒子端并解包。
- 该方式仅用于验证目录结构/远端落地可行性，不作为正式工具默认实现。

### 正式工具方案（当前生效版本）
恢复工具中的用户层上传与注入，改为以下稳定链路：
1. 本地先解包到固定工作目录：
   - `tmp/recover-jobs/<jobId>/user-layer/`
2. 按目录分批上传，不再走单个大包长传：
   - `shared_prefs`
   - `files`
   - `databases`
   - `app_webview`
3. 每段上传后都要做显式校验：
   - 目录存在
   - 文件数非 0
   - 关键文件存在（至少包括 `aweme_user.xml`、`ttnetCookieStore.xml`、`files/keva/repo/*`）
4. 上传阶段与执行阶段分离：
   - 上传完成后，再进入 `clean old identity -> inject user layer -> precise rescan`
5. 整个流程必须支持失败后从上一步续做，不依赖“一条长命令跑到底”。

### 落地进展（已执行）
- `src/index.js` 已新增正式链路辅助函数：
  - `scpToBox`
  - `resolveLocalUserLayerSource`
  - `buildRecoverJobId`
  - `uploadUserLayerDir`
  - `prepareRemoteUserLayer`
  - `runRemoteScript`
- `runRecover()` 第 5 步 `inject_user_layer` 已从“sleep 占位”改为真实分目录链路：
  1. 本地固定工作目录打包
  2. 四段上传（`shared_prefs/files/databases/app_webview`）
  3. 远端解包
  4. 关键文件校验
  5. 执行远端注入脚本

### 落地进展（继续）
- `runRecover()` 第 4 步 `clean_old_identity` 已改为真实脚本执行：
  - 先同步远端三个恢复脚本
  - 再执行 `/tmp/slot1_targeted_cleanup.sh`
- `runRecover()` 第 6 步 `precise_rescan` 已改为真实脚本执行：
  - 执行 `/tmp/slot1_precise_postinject_scan.sh`
  - 解析 `old_uid/old_username/old_name/new_uid/new_username/new_name`
  - 用真实计数驱动“是否回跳到第 4 步”

### 新确认的执行原则（来自成功手册，已采纳）
- 盒子性能弱，**机参层不要做大动作批量写入**。
- 第 3 步 `inject_device` 必须采用：
  1. **逐个文件覆盖**（`cfg.json` / `baseCfg.json` / `modelData/*.json`）
  2. **每覆盖一个阶段立即校验 hash / 存在性**
  3. 写入和验证日志必须分开记录
- 机参层的目标不是“拷进去就算完”，而是明确恢复：
  - android_id
  - gaid
  - 机型
  - GMS 指纹
  - 时区 / 地区 / IP 描述
  - 电话环境
- 该原则优先级高于“减少命令数”，后续实现以稳定为先。

- `runRecover()` 第 3 步 `inject_device` 已改为真实机参写入：
  - 从本地 `tmp/detect-user/<uid>/extract/dev/.cfg-*` 取源
  - 按 8 个目标文件逐个覆盖
  - 每个文件覆盖后立即回读 `sha256`
- 盒子性能约束已写入执行口径：机参层以“逐个覆盖、逐个校验”为正式方案，不做批量大动作。

### 待固化项
- 将第 7/8/10 步（VPC / S5 / Final Verify）接成真实执行。
- 前端日志面板补充“当前采用的正式链路版本/上传策略”。
- 后续每次若改变目录路径或传输策略，继续追加到本文件。
