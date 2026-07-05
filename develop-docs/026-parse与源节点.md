# 026 — Parse 过渡与源节点（阶段 B）

## 背景

阶段 A 完成 `Map` 主键、`chains`、`runTransition('1-2'|'2-3')`。阶段 B 补齐列 0→1：**source → parse → news**。

## 目标

1. `TransitionKey` 增 `'0-1'`；`TRANSITION_REGISTRY` 注册 parse
2. 节点 kind：`source`、`parseAgent`；id 规则 `source:{chainId}` / `parse:{chainId}` / `news:{chainId}`
3. `docAddSourceChain` 追加源链三角；`runTransition('0-1', sourceId)` 从文件读入正文写入 `chains[newsNodeId]`
4. 保留 `__news_root__` 直连 split 路径

## 拓扑

```text
source:{id}  ──→  parse:{id}  ──→  news:{id}
  (x=0)            (解析)           (x=2 scope)
```

## Parse 图

`loadSource → parseExtract → save`（HITL 中断在 `save`）

- `loadSource`：读 `mapGraph` 中 source 节点 `params.uri`，`fs.readFile`
- `parseExtract`：txt 直通；可选 LLM 清洗（`fact-parser/extract.json`）
- `saveNews`：写 `chains[newsNodeId].content`

## 不在本阶段

- `runTimeline`、Timeline UI
- URL 抓取、workspace 项目文件

## 验收

- 导入 txt → 画布见 source/parse/news
- `0-1` 解析出正文；续跑 `1-2` 用 `news:{chainId}` 作 `parentNodeId`
- 无 source 时 `__news_root__` split 仍可用
