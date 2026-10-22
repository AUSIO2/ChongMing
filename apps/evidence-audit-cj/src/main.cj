package evidence_audit

import std.fs.*
import stdx.encoding.json.*

main(/* 不含程序名的命令行参数。 */ args: Array<String>): Int64 {
    // 读取一个有限大小的图文件，运行纯结构检查并按协议输出唯一JSON结果。
    if (args.size != 2 || args[0] != "--input") {
        println(renderInvalid("USAGE", ""))
        return 2
    }
    var text: String
    try {
        let info = FileInfo(args[1])
        if (!info.isRegular()) {
            println(renderInvalid("INPUT_IO", ""))
            return 2
        }
        if (info.size > 10 * 1024 * 1024) {
            println(renderInvalid("INPUT_LIMIT", ""))
            return 2
        }
        let bytes = File.readFrom(args[1])
        if (bytes.size > 10 * 1024 * 1024) {
            println(renderInvalid("INPUT_LIMIT", ""))
            return 2
        }
        try {
            text = String.fromUtf8(bytes)
        } catch (e: Exception) {
            println(renderInvalid("INPUT_JSON", ""))
            return 2
        }
    } catch (e: Exception) {
        println(renderInvalid("INPUT_IO", ""))
        return 2
    }
    if (!hasStandardJsonTokens(text)) {
        println(renderInvalid("INPUT_JSON", ""))
        return 2
    }
    var json: JsonValue
    try {
        json = JsonValue.fromStr(text)
    } catch (e: Exception) {
        println(renderInvalid("INPUT_JSON", ""))
        return 2
    }
    try {
        let result = AuditResult(AuditGraph(json))
        result.run()
        println(renderAuditJson(result))
        return if (result.count("error") > 0) { 1 } else { 0 }
    } catch (e: InputFailure) {
        println(renderInvalid("INPUT_STRUCTURE", e.fieldPath))
        return 2
    }
}
