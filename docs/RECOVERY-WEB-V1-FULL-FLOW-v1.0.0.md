# recovery-web-v1 全流程文档

> 正式版本：`v1.0.0`
> 
> 项目名：`recovery-web-v1`
> 
> 定位：把已经验证有效的 MYT 小包恢复 SOP 产品化为一个可执行、可观察、可复盘的 Web 工具。

---

## 1. 文档目的

这份文档只描述**当前已经收口、可作为首个完成版交付**的方案。

目标不是讲历史分歧，而是回答这几个问题：

1. 这个版本现在到底能做什么
2. 整体架构怎么分层
3. 正式恢复流程按什么顺序执行
4. 每一步依赖什么、产出什么、怎么验收
5. 已知限制在哪里
6. 运维和发布时应注意什么

---

## 2. 当前版本结论

当前版本已经完成以下关键闭环：

- `detect-user` 可用
- `recover-run` 全流程可执行
- baseline 覆盖可用
- 机参层注入已改为**批量覆盖**，速度明显提升
- 旧身份清理与精确复扫已接通
- 用户层注入已改为**盒子侧工作目录 + 分目录注入**
- VPC 绑定可执行
- S5 映射、写入、回读可执行
- Web 前端可发起任务、查看状态、轮询日志、停止任务
- 整轮恢复已实测收口到**约 5 分钟内完成**（以当前已验证环境为准）

这意味着：

> `recovery-web-v1 v1.0.0` 可以作为当前第一版“完成版”固化、打标、回滚和继续迭代的稳定基线。

---

## 3. 架构说明

整体采用三层结构：

### 3.1 Web 前端

职责：

- 填写恢复参数
- 发起 detect-user / dry-run / start / stop
- 展示 job 状态
- 展示阶段进度
- 展示日志

前端不承担复杂业务逻辑，不直接操作盒子。

### 3.2 GUI Server / Orchestrator

职责：

- 提供 API
- 生成恢复任务 `jobId`
- 维护 `tmp/recover-jobs/*.json` 与 `*.log`
- 拉起 `node src/index.js recover-run`
- 管理任务状态、结束状态、停止逻辑
- 承担 detect-user / precheck / plan / start / latest / log / stop 等接口

这一层是整个工具的**控制中枢**。

### 3.3 MYT Box

职责：

- 保存 MBP
- 保存目标容器与 `userdata.img`
- 提供容器 / VPC 等本地 API
- 提供 SSH 访问能力
- 执行真正的恢复落盘动作

当前版本中，**SSH 是编排层到盒子的关键通道**。

---

## 4. 当前确认的正式恢复顺序

唯一正式顺序：

```text
baseline → 机参层 → 清旧身份 → 用户层注入 → 精确复扫 → VPC → S5 → 启动与验证
```

不建议擅自换序。

原因：

- baseline 先把底盘统一
- 机参层要先落到目标环境
- 清旧身份必须先于新用户层注入
- 用户层注入后再做严格复扫才有最终意义
- 网络层必须补齐 VPC + S5
- 最后再做容器运行态与业务态验证

---

## 5. 目录与数据约定

### 5.1 仓库关键目录

```text
src/
  index.js         恢复主编排
  gui-server.js    Web 服务 / API / job 管理
web/
  index.html       前端页面
  app.js           前端逻辑
scripts/
  smoke.sh         简单自检脚本
release/
  ...              发布辅助目录
docs/
  ...              正式文档
tmp/
  ...              本地临时目录（不提交）
```

### 5.2 盒子侧工作目录

默认：

```text
/mmc/myt_recover_work
```

按用户 UID 建工作空间，例如：

```text
/mmc/myt_recover_work/<userId>/
├── <userId>.mbp
└── extract/
    ├── dev/.cfg-*/
    └── data/data/com.zhiliaoapp.musically/
```

### 5.3 MBP 中的两类核心内容

#### 机参层

来源：

```text
dev/.cfg-*/
```

#### 用户层

来源：

```text
data/data/com.zhiliaoapp.musically/
```

---

## 6. detect-user 流程

当前 detect-user 的思路已经从“全部拉回本机后再处理”收敛为：

### 正式做法

1. 按 UID 确定 MBP 来源
2. 在盒子侧准备专用工作目录
3. 将 MBP 复制到工作目录
4. 在盒子侧直接解包
5. 从解包结果中提取关键文件到本地临时目录
6. 解析基础字段供前端展示与后续 recover 使用

