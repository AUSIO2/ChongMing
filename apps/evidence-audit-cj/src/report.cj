package evidence_audit

import std.collection.*
import stdx.encoding.json.*

func findingMessage(/* 稳定的诊断编号。 */ code: String): String {
    // 集中维护诊断文案，正文和输入值仅通过独立定位字段呈现。
    match (code) {
        case "DUPLICATE_NODE_ID" => "节点标识重复，引用目标存在歧义。"
        case "DUPLICATE_EDGE_ID" => "关系标识重复。"
        case "MISSING_EDGE_NODE" => "关系端点在当前图中不存在。"
        case "INVALID_EDGE_KIND" => "关系类型不是successor或reference。"
        case "MISSING_REFERENCE_TARGET" => "显式引用的目标节点在当前图中不存在。"
        case "REFERENCE_TYPE_MISMATCH" => "业务引用的目标节点类型与定义不一致。"
        case "INVALID_PAYLOAD" => "已支持类型的正文、分数或引用列表不符合检查规则。"
        case "PENDING_CLAIM" => "沿successor关系尚未发现该事实的v1核查结论。"
        case "UNSUPPORTED_NODE_TYPE" => "该节点类型尚未提供业务字段检查，仅检查通用图关系。"
        case "UNSUPPORTED_NODE_VERSION" => "该节点类型版本尚未支持，仅检查通用图关系。"
        case "UNSUPPORTED_REFERENCE_VERSION" => "引用目标类型正确，但其版本尚未支持。"
        case "EXTERNAL_LIBRARY_UNCHECKED" => "外部证据库引用已保留，本次没有读取或校验库内容。"
        case "SUCCESSOR_CYCLE" => "successor关系中存在结构环。"
        case _ => "未识别的结构诊断。"
    }
}

func quoteJson(/* 要写入JSON字符串值的文本。 */ text: String): String {
    // 使用官方JSON库转义文本，避免控制字符和引号破坏输出协议。
    return JsonString(text).toString()
}

func safeText(/* 来自输入图且可能包含Markdown或HTML的文本。 */ text: String): String {
    // 转义HTML与Markdown结构字符，并把正文换行保持在同一引用块内。
    return text.replace("\\", "\\\\").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("`", "\\`").replace("[", "\\[").replace("]", "\\]").replace("*", "\\*")
        .replace("_", "\\_").replace("#", "\\#").replace("|", "\\|").replace("!", "\\!")
        .replace("~", "\\~").replace("\r", "").replace("\n", "\n> ")
}

func renderFindingJson(/* 当前结构问题及其定位字段。 */ finding: Finding): String {
    // 以固定字段顺序编码诊断，重复执行相同输入得到稳定结果。
    var result = "{\"severity\":" + quoteJson(finding.severity) + ",\"code\":" + quoteJson(finding.code) +
        ",\"message\":" + quoteJson(findingMessage(finding.code))
    if (!finding.nodeId.isEmpty()) { result += ",\"nodeId\":" + quoteJson(finding.nodeId) }
    if (!finding.edgeId.isEmpty()) { result += ",\"edgeId\":" + quoteJson(finding.edgeId) }
    if (!finding.path.isEmpty()) { result += ",\"path\":" + quoteJson(finding.path) }
    return result + "}"
}

func renderAuditJson(/* 已完成检查的结果对象。 */ result: AuditResult): String {
    // 输出供Node消费的单个JSON对象，正文报告也由仓颉生成。
    var values = ""
    for (finding in result.findings) {
        if (!values.isEmpty()) { values += "," }
        values += renderFindingJson(finding)
    }
    let summary = "{\"nodeCount\":${result.graph.nodes.size},\"edgeCount\":${result.graph.edges.size}," +
        "\"errorCount\":${result.count("error")},\"warningCount\":${result.count("warning")}," +
        "\"claimCount\":${result.claimCount},\"pendingClaimCount\":${result.pendingClaimCount}," +
        "\"unsupportedNodeCount\":${result.unsupportedNodeCount},\"externalReferenceCount\":${result.externalReferenceCount}}"
    return "{\"protocolVersion\":1,\"status\":" + quoteJson(result.status()) + ",\"summary\":" + summary +
        ",\"findings\":[" + values + "],\"markdown\":" + quoteJson(renderMarkdown(result)) + "}"
}

