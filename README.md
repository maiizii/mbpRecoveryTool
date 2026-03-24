# recovery-web-v1

MYT 小包恢复工具的首个正式完成版。

当前仓库的定位很明确：

> 不是重新研究恢复原理，
> 而是把已经验证有效的恢复 SOP 固化成一个可执行、可观察、可复盘的 Web 工具。

---

## 当前版本

**正式版本：`v1.0.0`**

这是当前第一版完成版基线，代表：

- Web GUI 可用
- detect-user 可用
- recover-run 全流程可执行
- baseline / 机参 / 清旧身份 / 用户层 / 精确复扫 / VPC / S5 / 启动验证 已接通
- 机参层已改为批量覆盖，速度显著优化
- 已具备任务状态、日志轮询、手动停止能力

详细说明见：

- `docs/RECOVERY-WEB-V1-FULL-FLOW-v1.0.0.md`
- `RELEASE-NOTES-1.0.0.md`

---

## 目标

本项目要解决的是：

- 用图形界面驱动既有恢复 SOP
- 让操作者能完成 detect-user、预检、执行、观察、复盘
- 把脚本化流程收敛成稳定的产品化工具

本项目**不做**：

- 重新发明 MYT 小包恢复流程
- 在前端堆复杂业务判断
- 为了“纯 API 化”而牺牲可用性

---

## 当前架构

三层结构：

### 1. Web 前端

负责：

- 参数输入
- 发起恢复
- 查看 job 状态
- 查看日志
- 停止任务

### 2. GUI Server / Orchestrator

负责：

- 暴露 API
- 创建 `jobId`
- 落状态文件 / 日志文件
- 启动 `recover-run`
- 编排阶段执行
- 对前端提供统一状态查询

### 3. MYT Box

负责：

- 保存 MBP / 容器 / userdata.img
- 执行实际落盘动作
- 提供容器 / VPC / 实例代理相关能力
- 通过 SSH 接受编排层控制

当前版本里，**SSH 仍然是关键依赖**。

---

## 正式恢复顺序

唯一正式顺序：

```text
baseline → 机参层 → 清旧身份 → 用户层注入 → 精确复扫 → VPC → S5 → 启动与验证
```

不建议随意改顺序。

---

## 当前已经完成的关键能力

### detect-user

- 盒子侧准备 MBP 工作目录
- 盒子侧解包
- 提取关键文件
- 读取基础用户信息和机参线索

### recover-run

- baseline 覆盖
- 机参层批量注入
- 旧身份清理
- 用户层目录级注入
- 精确复扫
- VPC 配置
- S5 写入与回读
- 容器启动与收尾

### GUI 与任务系统

- `/api/recover/detect-user`
- `/api/recover/precheck`
- `/api/recover/plan`
- `/api/recover/start`
- `/api/recover/stop`
- `/api/recover/dryrun`
- `/api/recover/job`
- `/api/recover/latest`
- `/api/recover/log`

每轮恢复都会生成：

- `tmp/recover-jobs/<jobId>.json`
- `tmp/recover-jobs/<jobId>.log`

---

## 目录结构

```text
src/
  index.js         recover 主编排
  gui-server.js    Web 服务 / API / job 管理
web/
  index.html       前端页面
  app.js           前端逻辑
scripts/
  smoke.sh         自检脚本
docs/
  ...              正式文档
release/
  ...              发布辅助目录
tmp/
  ...              本地临时工作目录（不提交）
```

---

## 配置

先复制模板：

```bash
cp config.example.json config.json
```

然后按环境填写。

### 关键配置项

- `boxBase`
- `recover.boxWorkRoot`
- `recover.slot`
- `recover.targetName`
- `recover.userId`
- `recover.baseline`
- `recover.baselineIdentity`
- `recover.mbp`
- `recover.proxyMappingFile`
- `targets.<targetName>`
- `ssh.enabled/host/port/user/key`

注意：

- `config.json` 不提交
- 真实代理映射表不提交
- 密钥 / token / 本地临时文件不提交

---

## 启动

### 启动 GUI

```bash
npm run gui
```

默认从 `23321` 起监听，端口冲突自动顺延。

### 常用命令

```bash
npm run list
npm run slots
npm run slot-status
npm run recover-dryrun
npm run recover-run
```

---

## 当前版本边界

`v1.0.0` 的含义是：

- 工具层恢复链路已经收口
- 可以作为稳定基线打 tag、回滚、继续迭代

但它**不等于**：

- TikTok 业务层表现已经完全无问题
- 所有环境都必然零调整可用
- 后续不再需要继续验证

业务层仍应继续验证：

- 登录态
- 页面行为
- 连播稳定性
- 重启后保持情况

---

## 仓库原则

仓库中保留：

- 代码
- 配置模板
- 正式文档
- 可复现脚本

本地保留：

- `config.json`
- 代理映射表
- SSH 密钥
- 临时拆包目录
- 运行日志

---

## 发布建议

正式发布时建议：

1. 更新版本号
2. 写清 release notes
3. 保留完整流程文档
4. 打 Git tag
5. 推送 GitHub

当前推荐 tag：

```text
v1.0.0
```
