# 085 — 旧 Timeline 构建残留清理实施记录

日期：2026-10-06。设计见 [085](./085-旧Timeline构建残留清理.md)。

## 实施原稿

先备份构建目录和本次修改的现有配置/文档；确认旧产物不可达后清理八个文件，收紧打包清单，标记历史需求，再正常构建和验证。保留用户数据库、历史设计、执行归档和其他未提交修改。

## 变更与验证

已完成清理。前端第一阶段只在 082 中细化交付及验收，尚未开始编码。

### 备份与清理

备份：`/Users/xiong/.codex/backups/chongming/timeline-cleanup-20261006-8pxe1rez`。保存原 dist、dist-electron、打包配置、需求与 082 文档；manifest.json 记录八个退役文件的字节数和 SHA-256，删除前已核对备份与原文件一致。

移除八个不可达产物：三个 `main-{Bep4y-pd,sFEBHs4x,ByeYuYTO}.js`、三个 `local-agent-service-{B1vEyGdr,kN0MO3-u,xvR9Fb-m}.js`、`main.cjs`、`preload.mjs`。当前 main.js/preload.js 无本地产物导入，桌面打包清单改为只包含这两个入口；renderer 资源清单保留。

早期需求草案及028/033/034的六份Timeline设计和实施记录已经退出主线，可从Git历史查阅。保留Operation、迁移夹具、执行归档、历史发行包及用户数据库。

082 的 A 阶段细化为统一视觉、外壳导航、Map/单页切换、基础节点阅读和往返状态；正式三维性能阶段改为 B。库接口与 084 协调后在 F 对接，不先要求完整接口设计，也不新增 Mapper。

### 验证

- `npx vite build` 通过：renderer、Electron main 和 preload 均正常生成；保留原有 Vite CJS API 弃用提示，未出现构建失败。
- 新 dist/dist-electron 未发现旧 Timeline 类型、组件、命令或旧 until 错误文案；dist-electron 仅 main.js/preload.js，打包配置解析及本地导入检查通过。
- `node --check` 检查两个桌面入口通过。
- `npm run test:boundaries` 通过：90 个模块、93 个消息检查文件；`git diff --check` 通过。
- 首次退役标记校验的文件匹配误含新增 085 清理记录，已限定为六份旧 Timeline 文档后复验；文档格式与新增本地链接校验通过。
- 未运行后端服务、业务集成测试、UI 手动验收或安装包打包。本次验证不代表前端双视图或库接口已实现。
