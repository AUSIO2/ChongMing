---
trigger: always_on
---

# 编码规范

## 1. 提示词配置化

所有 AI 提示词（prompt）**必须**是可配置的，不允许硬编码在业务逻辑中。

### 规则

- 每个提示词对应一个独立的配置文件（如 `.json` 或 `.yaml`）
- 配置文件包含两个字段：
  - `description`：提示词的用途说明
  - `content`：提示词模板内容
- **配置文件的路径必须能够代表该提示词被实际调用的位置**。例如：
  - 拆分模块的默认策略 prompt → `prompts/fact-extractor/default-strategy.json`
  - 核查模块的逻辑一致性 SubAgent prompt → `prompts/fact-verifier/logic-consistency.json`

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

