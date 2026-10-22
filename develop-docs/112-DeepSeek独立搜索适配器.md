# 112 — DeepSeek独立搜索适配器

用户要求把web_search接到DeepSeek独立搜索接口，沿用已有工作区/Agent模型凭据，不引入服务器Key。先补测试，再改实现，保持现有图流程。

## 合同与实现

[官方Search/Fetch指南](https://api-docs.deepseek.com/guides/search/)：POST `/v1/tools/search`，Bearer认证，请求为query、count、need_content。query最长128个Unicode字符，count为1–50，空results是正常成功。

- `backend/execution/dsh/dsh-deepseek-search-plugin.mjs`：通过ctx.web注册独立provider；一次HTTP请求返回结构化来源。summary映射snippet，缺失时用原snippet，保留url/title/date，不另外生成搜索答案。
- `backend/execution/dsh/dsh-business.patch.yml`：将现有web_search选择器指向该provider，工具名称、能力白名单、展示、结果上限、外部内容提示和取消/超时仍由SDK原工具处理。web_fetch不变。
- `scripts/prepare-desktop-runtime.mjs`：打包时复制新增插件，避免源码可用而桌面缺文件。

DEEPSEEK_API_KEY与DEEPSEEK_BASE_URL来自已有workCreateModelEnvironment注入的本Work连接。该函数已经移除父模型凭据，只有deepseek-official工作才获得DeepSeek环境；OpenAI Key不借给搜索。官方根地址和/v1地址均归一到独立搜索路径。错误只保留状态或固定错误文案，不回显供应商错误正文，不加自建重试或第二套超时。

## 测试与验收

`tests/backend/execution/deepseek-search.spec.ts`先行覆盖：准确POST/请求字段/凭据、来源归一化、空结果、Key隔离、401/402/429、非法JSON/缺results、参数边界与Unicode、取消，以及真实DSH通过正常Work补丁调用搜索并获得来源。所有模型/搜索请求均指向本机HTTP夹具，不使用真实Key。红灯先有12项因适配器未实现而失败；这证明新增能力缺失，不描述为原业务回归。首次集成夹具错用了对象数组queries，按SDK真实字符串数组合同修正，未为夹具修改产品实现。

新增13项与原模型凭据/业务插件回归合计3文件33项全部通过；其中真实DSH确认仅一次`/v1/tools/search`，无`/messages`，随后来源摘要和URL进入模型工具结果并正常提交。vue-tsc、架构与错误文案检查通过。桌面实际重新prepare并通过Node+SQLite+DSH运行、持久化重启、父断连清理检查；未发布桌面安装包。独立只读代码审查未发现其他实质问题。

Linux发布预检首次失败：隔离脚本用了空ports的outputs合同，业务工具生成无效oneOf，SDK报inactive context。在同一脚本补成正常有效port后，旧r110和新准备版本的Harness start/close均通过，确认属于预检夹具错误；未给产品增加空合同兼容、延迟或重试。首次失败与对照记录保留，失败发生在停止Host和切换之前，线上服务未受影响。

## 网站发布结果

Host-only版本`r112-host-1792640310`已发布，基于原`r110-1792635480`复制，仅覆盖搜索插件及业务补丁两个文件，逐项SHA256核对一致。未把本机其他未提交改动或Mac依赖带到服务器。旧release保留；回退只需停Host、切回旧app链接并启动Host，无数据库恢复。

Linux真实Harness使用隔离HOME、fake Key和loopback模型/搜索端点：两次模型请求、一次独立搜索请求，来源marker返回给模型并完成final，随后正常关闭。该测试没有创建GraphRun或调用真实供应商。

2026-10-22 11:38:56（北京时间）新的host.started已确认，实际Host工作目录为新release；Graph进程及其旧r110工作目录保持不变，health为200/ready。发布前、停止空闲Host后及发布后均无活动Run；原演示图仍revision23、13节点、15条连线，节点/边摘要前后一致，查看账号仍为viewer。没有改模型Key、演示产物或数据库合同。

UI的`dist/release.json`仍准确标记r110，独立`host-release.json`记录本次执行端版本及两个源码摘要。最终结果与Linux收据在`test-results/112-deepseek-search/publish-result.json`，首次预检失败及对照保留在同目录。未额外调用真实DeepSeek搜索，因此不能将夹具验证描述为真实供应商联网取证验收。

## 演示查看账号

另按用户此前请求，通过正式注册/成员API创建普通演示查看账号，只给“新闻闭环演示 · 嫦娥六号”viewer权限。实际重新登录成功、hostAdmin=false，可读原图13节点/15条连线，“熊博士”等其他已有工作区不可见；两个临时验证会话均logout，原Owner浏览器不变。用户名与密码仅保存在本机gitignored私有凭据工件，不记入本文；Owner令牌和模型Key未外发。账号注册自动产生其个人空工作区，进入后需切换到演示工作区。
