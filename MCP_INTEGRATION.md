# MCP 集成说明（MCP_INTEGRATION.md）

## 使用的 MCP Server

- **麦当劳 MCP Server**：`https://mcp.mcd.cn`（官方开放平台：https://open.mcd.cn/mcp ）
- **传输方式**：Streamable HTTP，请求体为标准 MCP JSON-RPC 2.0
- **鉴权**：请求头 `Authorization: Bearer <token>`，Token 由使用者本人在开放平台用手机号自助申请（即时激活，无审核）
- **接入方式**：纯前端直连。页面用 `fetch` 发送 JSON-RPC 请求，先 `initialize` 握手（协商协议版本 `2025-03-26`），保存服务端返回的 `Mcp-Session-Id` 会话头，再发 `notifications/initialized`，随后以 `tools/call` 调用各工具。响应同时兼容普通 JSON 与 `text/event-stream`（SSE 分片）两种返回形式。
- **限流**：官方限制每个 Token 600 次/分钟；本应用一次生成仅调用 5 个工具，远低于限额。

## 调用的工具（全部为只读查询）

| 工具 | 用途 | 在卡片上的位置 |
| --- | --- | --- |
| `now-time-info` | 锚定当前日期，避免活动日历与本地时区错位 | 卡片顶部日期 |
| `campaign-calendar` | 当月营销活动日历，筛出进行中活动 | 「今日活动」格：主推活动 + 进行中场次 |
| `available-coupons` | 当前可领取的麦麦省优惠券列表 | 「可领优惠券」格：待领张数 + 首张券名 |
| `query-my-account` | 我的账户积分：可用积分与即将过期积分 | 「我的积分」格：积分余额 + 到期提醒（红色警示） |
| `query-lottery-info` | 积分抽奖活动信息、奖品与参与成本（仅查询） | 「今日抽奖」格：活动名 + 奖品 + 单次成本 |

**刻意不调用的写操作**：`draw-lottery`（抽奖会消耗用户积分）、`auto-bind-coupons`（一键领券属于写操作）。本卡的定位是「情报展示」，只查询、不动用户的任何资产，用户看完卡片后自行去麦当劳 App 操作。

## 请求 / 响应结构

### 请求示例（以 tools/call 为例）

```http
POST https://mcp.mcd.cn
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <redacted>
Mcp-Session-Id: <initialize 后服务端返回的会话 ID>

{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "available-coupons", "arguments": {} }
}
```

本应用调用的 5 个工具均为无参查询，`arguments` 传空对象 `{}`。

### 响应处理

工具结果位于 JSON-RPC `result.content[]` 中 `type: "text"` 的文本块内（部分工具也可能返回 `structuredContent`）。前端处理流程：

1. 优先取 `structuredContent`，否则对 text 做 `JSON.parse`；
2. 归一化（normalization）：不同工具的字段命名不完全一致，前端用候选字段表提取统一模型，例如积分依次尝试 `availablePoints / points / balance`，活动列表依次尝试 `campaigns / list / activities`；
3. 归一化后的统一模型再交给 Canvas 渲染层，真实模式与演示模式共用同一条渲染管线。

### 统一卡片模型

```jsonc
{
  "mode": "live | demo",
  "time":     { "label": "10月22日", "weekday": "星期四", "full": "2026-10-22" },
  "campaign": { "headline": "活动名", "detail": "活动说明", "count": 2 },
  "coupons":  { "count": 3, "topName": "首张券名", "topDesc": "使用条件" },
  "account":  { "points": 1280, "expiring": 120, "expireDate": "2026-10-31" },
  "lottery":  { "name": "抽奖活动名", "topPrize": "头奖奖品", "cost": 50 }
}
```

## 容错策略

- `initialize` 失败（网络不通、Token 无效 401、限流 429）：给出明确中文错误提示，并自动回退到演示模式生成一张卡，不让用户白跑一趟；
- 单个工具失败：其余工具照常查询，失败的那一格显示「暂时取不到」，日志区逐项列出每个工具的成功/失败状态；
- 响应解析同时支持 JSON 与 SSE 两种 Content-Type。

## 演示模式说明

- 无 Token（或点「演示模式」按钮、或访问 `index.html?demo=1`）时启用；
- 样例数据（`demo-data.js`）的结构刻意模拟真实工具返回，喂给**同一套归一化 + 渲染管线**，所以演示卡与真实卡版式完全一致；
- 演示卡右上角有橙色「演示数据」徽标，页脚也注明演示模式，绝不冒充实时数据；
- 演示样例内容：活动 2 场进行中、可领券 3 张、积分 1,280 分（其中 120 分月底过期）、抽奖「积分幸运大转盘」每次 50 积分。

## Token 安全

- Token 只保存在使用者本机浏览器的 `localStorage`，页面直连麦当劳 MCP，不经过任何第三方服务器、没有后端、没有统计上报；
- 仓库内仅提供 `mcp-config.example.json` 占位配置（`${MCD_MCP_TOKEN}` 环境变量占位符），不包含任何真实凭证。
