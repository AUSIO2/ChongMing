# Implement: SubAgent Skill 暴露 Map 层

对应设计：[017-SubAgent-Skill暴露Map层.md](./017-SubAgent-Skill暴露Map层.md)

## 任务清单

- [x] `GraphProgressPayload` / `GraphProgressEventLocal` 增加 `subagent_tool` 事件
- [x] `src/flow-map/types.ts`：`runtime.activeSkill`
- [x] `llm-utils`：`summarizeToolInput` + callback 捕获 + `invokeWithOptionalTools` options
- [x] `graph-utils`：`sessionsByThread` + `createSubAgentSkillEmitter`；`fanout_spawn` 补 `instanceId`
- [x] `extractor` / `verifier`：`createSubAgentNode` 接入 skill 发射
- [x] `graph-doc`：`applyGraphProgress` + `clearHitlRuntimes`（并行保留 activeSkill）
- [x] `electron-ipc`：转发完整 progress payload
- [x] `graph-doc.spec`：start / end / 并行 / node_exit 兜底

## 验收

- `npm run test:map` 22 passed
- Map 快照可读 `activeSkill`；UI 展示留后续
