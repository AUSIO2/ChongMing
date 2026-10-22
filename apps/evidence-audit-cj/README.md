# 重明仓颉证据图检查与报告导出

此模块用仓颉读取重明图数据，检查节点、关系与核查引用，生成中文Markdown报告。Node入口负责从文件或现有API取得数据，并管理仓颉进程；检查算法和报告正文均在src下的.cj文件实现。

检查结果表示结构是否符合本模块支持的规则，不表示新闻内容真实。命令不会调用模型、访问新闻链接或改写图数据。

## 快速运行

已经构建后，在仓库根目录执行：

```bash
npm run evidence:audit -- --input apps/evidence-audit-cj/examples/completed.json
npm run evidence:audit -- --input apps/evidence-audit-cj/examples/completed.json --format markdown --output /tmp/chongming-audit-report.md
```

输出文件必须尚不存在。JSON输出包含status、summary、findings及markdown。使用`npm run --silent evidence:audit -- ...`可以避免npm脚本说明进入重定向文件。

也可以直接运行仓颉二进制，只接受裸图JSON，不接受CLI成功响应外层：

```bash
apps/evidence-audit-cj/bin/evidence-audit --input apps/evidence-audit-cj/examples/completed.json
```

## 安装与构建

当前已验证平台为macOS arm64，使用仓颉SDK 1.1.3和stdx v1.1.3.1。需要Node.js 24、已安装的项目依赖、Apple Command Line Tools提供的clang/ar/xcrun。SDK下载约245 MB；JSON扩展库使用固定版本的官方源码本地构建。

```bash
bash scripts/setup-evidence-audit.sh "$HOME/.cache/chongming-cangjie"
```

安装仅写指定cache和本模块bin/target，不改shell启动文件或全局PATH。脚本验证SDK及stdx源码包SHA256，构建时再次验证实际采用的扩展库源文件与运行库摘要。官方链接和摘要依据保存在toolchain-sources.json。

已有SDK和stdx源码时可直接构建：

```bash
npm run evidence:audit:build -- --sdk /absolute/path/cangjie --stdx-source /absolute/path/cangjie_stdx-1.1.3.1
```

成功后本机路径仅保存在被忽略的target/local-build.json，后续执行`npm run evidence:audit:build`即可。交付目录为bin/，内含可执行程序、runtime/、licenses/、第三方说明与build-info.json；移动交付物时复制整个bin目录。cjpm.toml提供工程元信息，规范构建与运行库打包以仓库脚本为准。当前未验证Windows/Linux打包与macOS签名公证。

## 只读查询现有图

```bash
npm run evidence:audit -- --map-id YOUR_MAP_UUID --url http://127.0.0.1:4320 --token-file /absolute/path/user-token.txt --format markdown --output /tmp/map-report.md
```

API模式复用clientCreateApi的map.get权限校验；凭据由Node持有，不进入仓颉参数、输入文件或子进程环境。可用CHONGMING_USER_TOKEN与CHONGMING_GRAPH_API代替对应选项。CHONGMING_CANGJIE_AUDIT_BIN可指定另一个已构建的模块程序。

本地--input支持裸图或现有CLI的`{ "ok": true, "data": 图 }`响应，拒绝失败响应和导出Bundle。这里需要包含当前图完整nodes/edges的输入，不应把截断分支当作完整图。111历史持久化投影也可读取；模块没有要求运行历史、producer或所有业务Schema字段齐全。

## 检查规则与边界

- 结构错误：重复节点或关系ID、关系端点缺失、非法关系kind、successor结构环、显式payload引用缺失。
- 业务错误：已支持v1意见/结论的分数、正文或引用列表不符合规则，或引用目标类型错误。
- 待完成提示：事实沿successor关系尚未发现v1结论。reference关系不用于推断流程完成。
- 未覆盖提示：未知类型/版本只查通用结构；外部库引用保留并标记未读取。空evidenceClaimIds合法，不推断“没有依据”。

模块没有实现完整JSON Schema验证、外部证据库解析、来源网页核验或运行授权审计。报告保留原有正文和评分，并作Markdown转义；未归属和孤立节点仍会列出。

| 退出码 | 含义 |
| --- | --- |
| 0 | 检查完成，无结构错误；可能有待完成或未覆盖提示 |
| 1 | 检查完成，发现结构错误；仍输出完整报告 |
| 2 | 用法或输入不符合要求，未生成有效报告 |
| 3 | Node接入层的执行、API或文件故障 |

Node入口限制输入10 MiB、子进程输出32 MiB、执行30秒。报告文件仅新建；临时输入目录权限0700，文件0600，执行结束后清理。报告结果不含时间戳或随机ID，同一输入可重复对照。

## 验证

```bash
npm run test:evidence-audit
```

专用套件要求先构建仓颉二进制；缺少程序时明确失败，不静默跳过。普通Node测试仍覆盖adapter，原生验收通过独立配置运行，避免给所有旧测试增加仓颉环境要求。

测试覆盖正常中文样例、断链、重复ID、未完成事实、外部引用、未来版本、引用环与结构环、无效输入、报告转义、真实Node到仓颉调用、复制发行目录后的独立运行，以及adapter超时/取消/输出限制/不覆盖文件行为。

设计和实施记录见develop-docs/116两份文档。第三方软件及许可证见THIRD_PARTY_NOTICES.md与licenses/；本模块的第三方许可说明不改变整个重明项目的代码授权。
