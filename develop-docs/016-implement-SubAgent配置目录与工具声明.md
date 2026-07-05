# Implement: SubAgent 配置目录与工具声明

对应设计：[016-SubAgent配置目录与工具声明.md](./016-SubAgent配置目录与工具声明.md)

## 任务清单

- [x] `prompts/` 重命名为 `subagentconfig/`
- [x] 6 个 sub-agent JSON 写入 catalog 字段；来源可信度 / 数据可验证性加 `"tools": ["web_search"]`
- [x] `prompt-loader`：根目录与 API 改名为 subagentconfig / `setSubAgentConfigRoot` / `SUBAGENT_CONFIG_ROOT`
- [x] `main.ts`、`electron-env.d.ts` 同步路径与环境变量
- [x] `sub-agent-catalog`：扫描加载，`tools?: string[]`；IPC 列表去掉 `promptPath` 与 `tools`
- [x] `tools/index`：`TOOL_REGISTRY` + `resolveTools`
- [x] `errors`：增加 `CONFIG_UNKNOWN_TOOL` / `CONFIG_INVALID_SUBAGENT`
- [x] `agent-config`：用 `resolveTools(entry.tools)`，删除 `AGENT_TOOLS`
- [x] 更新 `coding.md` / `.agents/rules/code-style.md` 中的路径示例

## 验收

- Catalog 列表与原先 6 个 agent 一致（名称、优先级、描述）
- 来源可信度、数据可验证性运行时带 `web_search`；其余无 tools
- 无 `AGENT_TOOLS` 硬编码映射
