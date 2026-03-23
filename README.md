# mbpRecoveryTool

MBP Recovery Tool 是一个面向 **MYT 恢复流程产品化** 的 Web/CLI 工具原型。

当前目标不是重新发明恢复逻辑，而是把已经验证过的 SOP 收敛成一个可重复执行、可视化、可迭代的工程化工具。

## 当前定位

当前仓库已经具备两条主线：

1. **detect-user**：按 UID 自动定位盒子上的 MBP，拉回本地工作目录，完成拆包与基础信息提取
2. **recover**：开始搭建恢复执行骨架，后续会按正式 SOP 逐步落地为可执行阶段流

当前架构方向：

- **Web 前端**：参数输入、状态展示、阶段日志
- **Node GUI Server**：对外 API、页面服务、任务编排入口
- **CLI / Orchestrator**：具体动作编排、盒子 API 调用、SSH/SCP、恢复流程执行
- **MYT Box**：容器、数据目录、盒子本地 API、实际恢复落盘环境

---

## 当前已实现

### 1. detect-user 基本跑通

当前 detect-user 已切为：

**SSH 定位 MBP -> SCP 拉回本地工作目录 -> 本地拆包 -> 本地读取基础数据**

已现场验证可提取如下信息：

- `sourceMbp`
- `workingMbp`
- `extractRoot`
- `username`
- `nickname`
- `model`
- `proxyIp`

后端已支持继续扩展更多字段映射，包括：

- 机参层：`cfg.json` / `baseCfg.json` / `location.json` / `deviceInfo.json` / `gsms.json` / `pif.json` / `telephone.json`
- 用户层：`aweme_user.xml` / `account_setting.blk` / `shared_prefs` / cookie store

### 2. Web GUI 可用

已提供前端页面，可通过 GUI 调用：

- 用户检索（detect-user）
- 恢复 dry-run
- 恢复 start（当前仍以骨架输出为主）

### 3. recover 骨架已接通

当前 `recover-dryrun` / `recover-run` 模式已拆分，后续会继续把 SOP 固化进去：

- 停容器
- baseline 覆盖
- 机参注入
- 旧身份清理
- 用户层注入
- 精确复扫
- VPC 配置
- S5 配置
- 启动与验证

---

## 目录结构

```text
src/
  index.js         CLI / recover orchestration
  gui-server.js    Web server + API + detect-user workflow
web/
  index.html       前端页面
  app.js           前端交互逻辑
  style.css        页面样式
scripts/
  smoke.sh         基础自检脚本
release/
  TEST-PACK-README.txt
sdk/
  ...              SDK/辅助内容
tmp/
  ...              本地工作目录（不提交）
```

---

## 运行要求

### 基础依赖

- Node.js 18+
- Linux/macOS 环境优先（当前开发验证主要在 Linux 上完成）
- 能访问 MYT 盒子 API
- 如使用 detect-user 当前实现，需要具备到盒子的 **SSH/SCP** 能力

### 当前 detect-user 实际依赖

当前 detect-user 走的是：

- 通过 SSH 在盒子上查找 MBP
- 通过 SCP 拉回 `.mbp`
- 在本机拆包并读取数据

所以当前最小可用条件是：

- 盒子 SSH 可达
- 本地具备 ssh/scp 命令
- `config.json` 中 SSH 配置有效

---

## 配置

先复制一份模板：

```bash
cp config.example.json config.json
```

然后按实际环境填写。

### 关键配置项

- `boxBase`：盒子 API 地址
- `recover.boxWorkRoot`：盒子工作目录
- `recover.slot`：目标 slot
- `recover.targetName`：目标容器名
- `recover.userId`：测试用 UID
- `targets.<targetName>`：实例 API / RPA / ADB 映射（按需要补）
- `ssh.enabled/host/port/user/key`：detect-user 当前链路使用

> 注意：`config.json` 含本地环境配置，不建议直接提交。

---

## 启动方式

### 启动 Web GUI

```bash
npm run gui
```

默认从 `23321` 起尝试占用端口；若端口冲突会自动顺延。

### 启动 CLI

```bash
npm run cli -- list --config=./config.json
```

也可以直接调用具体命令：

```bash
npm run list
npm run slots
npm run slot-status
npm run recover-dryrun
npm run recover-run
```

---

## 当前可用命令

`package.json` 中已定义：

- `gui`
- `cli`
- `probe`
- `list`
- `slots`
- `slot-status`
- `slot-switch`
- `stage-status`
- `start`
- `stop`
- `restart`
- `precheck`
- `recover`
- `recover-plan`
- `recover-dryrun`
- `recover-run`
- `smoke`

---

## 当前开发状态

> 当前推荐版本：`v0.2.0-alpha.1`
>
> 说明：这是一个**半成品 alpha 版本**。阶段流已经基本接通，但并不代表所有判定链和网络层步骤都已完全真实闭环。
>
> 详细状态请看：`RELEASE-NOTES-0.2.0-alpha.1.md`

### 已完成

- GUI 服务可启动
- detect-user 链路已切到 **SSH + SCP + 本地拆包**
- `/api/recover/detect-user` 已能读出基础字段
- `/api/recover/dryrun` 与 `/api/recover/start` 已接通
- recover 骨架已开始整理为阶段化执行

### 下一步

- 固定并清理 GUI 端口/旧进程问题
- 完善 detect-user 字段映射与前端展示
- 将 recover 真正落地到 SOP 阶段执行
- 增加更清晰的阶段日志与失败归因
- 收敛配置口径，减少前端冗余输入

---

## 设计原则

这个项目遵循的原则是：

> **Web 工具不是重新定义恢复逻辑，而是把已经验证成功的恢复顺序结构化、参数化、可视化。**

所以它的职责是：

- 收参数
- 调用已经验证过的流程
- 自动化执行
- 记录日志
- 可视化阶段结果
- 输出明确失败点

而不是：

- 重新发明恢复流程
- 强行纯盒子 API 化
- 把所有复杂逻辑都塞进前端

---

## 仓库建议

推荐把真实敏感信息只放在本地：

- `config.json`
- SSH key 路径
- 临时拆包目录
- release 测试包
- 临时日志

仓库中只保留：

- 代码
- 配置模板
- 文档
- 可复现的脚本

---

## 许可证

当前未单独声明许可证，后续可按实际需要补充。
