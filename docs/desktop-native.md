# 无钩子桌面收件

## 接线

DSH 插件托管持久化 BridgeRuntime。Codex 的 MCP 适配器把工具调用转发到本机认证 HTTP；插件通过现有桌面 App Tools 本地管道观察与操作精确配对的原线程，不额外创建网页、线程或模型。

Windows 上自动发现 `codex-app-tools-*` named pipe，只有一个桌面实例报告该精确 thread 已加载为 active/idle 时才选择 owner。未找到、未加载、多个实例匹配或连接失败都不会猜测绑定。

此接口源于已安装 Codex App Tools MCP 的本地协议，并非跨版本稳定的公开 App Server 契约。当前验证的桌面进程使用 stdio App Server，默认 `app-server proxy` 不能直接连接它；不能另起服务冒充管理原会话的服务。公开 API 的背景资料见 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 调度

| 场景 | 行为 |
| --- | --- |
| DSH 运行中 | 原生 pre-step 在已接受步骤中附加新成员邮件 |
| DSH 准备结束 | 有真实新邮件才 steer；无邮件等待正常 idle 后开放下一唤醒 |
| Codex 正在工作 | 保存邮件；bridge 工具结果可附带 incoming |
| Codex 正常结束并 idle | 约每 2 秒观察有待件的原线程，合并投递一次 |
| 人工中断、失败或审批等待 | 保持等待，不自动恢复 |
| 离线或 owner 不明确 | 保留待件，不退回另一写入者重发 |

投递前再次读取真实状态。状态竞态导致尚未提交时恢复 saved；已提交但结果不确定时保留 unknown，不盲目重试。

工作批次、客户端唤醒和任务完成分别记录。pending wake 按真实身份跨房间共用；accepted 不是消费证明。DSH 原生 inbox claimed 或实际客户端信封的 ack_wake 可提供消费回执，不能用业务回复、status 读取或超时替代。

Codex 模型收到实际信封后仍应按 Skill 执行 ack_wake。本次真实验证中，DSH 回执由原生事件先确认，Codex 回执由实际接收信封的模型确认。

## 配置与诊断

默认模式无需 hooks 或额外 CLI daemon：

```powershell
node .\bin\dsh-bridge.js doctor
node .\bin\dsh-bridge.js desktop-probe
node .\bin\dsh-bridge.js desktop-probe <精确线程UUID>
```

`desktop-probe` 只读，不恢复线程、不启动回合、不写房间状态。默认只检查 active/paused 房间中已配对的 thread。

插件配置：`desktopPollMs` 默认 2000，下限 500；可显式指定 `codexDesktopPipe`，但仍需精确匹配 owner。`desktopCodex:false` 仅用于明确选择旧 CLI 模式或隔离测试。

单个长工具/请求不会被抢占。没有 bridge 调用时，Codex 邮件会等本轮正常结束；只等待队友且无独立工作时应结束回合，不要无限轮询。
