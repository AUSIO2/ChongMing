# 032 — Map claim/draft ID 作用域

## 背景

多新闻同 map 时 claim id `"1"`、`draft:0` 全局碰撞，导致事实错挂。

## 规则

| 场景 | id |
|------|-----|
| default news | `"1"`, `draft:0`（legacy） |
| scoped news | `claim:news:xxx:1`, `draft:news:xxx:0` |

DB `chains[].claims[].claimId` 与 MapNode.id 统一。

## 验收

`npm run test:map` 通过；双新闻不共享 claim 节点。
