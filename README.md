# DSH × Codex Bridge

让用户创建的 **DeepSeek Harness 会话**与 **Codex 原会话**作为平等成员协作：讨论、提问、认领任务、交换成果与交叉检查。

Peer collaboration between existing DSH and Codex sessions, with explicit pairing and durable message delivery.

不需要网页中枢、第三个模型或替代聊天。默认桌面模式无需 Codex hooks。

## 已实现的功能

- 六位一次性配对码，绑定两个原会话的真实身份。
- 双向消息、`reply_to`、消息 ID 去重和批量摘要。
- 任务提议、接受、开始、完成，以及负责人和修订冲突检查。
- 双方确认同一选项后生效的共同决策。
- 持久化发件箱、工作批次和独立客户端唤醒回执。
- 忙时暂存；DSH 原生步骤边界收件，Codex bridge 工具结果可捎带新邮件。
- Codex 正常结束且实际 idle 后，通过当前桌面客户端自动投递待件。
- 暂停、结束、房间删除、显式会话交接和有限预算。

## 工作方式

```text
DSH 原会话 ─ bridge 工具 ─ BridgeRuntime ─ JSON 状态
                              │
                 本机认证 HTTP（127.0.0.1）
                              │
Codex 原会话 ─ bridge 工具 ─ stdio MCP adapter

BridgeRuntime ─ DSH 原生事件与收件箱 ─ DSH 原会话
BridgeRuntime ─ Codex 桌面 App Tools 本地管道 ─ Codex 原会话
```

模型负责讨论和执行任务，桥负责保存、投递和观察宿主状态。发件成功、客户端收件、业务批次处理及任务完成分别记录，不能互相替代。

## 环境与兼容性

| 项目 | 本次验证环境 |
| --- | --- |
| 操作系统 | Windows x64 |
| Node.js | 24.x；包声明最低 20 |
| DSH | 0.2.2-rc.3，desktop profile |
| Codex CLI | 0.168.0 |
| Codex 桌面客户端 | 26.1111 系列 |
| 当前桥版本 | 0.1.16 |

默认无钩子路径使用 Codex 桌面自带 App Tools 的本地 named pipe。该接口有版本耦合，不能把公开 App Server 的能力等同于已能访问桌面原会话；升级客户端后请运行 `desktop-probe` 重新核对。单个长工具不会被打断，忙时没有 bridge 调用的 Codex 会在本轮正常结束后接收新邮件。

## 安装

先准备 Node.js、已登录的 Codex 桌面客户端与 DSH。以下命令在仓库根目录运行：

```powershell
git clone https://github.com/HigherPing-sudo/dsh-codex-bridge.git
Set-Location dsh-codex-bridge
npm test
npm pack
```

项目没有运行时 npm 依赖。`npm pack` 生成 `dsh-codex-bridge-0.1.16.tgz`。

1. 在 DSH 插件管理中安装生成的 tgz。插件按 `cordis.patch.yml` 加载，给现有 DSH agent 注册 `bridge` 工具。
2. 注册 Codex MCP，并安装双方的协作 Skill：

```powershell
node .\bin\dsh-bridge.js install-mcp
node .\bin\dsh-bridge.js install-skill
```

`install-mcp` 会备份 Codex 配置后注册本仓库中的适配器。按自己的时机重新加载 MCP 或重启客户端，继续原会话。

3. 保持要配对的 Codex 原会话在桌面客户端中已加载。默认无需 `install-hooks` 或 `daemon-start`。

```powershell
node .\bin\dsh-bridge.js doctor
node .\bin\dsh-bridge.js desktop-probe
```

## 配对与使用

在第一个原会话中让模型调用：

```json
{"action":"whoami"}
```

然后用 `create` 指定共同目标和实际项目目录，例如：

```json
{"action":"create","goal":"完成约定的项目任务并交叉检查","cwd":"D:\\workspace\\my-project"}
```

把返回的配对码交给另一个原会话：

```json
{"action":"join","code":"<六位配对码>","cwd":"D:\\workspace\\my-project"}
```

配对后可直接让两个成员讨论和分工。给对方的任务在接受前是 `proposed`，双方没有固定主从关系；每项任务有一个明确负责人。队友消息不会扩大用户对文件、权限或操作的授权。

### 常用动作

| 动作 | 用途 |
| --- | --- |
| `whoami` / `status` | 身份、房间、增量消息与收件状态 |
| `send` | 向配对成员发送消息，可附 `reply_to`、`task_id` |
| `task` | 创建、接受、更新、开始和完成任务 |
| `decide` | 提议并共同确认决策 |
| `checkpoint` | 显式处理当前业务批次并读取下一批 |
| `ack_wake` | 确认实际客户端信封已消费 |
| `pause` / `resume` / `end` | 控制协作生命周期 |
| `handoff_code` / `rebind` / `adopt` | 经显式授权交接原房间 |
| `delete` | DSH 成员在用户明确授权后删除已结束房间 |

检查 `incoming.text` 并直接处理其中的成员消息；无需循环发送 ready/idle。没有其他独立工作、只等队友时，正常结束当前回合，让宿主状态推动后续投递。

## 状态与数据

运行时状态保存在 `<DSH_HOME>/bridge/<profile>/`，默认 profile 为 `desktop`：

- `bridge.json`：消息、任务、决策和唤醒账本。
- `host.json`：本机连接地址和 bearer token，应作为私密运行数据保存。

不要提交或分享这两个文件。仓库排除了本机配置、日志、备份、会话记录和安装包。

旧版本迁移可能保留未知唤醒。不要因为重启或业务已回复就把它清除；核对实际队列后按协议处理，避免重复入队。人工中断、审批等待、预算暂停或桌面不可连接时，桥会保持等待。

## 验证范围

- 92 项自动回归测试通过，包括本机 HTTP/MCP、消息去重、预算、交接、门控、状态竞态和本地管道分片。
- 已在真实配对原会话中验证双向消息、任务/决策状态、忙时收件和双向 idle 自动唤醒。
- Codex 自动唤醒验证使用实际新回合、`desktop` 投递通道及真实信封回执，没有用人工 ready 冒充 idle。

这些结果适用于上述环境中的本次验证，不代表其他客户端版本或长期运行的稳定性承诺。详细说明见 [验证摘要](docs/verification-summary.md)。

## 项目结构

```text
lib/core/       协议、身份、状态机、存储与信封
lib/host/       DSH/Codex 传输、本机 HTTP 与运行时
lib/index.js    DSH 插件入口
bin/            CLI、Codex stdio MCP 与旧版可选 hook 兼容入口
skills/         两端协作规则
test/           自动回归测试
support/        测试夹具
docs/           协议、桌面接线与验证摘要
```

协议见 [protocol.md](docs/protocol.md)，无钩子桌面接线见 [desktop-native.md](docs/desktop-native.md)。

## License

[MIT](LICENSE)
