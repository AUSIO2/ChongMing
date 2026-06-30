# 崇明（ChongMing）— 事实核查智能体

> 项目名取"崇明"之意：崇尚真理，明辨是非。

## 项目概述

崇明是一款基于 Electron 的桌面端事实核查智能体应用。通过自动化爬取新闻事件与媒体报道，将内容拆分为可核查的原子化事实元素，并通过多源数据交叉验证，辅助用户高效完成事实核查工作。

---

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 框架 | Electron + electron-vite | 桌面应用框架，Vite 构建 |
| 语言 | TypeScript | 前后端统一语言 |
| 前端 | Vue 3 + Composition API | 响应式 UI |
| 后端 | Electron 主进程 (Node.js) | 爬虫、数据处理、本地存储 |
| 数据库 | SQLite (better-sqlite3) | 本地持久化存储 |
| IPC | 类型安全的 IPC 封装 | 前后端通信 |

---

## 一期功能（MVP）

### 1. 新闻爬取模块

- **目标**：从指定新闻源自动爬取新闻事件和媒体报道
- **功能点**：
  - [ ] 支持添加/管理新闻源（RSS、网页 URL）
  - [ ] 定时或手动触发爬取任务
  - [ ] 爬取结果的预览与筛选
  - [ ] 爬取任务状态监控（进行中/成功/失败）
  - [ ] 原始内容存储（标题、正文、来源、时间、作者等元数据）

### 2. 事实拆分模块

- **目标**：将新闻内容智能拆分为"可核查"的原子化事实元素
- **功能点**：
  - [ ] 自动提取关键事实陈述（who/what/when/where/how）
  - [ ] 将事实陈述标记分类（数据型、引用型、事件型、因果型等）
  - [ ] 用户可手动编辑/补充拆分结果
  - [ ] 每条事实元素关联回原文上下文

### 3. 数据整合模块

- **目标**：对拆分后的事实元素进行多维度整合与分析
- **功能点**：
  - [ ] 按主题/事件/实体聚合相关事实
  - [ ] 多源对比：同一事实在不同来源中的表述差异
  - [ ] 时间线视图：按时间顺序排列事实演变
  - [ ] 标注核查状态（待核查 / 已确认 / 存疑 / 已证伪）
  - [ ] 导出核查报告（Markdown / PDF）

### 4. 基础 UI

- **目标**：提供清晰、高效的操作界面
- **功能点**：
  - [ ] 侧边导航栏（新闻源管理、爬取任务、事实库、核查报告）
  - [ ] 新闻列表 + 详情视图
  - [ ] 事实元素卡片视图
  - [ ] 核查工作台（拖拽式、多面板布局）
  - [ ] 深色/浅色主题切换

---

## 二期功能（规划中）

- [ ] 接入 LLM API，辅助事实拆分与初步核查
- [ ] 知识图谱可视化（实体关系网络）
- [ ] 协作功能（多人核查工作流）
- [ ] 浏览器插件联动（右键核查选中文本）
- [ ] 可信度评分模型

---

## 项目结构（目标）

```
ChongMing/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── index.ts       # 主进程入口
│   │   ├── ipc/           # IPC 处理器
│   │   ├── crawler/       # 爬虫模块
│   │   ├── database/      # SQLite 数据层
│   │   └── services/      # 业务逻辑
│   ├── renderer/          # Vue 渲染进程
│   │   ├── src/
│   │   │   ├── App.vue
│   │   │   ├── views/     # 页面组件
│   │   │   ├── components/# 通用组件
│   │   │   ├── stores/    # Pinia 状态管理
│   │   │   ├── router/    # Vue Router
│   │   │   └── assets/    # 静态资源
│   │   └── index.html
│   ├── preload/           # preload 脚本
│   │   └── index.ts
│   └── shared/            # 前后端共享
│       ├── types/         # 类型定义
│       └── constants/     # 常量
├── docs/                  # 文档
├── package.json
├── electron.vite.config.ts
└── tsconfig.json
```

---

## 数据模型（一期）

### NewsSource — 新闻源
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (UUID) | 主键 |
| name | string | 源名称 |
| url | string | 源地址 |
| type | enum | rss / webpage |
| enabled | boolean | 是否启用 |
| crawlInterval | number | 爬取间隔（分钟） |
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 更新时间 |

### Article — 新闻文章
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (UUID) | 主键 |
| sourceId | string | 关联新闻源 |
| title | string | 标题 |
| content | text | 正文内容 |
| author | string | 作者 |
| publishedAt | datetime | 发布时间 |
| url | string | 原文链接 |
| crawledAt | datetime | 爬取时间 |
| metadata | json | 其他元数据 |

### FactClaim — 事实元素
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (UUID) | 主键 |
| articleId | string | 关联文章 |
| content | text | 事实陈述 |
| category | enum | data / quote / event / causal |
| context | text | 原文上下文 |
| status | enum | pending / confirmed / disputed / debunked |
| confidence | number | 可信度评分 (0-1) |
| createdAt | datetime | 创建时间 |
| updatedAt | datetime | 更新时间 |

### FactGroup — 事实聚合
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string (UUID) | 主键 |
| name | string | 聚合主题名 |
| description | text | 描述 |
| claimIds | json | 关联的事实元素 ID 列表 |
| createdAt | datetime | 创建时间 |
