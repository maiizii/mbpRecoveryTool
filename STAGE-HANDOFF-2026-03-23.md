# MYT Recovery Tool 阶段性交接文档（2026-03-23）

> 目的：让陌生接手人基于本文件，能够**无缝继续开发** MYT Web 版恢复工具，而不需要重新阅读全部聊天记录。
>
> 当前定位：**恢复方案已在交付版中验证成功**，本项目的任务不再是研究恢复原理，而是把现有成功流程包装成一个**本机可操作的 Web 版恢复工具**。

---

## 1. 项目目标（必须先统一）

### 1.1 本项目不是做什么

本项目**不是**：
- 重新发明 MYT 小包恢复流程
- 重新研究哪套恢复链路有效
- 在 GUI 里写一套与交付版不同的新业务逻辑

### 1.2 本项目是做什么

本项目是：
- 基于**已经成功实现的交付版恢复方案**
- 开发一个**在本机运行的 Web 工具**
- 用图形界面驱动既有流程 / 脚本 / 检查步骤
- 让操作者通过页面完成：检测、选机位、预检、计划、执行、复扫、查看结果

一句话：

> **恢复方案已经有了，现在做的是把已验证成功的流程产品化成 Web 操作台。**

---

## 2. 基础资料路径（必须优先看）

这部分是整个项目的“业务真相来源”。**先读这些，再动代码。**

### 2.1 交付版总目录

```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/
```

### 2.2 交付版总手册

```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/MYT-小包恢复总手册-交付版-2026-03-22.md
```

### 2.3 交付版附件脚本目录

```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/附件/
```

### 2.4 附件说明

```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/附件/README-附件说明.md
```

附件说明的原则非常重要：
- **先读总手册，再看脚本**
- 脚本是本次成功链路保留下来的辅助材料
- 执行前必须核对 UID / username / 容器名 / 数据路径 / 挂载目录
- **不建议跳过只读扫描直接做写操作**

### 2.5 完整资料包（补充开发资料来源）

```text
/root/.openclaw/workspace/handoffs/MYT-完整资料包-2026-03-22/
```

用途说明：
- 这是**补充开发资料来源**，里面包含一些开发文档、历史整理材料、MBP 解析说明、脚本与参考资料；
- 当交付版总手册已经给出明确做法时，**优先以交付版为准**；
- 当需要补充理解某个开发细节、历史背景、解析方法或参考脚本时，再回到完整资料包查阅。

---

## 3. 业务流程基线（来自交付版，当前必须遵守）

交付版已经明确：当前唯一有效方案的固定顺序是：

```text
baseline → 机参 → 清旧身份 → 注入新用户层 → 精确复扫 → VPC → S5 → 验证
```

这是当前开发 Web 工具时必须对齐的业务顺序。

### 3.1 不应随意换序

当前 GUI / 后端无论怎么重构，都不应该随意改成例如：
- 先注入用户层再清理
- 先 S5 再 VPC
- 跳过复扫直接判定成功

### 3.2 Web 工具的正确职责

Web 工具不是“定义流程”，而是：
- **把交付版既有顺序结构化、参数化、可视化**
- 用页面收集参数
- 用后端驱动既有成功脚本/命令
- 展示每阶段真实执行结果

---

## 4. 当前代码目录与文件结构

项目当前路径：

```text
/root/.openclaw/workspace/projects/MYT/recovery-tool
```

当前文件结构：

```text
src/gui-server.js
src/index.js
config.example.json
config.json
scripts/smoke.sh
smoke.bat
run.bat
start.bat
package.json
README.md
web/index.html
web/app.js
web/style.css
```

---

## 5. 当前代码架构概览

当前架构是一个**前后端分离但极轻量**的本机 Web 工具：

### 5.1 前端

文件：
- `web/index.html`
- `web/app.js`
- `web/style.css`

职责：
- 显示连接配置
- 显示机位总览 / slot 卡片
- 提供恢复任务表单
- 调用本机后端 API
- 展示摘要结果 + 原始 JSON

### 5.2 后端

文件：
- `src/gui-server.js`

职责：
- 提供本机 HTTP 服务
- 静态托管前端页面
- 调用 CLI（`src/index.js`）
- 管理配置读写（`config.json`）
- 当前已接入部分“检测新用户”逻辑

### 5.3 CLI / 执行层

文件：
- `src/index.js`

