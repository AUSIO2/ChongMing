# 仓颉证据图检查模块第三方资源说明

本目录记录本模块构建和分发所用的仓颉工具链、JSON扩展库及运行库来源。版本、下载地址及SHA256见[toolchain-sources.json](./toolchain-sources.json)。这些第三方许可不为重明项目其余源码指定许可证。

## Cangjie SDK 1.1.3

- 来源：[仓颉官网下载页](https://cangjie-lang.cn/download/1.1.3)，macOS arm64发行包。
- 编译器：cjc 1.1.3，目标aarch64-apple-darwin。
- 使用方式：编译仓颉模块；随可执行程序分发官方SDK中的`libcangjie-runtime.dylib`和`libboundscheck.dylib`。标准库按编译器默认方式静态链接。
- SDK与仓颉运行时许可：Apache-2.0 with Runtime Library Exception，保留完整[许可文本](./licenses/Cangjie-SDK-LICENSE.txt)。
- `libboundscheck`按其单独许可记录于下节。

## Cangjie stdx 1.1.3.1

- 来源：[官方GitHub镜像的v1.1.3.1标签](https://github.com/cangjielanguage/cangjie_stdx/tree/v1.1.3.1)，提交`8fa4b04b4cb1753e8f3581e4935cf72ad145fedc`。官方镜像组织说明见[cangjielanguage](https://github.com/cangjielanguage)。
- 使用方式：从原样源码构建`stdx.serialization.serialization`、`stdx.encoding.json`与JSON字符串转义C库`stdx.encoding.jsonFFI`，以静态库链接；未引入HTTP或OpenSSL库。
- 原始版权：Huawei Technologies Co., Ltd.；源文件保留原版权头。本模块没有复制、修改这些库的源文件到自身业务源码中。
- 许可：Apache-2.0 with Runtime Library Exception，完整文本见[Cangjie-stdx-LICENSE.txt](./licenses/Cangjie-stdx-LICENSE.txt)。

## libboundscheck

- 仓颉运行时[第三方依赖说明](https://github.com/cangjielanguage/cangjie_runtime/blob/v1.1.3/runtime/third_party/README.md)将该库指向OpenHarmony的`third_party_bounds_checking_function`，版本为`OpenHarmony-v6.0-Release`。
- 上游：[OpenHarmony源仓库](https://gitcode.com/openharmony/third_party_bounds_checking_function)，[对应标签的许可文本镜像](https://github.com/openharmony/third_party_bounds_checking_function/blob/OpenHarmony-v6.0-Release/LICENSE)。
- 使用方式：直接分发SDK中未经修改的`libboundscheck.dylib`，供仓颉运行时动态加载；未在本项目中重新构建此运行库。
- 许可：MulanPSL-2.0，完整中英文许可文本见[libboundscheck-LICENSE.txt](./licenses/libboundscheck-LICENSE.txt)。

## 分发与复现

构建结果应同时包含可执行文件、`runtime/`下的两份动态库、`licenses/`下三份完整许可文本，以及本说明和工具链来源清单。运行库通过`@executable_path/runtime`加载，不需要把开发者机器的SDK绝对路径写入最终程序。首版实际验证范围为macOS arm64；其他平台需要匹配SDK和独立构建验证。

SDK压缩包摘要来自官方下载页加载的版本清单；stdx源码压缩包摘要为本次从官方镜像取得后计算，并以标签提交号单独核对。源码文件与运行库摘要同时记录，便于检查实际构建输入。