func renderMarkdown(/* 已检查且顺序固定的图与诊断信息。 */ result: AuditResult): String {
    // 展示检查范围、定位诊断、全部节点和显式关系，不把输入结论写成工具判断。
    let graph = result.graph
    var text = "# 重明证据图结构检查报告\n\n"
    text += "图名称：" + safeText(graph.name) + "\n\n图标识：" + safeText(graph.mapId) +
        "；图版本：${graph.revision}\n\n"
    text += "结构检查状态：${result.status()}；错误 ${result.count("error")} 项，提示 ${result.count("warning")} 项。\n\n"
    text += "本报告由仓颉模块生成，只检查图结构与已支持类型的有限字段，不判断新闻真假，不验证外部网页或证据库内容。"
    text += "节点正文、分数与核查结论均来自输入数据，未进行模型调用或重新判定。\n\n"
    text += "## 检查发现\n\n"
    if (result.findings.isEmpty()) { text += "本次受支持的结构检查未发现问题。\n\n" }
    for (finding in result.findings) {
        text += "- " + finding.severity + " / " + finding.code + "：" + findingMessage(finding.code)
        if (!finding.nodeId.isEmpty()) { text += " 节点：" + safeText(finding.nodeId) }
        if (!finding.edgeId.isEmpty()) { text += " 关系：" + safeText(finding.edgeId) }
        if (!finding.path.isEmpty()) { text += " 字段：" + safeText(finding.path) }
        text += "\n"
    }
    text += "\n## 输入节点\n\n"
    if (graph.nodes.isEmpty()) { text += "暂无核查内容。\n\n" }
    var i: Int64 = 0
    for (node in graph.nodes) {
        i++
        text += "### 节点 ${i}\n\n标识：" + safeText(node.id) + "\n\n类型：" + safeText(node.typeId) +
            "；类型版本：${node.typeVersion}；节点版本：${node.revision}\n\n"
        if (isSupported(node)) {
            for (key in ["label", "locator", "content", "reason", "score", "evidenceClaimIds", "opinionIds"]) {
                if (node.payload.containsKey(key)) {
                    let value = node.payload[key]
                    let body = if (value is JsonString) { value.asString().getValue() } else { value.toString() }
                    text += "输入字段 " + key + "：\n\n> " + safeText(body) + "\n\n"
                }
            }
        } else {
            text += "该类型或版本的业务字段未校验；节点仍保留在本报告中。\n\n"
        }
        if (node.externalRefs.size() > 0) {
            text += "外部库引用（内容未校验）：\n\n> " + safeText(node.externalRefs.toString()) + "\n\n"
        }
        text += renderNodeRelations(node, graph)
    }
    text += "## 全部显式关系\n\n"
    if (graph.edges.isEmpty()) { text += "没有显式关系。\n" }
    for (edge in graph.edges) {
        text += "- " + safeText(edge.id) + " / " + safeText(edge.kind) + "：" + safeText(edge.from) +
            " → " + safeText(edge.to) + "\n"
    }
    text += "\n全部 ${graph.nodes.size} 个节点与 ${graph.edges.size} 条关系均已列出；孤立或未归属节点未被过滤。\n"
    return text
}

func renderNodeRelations(/* 当前报告节点。 */ node: AuditNode, /* 保留输入顺序的全部关系。 */ graph: AuditGraph): String {
    // 为每个节点列出入边和出边，使事实、意见与结论的连接可以人工追溯。
    var text = "显式关联：\n\n"
    var found = false
    for (edge in graph.edges) {
        if (edge.from == node.id || edge.to == node.id) {
            text += "- " + safeText(edge.kind) + "：" + safeText(edge.from) + " → " + safeText(edge.to) + "\n"
            found = true
        }
    }
    if (!found) { text += "无入边或出边；保留该孤立节点供复核。\n" }
    return text + "\n"
}

func renderInvalid(/* 稳定输入错误分类。 */ code: String, /* 可公开的字段定位，空串表示非字段错误。 */ path: String): String {
    // 返回不含原始输入及异常栈的输入错误对象，避免误输出有效核查报告。
    let message = if (code == "INPUT_STRUCTURE") { "输入字段缺失或类型不符合图结构协议。" }
        else if (code == "INPUT_JSON") { "输入不是有效UTF-8 JSON。" }
        else if (code == "INPUT_LIMIT") { "输入超过10 MiB限制。" }
        else if (code == "INPUT_IO") { "无法读取指定输入文件。" }
        else { "用法：evidence-audit --input JSON_FILE" }
    return "{\"protocolVersion\":1,\"status\":\"invalid\",\"error\":{\"code\":" + quoteJson(code) +
        ",\"message\":" + quoteJson(message) + ",\"path\":" + quoteJson(path) + "}}"
}