职责：
- 与盒子 API 交互
- 提供容器/机位操作命令
- 输出 JSON 供 GUI 解析
- 当前已具备：list / slots / slot-status / slot-switch / start / stop / restart / precheck / recover-plan / recover(dry-run)

---

## 6. 当前 package.json 能力快照

当前 `package.json` 中已定义命令：

- `cli`
- `gui`
- `probe`
- `list`
- `slots`
- `slot-status`
- `slot-switch`
- `stage-status`
- `start`
- `stop`
- `restart`
- `recover-plan`
- `precheck`
- `recover`
- `smoke`

说明：
- **容器/机位层操作能力已基本成型**
- **真正的恢复执行器还没有完成落地**
- 当前 recovery 相关仍主要处于预检 / 计划 / dry-run 状态

---

## 7. 当前 GUI 已实现到什么程度

### 7.1 已完成部分

#### A. 本机 GUI 骨架
已完成：
- `src/gui-server.js`
- `web/index.html`
- `web/app.js`
- `web/style.css`
- `start.bat`

可实现：
- 双击启动本机 Web 页面
- 自动打开浏览器（带自动换端口逻辑）

#### B. 连接配置
GUI 已支持：
- 输入 `boxBase`
- 保存配置到 `config.json`

#### C. 机位总览
GUI 已支持：
- 调用 `/api/slots`
- 显示 slot 卡片
- 展示 running / exited 容器
- 为容器提供 start / stop / restart / slot-switch 按钮

#### D. 危险操作二次确认
GUI 已支持：
- `start`
- `stop`
- `restart`
- `slot-switch`

这些执行前都已有前端确认框。

#### E. 恢复任务表单（初版）
GUI 已支持字段：
- `userId`
- `slot`
- `targetName`
- `baseline`
- `mbp`

并且有这些按钮：
- `检测新用户`
- `保存恢复配置`
- `预检`
- `恢复计划`
- `Dry-Run 恢复`

#### F. 检测新用户（当前为半成品，但已接入真实步骤）
当前 `detect-user` 已经做到了：
- 根据 `userId` 找源 MBP
- 规划盒子工作目录（`/mmc/myt_recover_work/<uid>`）
- 如果本地还没有 extract，则**真实执行** `tar -xzf` 解包到本地
- 读取部分机参 JSON 字段

当前已实际确认能读到的字段包括：
- `proxyIp`
- `model`
- `androidId`

另外，在解包后的 TikTok 用户层中，已人工确认能从 `aweme_user.xml` 里提取到：
- `uid`
- `unique_id`
- `nickname`
- `name`
- `sec_uid`

但这些字段**还没有正式接回 GUI 后端返回值**。

---

## 8. 当前 detect-user 的真实状态（非常重要）

### 8.1 已经不是纯假流程
当前 `src/gui-server.js` 中的 `runDetectUserFlow()` 已接入真实步骤：
- 找源 MBP
- 本地真实解包
- 读取部分 JSON

这意味着检测链路已经从“纯模拟”进入了“部分真实执行”。

### 8.2 但还没有真正完成的部分
当前仍未完成：
- 没有把 `aweme_user.xml` 的关键用户字段正式接回 `detected` 对象
- 还没有执行“拷到盒子 `/mmc` 工作目录”的真实动作
- 还没有执行“盒子侧真实解包”
- 还没有进入真正的恢复阶段执行器

### 8.3 当前 detect-user 的定位
更准确地说，它目前是：

> **真实源包定位 + 本地真实解包 + 部分字段提取器**

而不是完整的新用户准备器。

---

## 9. 当前 CLI 已实现能力（可直接复用）

`src/index.js` 目前已经具备比较稳定的容器/机位层能力。

### 9.1 已验证过的能力
- `list`
- `slots`
- `slot-status`
- `slot-switch --dry-run`
- `start --dry-run`
- `stop --dry-run`
- `restart --dry-run`
- 后续又补上了真实 `postJson()`，因此实际 start/stop/restart/slot-switch 也已能执行

### 9.2 CLI 的主要价值
这些能力意味着：
- GUI 不需要自己直接跟盒子 API 全量对话
- GUI 可以继续复用 CLI 作为“执行中间层”
- 当前恢复工具可以保持：
  - Web 前端 → GUI API → CLI → Box API

这条链路已经是当前项目的基础骨架。

---

## 10. 当前最大开发原则

### 10.1 必须复用交付版，不要重写业务逻辑
今后的核心开发原则应当是：

