MYT recovery-tool 测试包说明

包名：myt-recovery-tool-test-20260323-173035.zip

当前阶段目标：
- Windows 环境运行
- 输入 userId
- 成功返回用户信息

当前保留字段：
- uid
- username
- nickname
- name
- secUid
- proxyIp
- countryCode
- lineNumber
- imsi
- iccid
- 机型（gmsModel）
- 运营商（carrier）

本阶段不再继续扩抓更多字段。

默认本地服务端口：
- 23321

已实测样本：
- userId: 7515749848698913838

已实测可返回：
- uid: 7515749848698913838
- username: josephdoe473
- nickname: Behind Scenes
- name: Joseph Doe
- secUid: 有
- proxyIp: 104.168.74.3
- countryCode: US
- lineNumber: +16752920900
- imsi: 310410773460657
- iccid: 89014107483054762708
- gmsModel: Pixel 9 Pro XL
- carrier: AT&T Mobility

备注：
- 若本机已有残留 gui-server 进程，先清掉旧进程再启动，避免端口漂移。
- 当前收口目标仅为“UID -> 用户信息读取成功”。
