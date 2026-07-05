# 编码规范

## 1. 提示词配置化

所有 AI 提示词（prompt）**必须**是可配置的，不允许硬编码在业务逻辑中。

### 规则

- 每个提示词对应一个独立的配置文件（如 `.json` 或 `.yaml`）
- 配置文件包含两个字段：
  - `description`：提示词的用途说明
  - `content`：提示词模板内容
- **配置文件的路径必须能够代表该提示词被实际调用的位置**。例如：
  - 拆分模块的默认策略 prompt → `subagentconfig/fact-extractor/default-strategy.json`
  - 核查模块的逻辑一致性 SubAgent prompt → `subagentconfig/fact-verifier/sub-agents/logic-consistency.json`
- SubAgent 配置可额外包含 catalog 字段（`agentName` / `displayLabel` / `defaultPriority` / `tools`），由 `sub-agent-catalog` 扫描加载；`tools` 为工具名字符串数组（如 `["web_search"]`）

### 配置文件格式示例

```json
{
  "description": "默认拆分策略：将新闻文本拆分为可独立核查的事实陈述",
  "content": "请将以下新闻文本拆分为可独立核查的事实陈述。\n以 JSON 数组返回，每条格式为 { \"content\": \"...\", \"category\": \"...\" }\n\n{{context}}\n\n{{content}}"
}
```

## 2. 编码前必须完成技术设计文档

在开始编码之前，**必须**先完成两份文档：一份是根据计划制定的技术设计文档，一份是implement plan的原稿，保存为为.md文件。

### 规则

- 文档标题根据编码内容自定
- 技术设计文档文件名带开发顺序 ID，格式为 `{ID}-{标题}.md`（如 `001-事实拆分框架设计.md`）
- implement plan的格式为{ID}-implement-{标题}.md（如 `001-implement-事实拆分框架设计.md`）
- 技术设计文档和 implement plan都保存在项目根目录的 `develop-docs/` 文件夹下
- 在 `develop-docs/counter.txt` 中维护当前最大编号，每次创建新文档时递增

## 3. 函数命名（模块前缀 + CRUD）

内部实现函数统一为 **`{prefix}{Verb}{Entity}`**（PascalCase 拼接）：

- **prefix**：模块短名，标识所属文件/域
- **Verb**：单一动词（CRUD 或扩展动词）
- **Entity**：纯名词复合

### 硬规则

1. **无介词**：禁止 `From` `To` `For` `With` `On` `In` `At` `By` `Of` 等；方向/来源并入实体（`News` 代替 `FromNews`，`Persist` 代替 `FromPersist`）
2. **无定语**：禁止 `Rejected` `Active` `Empty` `All` `Current` `Locked` `Visible` `Flat` `Complete` 等形容词或过去分词作定语；动词已表意则省略（`docDeleteClaims`），否则并入实体（`RunEnd` 代替 `RunComplete`）
3. **动词单一**：禁止 `UpdateReset` 等复合动词，用扩展动词 `Reset` / `Restore`

### 实体复合顺序

`{域}{对象}{子对象}`，例如 `PersistGraph`、`DraftClaim`、`NewsRoute`、`NodeFocus`。

### 动词表

| 动词 | 含义 |
|------|------|
| `Create` | 新建文档/记录/ID 字符串 |
| `Read` | 查询/解析/序列化输出 |
| `Update` | 变更/应用事件/upsert/投影 |
| `Delete` | 移除/清空/剪枝 |
| `Reset` | 回到初始态 |
| `Restore` | 从 checkpoint 恢复会话 |
| `Can` / `Is` | 权限判定 / 布尔谓词 |
| `Build` | 复杂图/适配器工厂 |
| `Run` | 执行 LangGraph |
| `Register` | 注册/安装 |
| `Format` | 展示文本 |

### 模块前缀

| 前缀 | 模块 |
|------|------|
| `doc` | `src/flow-map/graph-doc.ts` |
| `mapId` | `electron/shared/map-ids.ts` |
| `layout` | `src/flow-map/layout.ts` |
| `label` | `src/flow-map/tool-labels.ts` |
| `port` | `src/flow-map/port.ts` |
| `adapter` | `src/flow-map/adapters/electron-ipc.ts` |
| `run` | `electron/api/graph-service.ts` |
| `graph` | `electron/shared/graph-utils.ts` |
| `split` / `verify` | `extractor.ts` / `verifier.ts` |
| `llm` | `electron/shared/llm-utils.ts` |
| `err` | `electron/shared/errors.ts` |
| `ctx` | `electron/shared/context.ts` |
| `prompt` | `electron/shared/prompt-loader.ts` |
| `news` | `electron/api/news-service.ts` |
| `serial` | `electron/api/serialize.ts` |
| `catalog` | `electron/api/sub-agent-catalog.ts` |
| `agent` | `electron/api/agent-config.ts` |
| `ckpt` | `electron/shared/checkpointer.ts` |
| `db` | `electron/shared/database.ts` |
| `handler` | `electron/api/register-handlers.ts` |
| `tool` | `electron/tools/index.ts` |

### 正反例

| 差 | 优 |
|----|-----|
| `docCreateFromNews` | `docCreateNews` |
| `docDeleteRejectedClaims` | `docDeleteClaims` |
| `mapIdReadFocusFromNodeId` | `mapIdReadNodeFocus` |
| `docCreateEmpty` | `docCreate` |
| `docIsParamsLocked` | `docIsParamLock` |
| `mapIdReadSubAgentFlat` | `mapIdReadSubAgentClaim` |
| `ctxReadVisible` | `ctxReadAiContext` |
| `docUpdateRunComplete` | `docUpdateRunEnd` |
| `clearHitlRuntimes` | `docDeleteHitlRuntime` |

### 豁免（不改名）

- `MapAPI` / `GraphAPI` 接口方法（`getSnapshot`、`startSplit` 等）
- Vue `use*` composable、Pinia store 内部方法
- IPC channel 字符串（`channels.ts`）
- 类型/接口名、Vue 组件名

新增内部函数时必须遵循本规范；详细迁移记录见 `develop-docs/020-函数命名规范.md`。