> **优先把交付版里已成功的流程、脚本、顺序、检查方式接入工具，而不是重写一套新恢复逻辑。**

### 10.2 Web 工具应当像“执行台”，不是“研究台”
它应该负责：
- 参数管理
- 阶段调度
- 真实输出展示
- 失败即停
- 结果留痕

而不应该负责：
- 自己重新定义恢复方法
- 跳开交付版脚本另起炉灶

---

## 11. 已知可复用的交付版脚本

交付版附件中当前已确认有：

- `slot1_inject_user_layer.sh`
- `scan_slot1_tiktok_identity.sh`
- `slot1_precise_postinject_scan.sh`
- `slot1_uid_replace.sh`
- `slot1_targeted_cleanup.sh`
- `slot1_round2_targeted_cleanup.sh`
- `slot5_recover_7515_phaseA.sh`
- `slot5_recover_7515_phaseB.sh`

### 11.1 这些脚本的正确使用方式
正确思路应是：
- 先读交付版总手册，搞清楚每个阶段的业务含义
- 再把脚本能力拆成“工具内部阶段”
- 最后由 Web 后端按统一参数化方式调用

### 11.2 不建议直接照搬的方式
不建议直接：
- 在 GUI 里写死 `slot1` / `slot5`
- 把现有脚本原样裸调用却不做参数抽象
- 把历史成功样本中的 UID/username 直接硬编码到工具核心逻辑里

正确方向是：
- 识别这些脚本的“动作类型”
- 抽象为通用阶段
- 在保留既有成功逻辑的前提下做参数化封装

---

## 12. 当前最需要补的开发工作

按优先级排序如下。

### P0：把交付版脚本和手册先彻底映射到“阶段执行器”
必须先做：
1. 读总手册第 6/7/8/9/12/13 章
2. 对照附件脚本，做一张映射表：
   - 哪个脚本负责什么阶段
   - 输入参数是什么
   - 输出结果怎么看
   - 哪一步是只读，哪一步是写操作

产物建议：
- `docs/recovery-stage-map.md` 或并入下一版 handoff 文档

### P1：把 detect-user 补完整
当前 detect-user 还缺：
- 从 `aweme_user.xml` 正式提取：
  - `unique_id`
  - `nickname`
  - `name`
  - `sec_uid`
- 把这些字段返回到 GUI
- 明确区分：
  - 本地 extract 路径
  - 盒子工作目录路径

### P2：明确恢复执行器的阶段 API
建议 GUI 后端未来按这些阶段建模：
- `stage-baseline`
- `stage-machine`
- `stage-cleanup-round1`
- `stage-cleanup-round2`
- `stage-inject-user`
- `stage-rescan`
- `stage-vpc`
- `stage-s5`
- `stage-verify`

每个阶段都应：
- 只执行真实动作
- 返回真实 stdout/stderr/summary
- 标记 success/failed/blocked

### P3：建立“单任务执行记录”
建议后续增加：
- 每次恢复任务一个 task id
- 保存 task 参数、阶段结果、失败点
- 便于失败恢复和交接追踪

---

## 13. 当前代码中已经踩过的坑（后续别重复踩）

### 13.1 GUI 端口占用
问题：
- `EADDRINUSE`

现状：
- 已加自动换端口逻辑

注意：
- 启动脚本不要假设固定永远是 `3210`

### 13.2 Windows 静态文件路径问题
问题：
- GUI 页面打开后显示 `Not Found`

原因：
- `import.meta.url` / 路径解析在 Windows 场景下出问题

现状：
- `gui-server.js` 已改为更稳的路径解析方式

### 13.3 CLI 输出前面带人类文本，导致 GUI JSON 解析失败
问题：
- JSON 前面如果有普通文本，前端/后端直接 `JSON.parse` 会失败

现状：
- `parseTrailingJson()` 已做兼容，支持从输出尾部抓 JSON

### 13.4 GUI“暂无机位数据”并不一定是盒子没数据
问题：
- 一度 GUI 显示“暂无机位数据”

原因：
- 实际是 JSON 解析方式不对，不是盒子没返回

### 13.5 危险操作必须确认
问题：
- stop/restart/switch 这种操作容易误触

现状：
- 前端已加二次确认

### 13.6 不要再做假阶段/假执行感
这个是本轮开发里很重要的一次纠偏：
- 用户明确要求移除“模拟步骤”
- 现在原则是：**做了什么就报什么，没做就明说没做**

