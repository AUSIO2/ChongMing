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
| `mapDocument` | `electron/mapper/document.ts` |
| `project` | `electron/mapper/project.ts` |
| `read` | `electron/mapper/output.ts` 的模型输出解析 |
| `parse` / `split` / `verify` | `electron/mapper/stages/` |
| `mapLease` | `electron/api/map-lease.ts` |
| `mapId` | `electron/shared/map-ids.ts` |
| `layout` | `src/flow-map/layout.ts` |
| `timeline` | `src/flow-map/timeline.ts` |
| `label` | `src/flow-map/tool-labels.ts` |
| `llm` | `electron/shared/llm-utils.ts` |
| `err` | `electron/shared/errors.ts` |
| `ctx` | `electron/shared/context.ts` |
| `prompt` | `electron/shared/prompt-vars.ts` |
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

- `MapperAPI` 接口方法（`read`、`dispatch`、`watch`）
- Vue `use*` composable、Pinia store 内部方法
- IPC channel 字符串（`channels.ts`）
- 类型/接口名、Vue 组件名

新增内部函数时必须遵循本规范；详细迁移记录见 `develop-docs/020-函数命名规范.md`。

## 4. 不做向前兼容

迁移或重构时，**不要**为旧 API、旧字段、旧命名保留并行路径或 shim。

### 规则

- 一次性改全栈调用方（类型、IPC、DB 字段、前端 adapter），而不是在边界层做「双读双写」长期共存
- 禁止新增「读时兼容旧字段、写时只写新字段」之类过渡逻辑，除非当前任务明确要求且有过期删除节点
- 废弃即删除：旧 handler、旧 channel、旧类型名、旧集合名，随迁移 PR 一并移除，不保留转发别名
- 数据迁移用**一次性脚本**升级存量文档，而不是在运行时代码里永久分支

### 正反例

| 差 | 优 |
|----|-----|
| `mapRead` 内 `newsId ?? mapId` 双读 | 全库改 `mapId`，迁移脚本处理存量 |
| 保留 `news:*` IPC 转发半年 | 同 PR 改 preload + renderer |
| `NEWS_ROOT_ID` 与新 `news:default` 长期并存 | 迁移节点 id 后只保留一种 |

## 5. 兜底与类型检查：先问是否必要

写 `??`、`?.`、宽泛 `typeof`/`in` 判断、`as` 断言、try/catch 吞错、多分支 fallback 之前，**先判断这条路径是否真实存在**。

### 规则

- 若类型系统或调用契约已保证不变式，**不要**再写运行时重复校验
- 若某状态按设计不可能出现，应修数据流或类型定义，而不是加 silent fallback
- 允许防御的场景：外部输入（IPC、文件、网络、用户编辑）、Mongo 存量脏数据的一次性迁移边界
- 类型检查优先收窄来源（解析函数、zod/显式 DTO），避免在业务深处堆 `if (x && typeof x === 'object')`
- 禁止用兜底掩盖 bug：「取不到就用默认值」若会隐藏错误，应 `throw` 明确错误码

### 自问清单（写之前过一遍）

1. 调用方能否保证该字段存在？
2. 这是公开边界还是内部已类型化的路径？
3. fallback 会让错误更晚、更难排查吗？
4. 删掉这段代码，测试/类型检查是否会失败？若不会，多半不必写

### 正反例

| 差 | 优 |
|----|-----|
| 每个节点 `kind` 后接五层 optional chaining | `graph-doc` 入口校验一次，内部用窄类型 |
| `parentNodeId ?? NEWS_ROOT_ID ?? mapId` 链式默认 | 启动 `runTransition` 时必填，缺则 `MAP_INVALID_SCOPE` |
| `catch { return [] }` 隐藏 DB 失败 | `AppError` 向上抛，adapter 统一展示 |

## 6. 修 Bug：先发掘根因

修 Bug 时**先定位根因再改代码**，禁止用兜底、重试、绕路把症状盖住。

### 规则

- 复现 → 缩小范围（哪一层、哪条数据路径）→ 解释「为什么会发生」→ 再写最小修复
- 修复应打在**产生错误不变式的源头**（序列化、类型契约、状态机），而不是在更外层吞掉异常
- 若修复依赖「某字段可能为空所以 `??` 默认值」，须先证明该空值是合法输入；否则应修上游保证或 `throw`
- 回归：根因修复应配**能失败在没有修复时的测试**（单测 / 最小复现），避免同类问题复发

### 自问清单

1. 这是表象还是根因？（例如 IPC clone 失败 → 根因是 Mongoose DocumentArray，不是「再包一层 try/catch」）
2. 同类数据路径是否还有相同漏洞？
3. 修复后能否用一句话说明「为什么不会再发生」？

### 正反例

| 差 | 优 |
|----|-----|
| `map:get` 失败就 `catch` 返回 `null` | 查明 `claims` 为 DocumentArray，序列化层转纯对象 |
| 布局错位就硬编码 offset | 查清 `parentId` 与 layout 深度契约不一致，改投影 |
| 偶发失败加重试 3 次 | 查清 race 在 `runId` 校验，改 gate 逻辑 |