### 已验证提取内容

包括但不限于：

- `sourceMbp`
- `username`
- `nickname`
- `proxyIp`
- 机参层相关关键文件
- `shared_prefs`
- `account_setting.blk`
- Cookie / 用户侧线索

### 当前价值

- detect-user 不再只是“查到 MBP 路径”
- 它已经是 recover 的**前置数据准备步骤**

---

## 7. recover-run 正式流程说明

以下描述按当前版本的有效口径整理。

### 7.1 baseline 覆盖

目标：

- 让目标容器先回到统一底盘

做法：

- 定位目标容器对应 `userdata.img`
- 对比 baseline 与 target 的 SHA / 状态
- 若一致则跳过复制
- 若不一致则执行覆盖

说明：

- 这是整轮恢复最重的 I/O 步骤之一
- 慢主要是大镜像替换，不是逻辑问题

---

### 7.2 机参层注入

当前正式版已经从“逐文件多次 ssh/cp/sync”改为：

### 新做法

- 在盒子侧找到 `dev/.cfg-*`
- 仅枚举其**顶层文件**
- 采用批量 tar 流方式一次性覆盖到：

```text
<targetRoot>/modelData/
```

- `cfg.json` 与 `baseCfg.json` 额外复制到：

```text
<targetRoot>/
```

- 最后只做一次 `sync`
- 再做关键字段回读校验

### 当前回读字段

- `VERIFY_CFG_MODEL`
- `VERIFY_CFG_PATCH`
- `VERIFY_DINFO_MODEL`
- `VERIFY_DINFO_BUILD`
- `VERIFY_PIF_MODEL`
- `VERIFY_PIF_FINGERPRINT`

### 本次收口结论

- 机参正确性已验证通过
- 批量模式速度明显优于逐文件模式
- 当前版本已确认可作为正式做法

---

### 7.3 旧身份清理

目标：

- 清掉目标机位上原 baseline 遗留的旧 UID / old username / old name

当前方案：

- 以 checklist / manifest 为核心约束范围
- 使用目标清理脚本执行替换、重命名、删除等动作
- 清理后做严格复查

注意：

- 清理统计值与最终验收值不应混为一谈
- 阶段中间值不等于最终失败
- 最终是否接受，要看后续用户层注入后的精确复扫结果

---

### 7.4 用户层注入

当前正式做法：

- 使用盒子侧已解包出的 MBP 内容
- 按关键目录分批注入，而不是零碎单文件复制

典型注入目录包括：

- `shared_prefs`
- `files/keva`
- `files/TTMachineCoreCache`
- `files/<userId>`
- `files/ColdBootFilePrefs`
- `databases`

价值：

- 速度更快
- 稳定性更高
- 更接近真实用户层结构

---

### 7.5 精确复扫

目标：

- 对旧身份残留做最终精确验收

重点关注：

- `old_uid`
- `old_username`
- `old_name`

解释：

- 第 4 步看到残留，不代表整轮必败
- 因为第 5 步用户层注入可能覆盖掉剩余残留
- **最终是否通过，以精确复扫为准**

---

### 7.6 VPC 配置

当前做法：

- 将目标容器绑定到既有 VPC 节点
- 调用盒子侧 API 完成绑定
- 回读结果确认

规则：

- VPC 是必须项，不是可选项
- 不能把“网络已通”误当成“VPC 已设好”

---

### 7.7 S5 配置

当前正式规则已经收口：

#### S5 参数来源

不是直接从 MBP 里拿完整账号密码。

而是：

1. 从 MBP / detect-user 结果中得到外部代理 IP
2. 再用代理映射表反查完整 S5 参数：
   - `type`
   - `ip`
   - `port`
   - `usr`
   - `pwd`

#### S5 写入接口

使用容器实例代理接口：

```text
http://<container_ip>:9082/proxy
```

关键命令：

- `cmd=1` 查询
- `cmd=2` 设置
- `cmd=3` 停止
- `cmd=4` 域名例外

#### 当前实现收口点

- 进入 S5 时做实时容器状态发现
- 优先用容器内网地址，不再误用公网 host 地址
- `/proxy` 就绪检查通过 SSH 在盒子侧完成
- 映射表缺失时给出明确错误
- 当前环境下，S5 映射、写入、校验都已跑通

---

### 7.8 启动与验证

目标：

