# RELEASE NOTES — v1.0.2

发布日期：2026-03-26

## 定位

`v1.0.2` 是在 `v1.0.1` 基础上收敛出的 **第一版正式稳定版**，用于固化 23321 已实机跑通、已恢复成功的版本。

这条发布线的目标是：

- 保持 `v1.0.1` 的整体使用方式不变
- 修复恢复链路里的关键阻断问题
- 把运行所需脚本/清单正式收进仓库
- 与进行中的新版本分支隔离，避免相互污染

## 本版确认纳入的修复

### 1. detect-user / 用户检索链路修复

- 补入 `readDetectData()` 及相关解析逻辑
- 允许从本地解包结果读取 `cfg.json`、`baseCfg.json`、`location.json`、`device_info.json`、`pif.json`、`telephone.json`、`gsms.json`
- 增加对 `aweme_user.xml` 与 `account_setting.blk` 的用户信息提取

### 2. 配置读取路径修复

- `gui-server.js` 支持优先读取 `CONFIG_PATH`
- 解决服务误读项目根 `config.json`、导致 `baselineIdentity` 丢失的问题

### 3. baseline 覆盖安全修复

- 恢复前不再只在 `status=running` 时停机
- 即使预检状态是 `unknown`，也会先发停机请求
- 新增停机确认：未确认停稳，禁止继续覆盖 `userdata.img`
- 增强 baseline 覆盖失败日志，输出 `code/stdout/stderr/detail`

### 4. SSH 噪声过滤

- 过滤 `Permanently added ... to the list of known hosts` 这类已知无害提示
- 避免把 benign warning 误判成失败原因

### 5. MBP 准备逻辑修复

- 当源路径与目标路径相同时，跳过重复复制
- 避免把盒子工作目录中的临时缓存路径误当成源 MBP
- 在失败时输出更完整的错误细节

### 6. 运行依赖正式入库

本版将下列依赖正式纳入仓库：

- `scripts/recover/slot1_targeted_cleanup.sh`
- `scripts/recover/slot1_inject_user_layer.sh`
- `scripts/recover/slot1_precise_postinject_scan.sh`
- `data/checklists/old-identity-checklist-v1.tsv`

目的：避免 clean deploy 时再依赖手工往 `tmp/` 补文件。

## 发布原则

- 本版为 **稳定发布线**
- 不替代、不覆盖进行中的新版本开发分支
- 新功能继续在独立分支推进；23321 稳定线只做受控修复

## 建议标记

- 分支：`release/v1.0.2-23321`
- 标签：`v1.0.2`

