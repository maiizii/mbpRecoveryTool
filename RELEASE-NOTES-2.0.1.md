# Release Notes - v2.0.1 (23321 hotfix)

本版本是 v2.0.0（23321）后的补丁更新，目标是：更快、更稳、更少误报。

## 性能
- **基座覆盖加速**：baseline overwrite 跳过 `sha256` 前后校验，保留文件存在/大小/耗时日志（大幅缩短覆盖时间）。

## 稳定性 / 误报修复
- **S5 写入后回读容错**：写入后等待 1s，并在 5s 内轮询回读，避免代理服务短暂重载导致误判失败。
- **S5 回读匹配规则修复**：兼容回读 `addr` 返回 `socks5://user:pass@host:port` 形式，按 `host:port` 进行比对。
- **S5 映射 IP 来源修复**：优先按当前选中 `userId` 从 `detectedUsers` 取 `proxyIp`，避免沿用上一次残留的 detected.proxyIp。