- 启动容器
- 确认基本运行态
- 为业务侧验证做准备

当前结论：

- 工具层恢复流程已能收口
- 业务层仍需继续看 TikTok 登录、功能、连播稳定性等表现

---

## 8. Web API 简表

当前 GUI Server 主要接口包括：

- `POST /api/recover/detect-user`
- `POST /api/recover/precheck`
- `POST /api/recover/plan`
- `POST /api/recover/start`
- `POST /api/recover/stop`
- `POST /api/recover/dryrun`
- `GET /api/recover/job?id=...`
- `GET /api/recover/latest`
- `GET /api/recover/log?id=...`

### 任务模型

- 每轮恢复生成一个 `jobId`
- 状态落在：
  - `tmp/recover-jobs/<jobId>.json`
  - `tmp/recover-jobs/<jobId>.log`
- 前端轮询状态与日志
- 支持停止当前任务

---

## 9. 配置说明

示例配置见：

```text
config.example.json
```

当前关键配置包括：

- `boxBase`
- `recover.boxWorkRoot`
- `recover.slot`
- `recover.targetName`
- `recover.userId`
- `recover.baseline`
- `recover.baselineIdentity`
- `recover.mbp`
- `recover.proxyMappingFile`
- `targets.<containerName>`
- `ssh.enabled/host/port/user/key`

### 配置原则

- `config.json` 只留本地，不提交
- 代理映射表只留本地，不提交
- 真实 SSH / 密钥 / 账号信息不进 Git

---

## 10. 启动与使用

### 10.1 启动 GUI

```bash
npm run gui
```

默认从 `23321` 开始监听，端口冲突时自动顺延。

### 10.2 常用 CLI

```bash
npm run list
npm run slots
npm run slot-status
npm run recover-dryrun
npm run recover-run
```

---

## 11. 当前版本的已知限制

虽然该版本已可作为首个完成版，但仍有明确边界：

### 11.1 业务结果不等于工具结果

工具层恢复跑通，不自动等于：

- TikTok 必然长期稳定
- 连播模式必然无异常
- 所有业务行为都已完全收口

业务侧仍要继续实测。

### 11.2 SSH 仍然是关键依赖

因为官方 RPA / SDK 路径仍存在不稳定性，当前版本仍以 SSH 作为盒子编排的关键通道。

### 11.3 环境兼容性有前提

目标容器与 baseline 需要：

- 同系统代际
- 同类路径结构
- 同类接口能力

否则可能出现恢复后异常。

---

## 12. 当前版本相对早期版本的关键收敛

### 已经完成的关键收敛

1. 从“本地工具思维”转为“Web 控制台 + 编排层 + 盒子执行”
2. detect-user 从临时脚本升级为正式前置步骤
3. 用户层注入从碎片传输收敛为目录级注入
4. S5 从未实现状态补成正式实现
5. 机参层从逐文件慢复制收敛为批量覆盖
6. 日志、job 状态、任务停止都具备基本可用性
7. 当前恢复时长已收敛到约 5 分钟内

---

## 13. 建议验收口径

建议把验收分成三层：

### A. 工具层

- recover-run 成功完成
- 各阶段日志清晰
- 关键字段回读正常
- 无明显卡死/假成功

### B. 数据层

- 旧身份残留达标
- 新用户层到位
- 机参字段正确
- VPC / S5 配置正确

### C. 业务层

- 登录态正常
- 基本页面正常
- 连播或业务目标正常
- 重启后行为稳定

---

## 14. 版本结论

当前正式建议版本：

```text
v1.0.0
```

定义：

> 这是 `recovery-web-v1` 的首个完成版。
> 
> 它不意味着所有业务问题都彻底结束，
> 但意味着“工具层的正式恢复链路已经完成首轮收口，可固化为稳定基线”。

---

## 15. 发布建议

本次发布建议同时包含：

1. 更新 `package.json` 版本号到 `1.0.0`
2. 更新 `README.md`
3. 新增本全流程文档
4. 新增 `RELEASE-NOTES-1.0.0.md`
5. 打 Git tag：`v1.0.0`
6. 推送到 GitHub

---

## 16. 一句话总结

`recovery-web-v1 v1.0.0` 的意义不是“从此天下太平”，而是：

> **MYT 小包恢复这条工具化链路，终于从反复试错阶段，进入了“有正式版本、有完整文档、有可回滚基线”的阶段。**
