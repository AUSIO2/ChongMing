# 097 — 过时代码与构建配置清理实施原稿

日期：2026-10-17。设计依据：[097 设计](./097-过时代码与构建配置清理.md)。

## 执行顺序

1. 以 `rg` 核对四组导出没有生产调用者，保存当前工作区恢复引用。
2. 删除死代码、冗余测试断言和对应错误文案；逐文件同步导入。
3. 将旧 node-run 迁移提示改为现存 branch migration 消息，不改变错误 code。
4. 删除不存在目录的 Electron 打包排除项，重跑正式构建。
5. 检查暂存内容不包含两份 096 修改，再形成独立提交。

## 验收记录

- `npm run test:boundaries` 通过：127个模块边界、117个运行时消息文件，硬编码消息为0。
- `npm run test:map` 通过：1个文件、4项测试；精确类型/版本转换筛选正反例保留。
- Run结构专项通过：3个文件、15项测试。
- `vue-tsc --noEmit` 通过。
- `npm run build:check` 通过：renderer、Electron main/preload和macOS arm64 DMG均成功；保留既有大chunk提示和本机无有效Developer ID的未签名提示。
- 被删名称的生产/测试引用扫描归零；仅097设计保留删除依据。`git diff --check`通过。
