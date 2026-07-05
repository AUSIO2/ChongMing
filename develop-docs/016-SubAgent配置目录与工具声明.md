# SubAgent 配置目录与工具声明

## 背景

原先 `prompts/` 仅存放提示词模板（`description` + `content`），SubAgent 目录信息硬编码在 `electron/api/sub-agent-catalog.ts`，可用工具则硬编码在 `electron/api/agent-config.ts` 的 `AGENT_TOOLS`（按中文 `agentName` 映射）。配置分散、改工具需改代码。

## 目标

1. 将 `prompts/` 重命名为 `subagentconfig/`，作为 SubAgent（及 MainAgent route/merge）配置的唯一根目录。
2. `sub-agent-catalog` 从该目录扫描加载，不再维护硬编码数组。
3. SubAgent 配置文件增加可选 `tools` 字段（工具名字符串数组），运行时经 tool registry 解析为 LangChain tool 实例；删除 `AGENT_TOOLS`。

## 目录结构

```
subagentconfig/
  fact-extractor/
    main-agent-route.json      # prompt-only
    main-agent-merge.json      # prompt-only
    sub-agents/
      data-claims.json         # catalog 元数据 + tools? + content
      quote-claims.json
      causal-claims.json
  fact-verifier/
    main-agent-route.json
    main-agent-merge.json
    sub-agents/
      source-credibility.json
      logic-consistency.json
      data-verifiability.json
```

模块目录映射：

| SubAgentModule | 扫描路径 |
| --- | --- |
| `split` | `fact-extractor/sub-agents` |
| `verify` | `fact-verifier/sub-agents` |

## 配置文件形状

### MainAgent（route / merge）

保持既有 prompt 格式：

```json
{
  "description": "用途说明",
  "content": "提示词模板..."
}
```

### SubAgent

在 `content` 之外增加 catalog 字段：

```json
{
  "agentName": "来源可信度",
  "displayLabel": "来源可信度",
  "defaultPriority": "high",
  "description": "核对报道来源与原始出处",
  "tools": ["web_search"],
  "content": "提示词模板..."
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `agentName` | 是 | 与 route 指令中的名称一致 |
| `displayLabel` | 是 | UI 展示名 |
| `defaultPriority` | 否 | `high` / `medium` / `low` |
| `description` | 否 | catalog / UI 短描述 |
| `tools` | 否 | 工具名列表；省略或 `[]` 表示无工具 |
| `content` | 是 | 提示词模板（`loadPrompt` 只读此字段用于渲染） |

`promptPath` 由文件相对 `subagentconfig/` 的路径推导（无 `.json` 后缀），例如 `fact-verifier/sub-agents/source-credibility`。

## 加载与解析

### 根目录解析（`prompt-loader`）

优先级：`setSubAgentConfigRoot` > `SUBAGENT_CONFIG_ROOT` > `APP_ROOT/subagentconfig` > 相对模块路径 `../../subagentconfig`。

`loadPrompt(promptPath)` 行为不变：读 `{root}/{promptPath}.json`，返回含 `content` 的配置（额外字段忽略即可）。

### Catalog

`getSubAgentCatalog(module)` 扫描对应 `sub-agents/*.json`，解析为 `CatalogSubAgentEntry`：

```ts
interface CatalogSubAgentEntry {
  agentName: string
  module: SubAgentModule
  promptPath: string
  displayLabel: string
  defaultPriority?: Priority
  description?: string
  tools?: string[]
}
```

渲染进程列表 `CatalogSubAgent` 去掉运行时字段：`Omit<CatalogSubAgentEntry, 'promptPath' | 'tools'>`。

懒加载：首次调用时读盘并缓存，避免在 `setSubAgentConfigRoot` 之前误读路径。

### 工具 registry

`electron/tools/index.ts` 维护名称 → 实例映射：

```ts
TOOL_REGISTRY = { web_search: webSearchTool }
resolveTools(names?: string[]): StructuredToolInterface[] | undefined
```

未知工具名抛 `AppError`（`CONFIG_UNKNOWN_TOOL`）。

`agent-config.toSubAgentConfig`：`tools: resolveTools(entry.tools)`，删除 `AGENT_TOOLS`。

## 数据流

```
subagentconfig/.../sub-agents/*.json
        │
        ├─► sub-agent-catalog（元数据 + tools 名）
        │         │
        │         ▼
        │   agent-config + TOOL_REGISTRY
        │         │
        │         ▼
        │   AgentRuntimeConfig { name, promptPath, tools? }
        │
        └─► loadPrompt(promptPath).content → 渲染后 invoke / ReAct
```

## 不在范围内

- 图执行逻辑（extractor / verifier / llm-utils）不变
- 前端 `CatalogSubAgent` 对外字段不变（仍无 `promptPath` / `tools`）
- 新增工具实现（仅把既有 `web_search` 声明迁入配置）
