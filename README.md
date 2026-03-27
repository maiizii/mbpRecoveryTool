# recovery-web-v1

MYT 小包恢复工具的首个正式完成版。

当前仓库的定位很明确：

> 不是重新研究恢复原理，
> 而是把已经验证有效的恢复 SOP 固化成一个可执行、可观察、可复盘的 Web 工具。

---

## 当前版本

**状态：正在进行通用部署改造**

当前版本正在从一个本地化部署工具向更通用的、基于 Docker 的部署方式演进。

### 主要改造目标:

-   **便捷部署**: 通过 Docker 和 Docker Compose 实现“接近一键部署”到任何 Linux x86_64 服务器。
-   **配置外化**: 将配置（包括敏感信息如 SSH 私钥）从代码中分离，通过环境变量和挂载卷管理。
-   **Web UI 配置**: 新增 Web UI 界面，用于配置通用参数、SSH 连接和上传私钥。
-   **明确的运行时目录**: 明确定义配置、数据、日志和私钥的持久化目录。

---

## 部署 (Docker & Docker Compose)

本项目推荐使用 Docker 和 Docker Compose 进行部署。这将确保环境一致性，并简化依赖管理。

### 1. 准备环境

确保您的 Linux x86_64 服务器已安装 Docker 和 Docker Compose。

### 2. 克隆仓库

```bash
git clone https://github.com/yourorg/myt-recovery-tool.git
cd myt-recovery-tool
```
<small>（请将 `yourorg/myt-recovery-tool` 替换为实际仓库地址）</small>

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 文件，并根据需要修改。通常，核心路径（`CONFIG_PATH`, `DATA_DIR`, `JOBS_DIR`, `UPLOADS_DIR`, `SECRETS_DIR`）无需修改，它们会指向 Docker 容器内部的 `/app/data` 目录。

```bash
cp .env.example .env
# nano .env # 编辑 .env 文件
```

您可以通过 `.env` 文件设置一些默认值，例如 SSH 连接信息。但更推荐通过 Web UI 进行配置，配置项会持久化到 `./data/config.json`。

### 4. 启动服务

使用 Docker Compose 启动服务：

```bash
docker compose up -d
```

服务将会在 `http://localhost:23321` (或您在 `.env` 中配置的 `PORT`) 启动。

### 5. 访问 Web UI

在浏览器中访问 `http://<您的服务器IP>:23321`。

-   **通用设置**: 配置 `boxBase`, `sdkDir`, `boxWorkRoot`, `proxyMappingFile` 和 `baselineOptions`。
-   **SSH 连接**: 添加和管理 SSH 连接配置 (Host, Port, User, Name)。
-   **SSH 私钥**: 通过 Web UI 上传或粘贴私钥内容，私钥会被安全地存储在挂载卷中，权限 `0600`。

所有配置将持久化到您主机上的 `./data` 目录中。

---

## 开发与调试

如果您需要进行本地开发或调试，可以直接运行 Node.js 服务。

### 1. 安装依赖

```bash
npm install
```

### 2. 启动 GUI

```bash
npm run gui
```

默认从 `23321` 起监听，端口冲突自动顺延。

### 3. 常用 CLI 命令

```bash
npm run list
npm run slots
npm run slot-status
npm run recover-dryrun
npm run recover-run
```

---

## 目录结构

```text
.
├── Dockerfile                  # Docker 构建文件
├── docker-compose.yml          # Docker Compose 编排文件
├── .env.example                # 环境变量配置示例
├── data/                       # [挂载卷] 运行时数据，包括 config.json, jobs/, uploads/, secrets/
├── src/
│   ├── index.js                # recover 主编排 (CLI 入口)
│   ├── gui-server.js           # Web 服务 / API / job 管理
│   └── config-store.js         # 配置持久化与管理逻辑
├── web/
│   ├── index.html              # 前端页面
│   └── app.js                  # 前端逻辑
├── scripts/
│   └── smoke.sh                # 自检脚本
└── docs/
    └── ...                     # 正式文档
```

---

## 注意事项

-   **安全性**: `data/secrets/ssh/` 目录存放 SSH 私钥，请确保其安全。私钥不会提交到 Git 仓库，也不会打包进 Docker 镜像。
-   **配置优先级**: 环境变量 (如 `.env` 文件) > Web UI 持久化配置 (`./data/config.json`)。Web UI 配置是运行时主要管理方式。
-   **`config.json`**: 不再直接在仓库根目录维护 `config.json`，而是由 Web UI 生成和管理 `./data/config.json`。
-   `package.json` 中的 `scripts` 仍然用于本地开发与 CLI 调试。

---

## 当前版本边界

`v1.0.0` 的含义是：

-   工具层恢复链路已经收口
-   可以作为稳定基线打 tag、回滚、继续迭代

但它**不等于**：

-   TikTok 业务层表现已经完全无问题
-   所有环境都必然零调整可用
-   后续不再需要继续验证

业务层仍应继续验证：

-   登录态
-   页面行为
-   连播稳定性
-   重启后保持情况

---

## 仓库原则

仓库中保留：

-   代码
-   配置模板 (`config.example.json`)
-   正式文档
-   可复现脚本
-   Docker 部署相关文件

本地保留 (`./data` 目录)：

-   `config.json` (由 Web UI 管理)
-   代理映射表 (通过 Web UI 上传或管理)
-   SSH 密钥 (通过 Web UI 管理)
-   临时拆包目录
-   运行日志

---

## 发布建议

正式发布时建议：

1.  更新版本号
2.  写清 release notes
3.  保留完整流程文档
4.  打 Git tag
5.  推送 GitHub

当前推荐 tag：

```text
v1.0.0
```