后续所有阶段执行器必须遵守这个原则。

---

## 14. 当前配置约定

`config.example.json` 当前结构大致为：

```json
{
  "boxBase": "http://YOUR_BOX_HOST:22211",
  "sdkDir": "",
  "recover": {
    "boxWorkRoot": "/mmc/myt_recover_work",
    "slot": "1",
    "targetName": "example_container_name",
    "userId": "7515749848698913838",
    "baseline": "/mmc/path/to/fixed-baseline-userdata.img",
    "mbp": "/mmc/myt_recover_work/7515749848698913838/7515749848698913838.working.mbp"
  },
  "targets": {
    "example_container_name": {
      "instanceApi": "http://YOUR_BOX_HOST:23121",
      "rpaHost": "YOUR_BOX_HOST",
      "rpaPort": 23122,
      "adbPort": 23120
    }
  }
}
```

### 14.1 当前配置含义
- `boxBase`：盒子管理 API
- `recover.boxWorkRoot`：盒子侧工作根目录，当前约定 `/mmc/myt_recover_work`
- `recover.slot` / `targetName`：当前恢复目标容器
- `recover.userId`：恢复主变量
- `recover.baseline`：固定基座路径
- `recover.mbp`：工作副本路径（当前仍需进一步收敛）

---

## 15. 当前项目的真实进度判断

### 已完成
- CLI 容器/机位管理能力基本成型
- GUI 基础骨架可运行
- GUI 机位总览可用
- 危险操作可执行并有确认
- recover 表单已搭起来
- detect-user 已进入“部分真实执行”

### 未完成
- detect-user 用户层字段正式回填
- 盒子侧 `/mmc` 工作副本真实准备链路
- 恢复阶段执行器
- 交付版脚本参数化封装
- VPC/S5 阶段接入
- 验证阶段接入
- 任务日志/任务历史

### 当前阶段结论

> 当前项目处于：**GUI 基础设施已搭好，正在从“演示型工具”过渡到“真正能驱动交付版流程的执行台”**。

---

## 16. 下一位接手人建议的第一天工作清单

建议按以下顺序继续，而不是直接开写新功能。

### 第一步：先把交付版手册再精读一遍
必须优先看：
- 总手册第 2、5、6、8、9、12、13 章

### 第二步：把附件脚本做映射表
输出一个清单：
- 脚本名
- 对应阶段
- 是否只读
- 输入依赖
- 输出口径
- 能否参数化

### 第三步：补完 detect-user
优先补：
- `aweme_user.xml` 提取
- 回填到 GUI

### 第四步：设计恢复执行器 API
建议先不做全链路，按阶段一点点接：
1. `stage-baseline`
2. `stage-machine`
3. `stage-cleanup`
4. `stage-inject-user`
5. `stage-rescan`

### 第五步：每接一个阶段都在 GUI 上显示真实输出
要求：
- 不做假进度
- 不做假阶段
- 不把“计划”说成“执行成功”

---

## 17. 给接手人的最后提醒

这个项目最大的坑，不是技术本身，而是**方向偏掉**。

请始终记住：

1. **业务方案已经成功了，答案在交付版，不在聊天灵感里。**
2. **Web 工具的目标是复用成功链路，不是改造成功链路。**
3. **任何阶段都要真实执行、真实汇报，不要营造“已完成”的错觉。**
4. **先把交付版中的脚本和步骤产品化，再考虑体验优化。**

如果你拿到这个项目，不知道下一步做什么，就回到这句话：

> **先把交付版的已成功流程，拆成阶段、参数化、接进 Web 执行台。**

---

## 18. 相关路径汇总（便于复制）

### 交付版总目录
```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/
```

### 交付版总手册
```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/MYT-小包恢复总手册-交付版-2026-03-22.md
```

### 交付版附件目录
```text
/root/.openclaw/workspace/handoffs/MYT-交付版-2026-03-22/附件/
```

### 完整资料包目录（补充开发文档来源）
```text
/root/.openclaw/workspace/handoffs/MYT-完整资料包-2026-03-22/
```

### 当前工具项目目录
```text
/root/.openclaw/workspace/projects/MYT/recovery-tool/
```

### 当前阶段性交接文档（本文件）
```text
/root/.openclaw/workspace/projects/MYT/recovery-tool/STAGE-HANDOFF-2026-03-23.md
```

---

*文档生成时间：2026-03-23（Asia/Shanghai）*
