package evidence_audit

import std.collection.*
import stdx.encoding.json.*

class Finding {
    public let severity: String
    public let code: String
    public let nodeId: String
    public let edgeId: String
    public let path: String

    public init(/* error或warning。 */ severity: String, /* 稳定诊断编号。 */ code: String,
        /* 关联节点，空串表示无节点。 */ nodeId!: String = "", /* 关联边，空串表示无边。 */ edgeId!: String = "",
        /* 可定位字段的JSON路径。 */ path!: String = "") {
        // 保存结构诊断信息，原始正文不进入错误文案。
        this.severity = severity
        this.code = code
        this.nodeId = nodeId
        this.edgeId = edgeId
        this.path = path
    }
}

class AuditResult {
    public let graph: AuditGraph
    public let byId = HashMap<String, AuditNode>()
    public let successors = HashMap<String, ArrayList<String>>()
    public let findings = ArrayList<Finding>()
    public var claimCount: Int64 = 0
    public var pendingClaimCount: Int64 = 0
    public var unsupportedNodeCount: Int64 = 0
    public var externalReferenceCount: Int64 = 0

    public init(/* 本次检查独占的只读输入图。 */ graph: AuditGraph) {
        // 建立仅用于本次检查的索引，全部状态在该结果对象生命周期内拥有。
        this.graph = graph
    }

    public func run(): Unit {
        // 依次建立身份索引、检查图关系、业务引用和未完成事实。
        indexNodes()
        inspectEdges()
        inspectNodes()
        inspectSuccessorCycles()
        for (node in graph.nodes) {
            if (isSupported(node) && node.typeId == "factcheck.claim") {
                claimCount++
                if (!hasConclusion(node.id)) {
                    pendingClaimCount++
                    findings.add(Finding("warning", "PENDING_CLAIM", nodeId: node.id))
                }
            }
        }
    }

    public func count(/* 要统计的诊断等级。 */ severity: String): Int64 {
        // 统计当前等级数量，避免维护与诊断数组分离的可变计数。
        var total: Int64 = 0
        for (finding in findings) {
            if (finding.severity == severity) { total++ }
        }
        return total
    }

    public func status(): String {
        // 区分结构错误、存在未验证范围和已完成的受支持结构检查。
        if (count("error") > 0) { return "fail" }
        if (count("warning") > 0) { return "warning" }
        return "pass"
    }

    func indexNodes(): Unit {
        // 保留输入节点顺序，并让重复标识显式失败而非覆盖首个节点。
        for (node in graph.nodes) {
            if (byId.contains(node.id)) {
                findings.add(Finding("error", "DUPLICATE_NODE_ID", nodeId: node.id))
            } else {
                byId[node.id] = node
                successors[node.id] = ArrayList<String>()
            }
        }
    }

    func inspectEdges(): Unit {
        // 检查独立的边标识命名空间和端点，再建立合法successor邻接关系。
        let ids = HashSet<String>()
        for (edge in graph.edges) {
            if (ids.contains(edge.id)) {
                findings.add(Finding("error", "DUPLICATE_EDGE_ID", edgeId: edge.id))
            }
            ids.add(edge.id)
            if (edge.kind != "successor" && edge.kind != "reference") {
                findings.add(Finding("error", "INVALID_EDGE_KIND", edgeId: edge.id, path: "/kind"))
            }
            if (!byId.contains(edge.from)) {
                findings.add(Finding("error", "MISSING_EDGE_NODE", edgeId: edge.id, path: "/from"))
            }
            if (!byId.contains(edge.to)) {
                findings.add(Finding("error", "MISSING_EDGE_NODE", edgeId: edge.id, path: "/to"))
            }
            if (edge.kind == "successor" && byId.contains(edge.from) && byId.contains(edge.to)) {
                successors[edge.from].add(edge.to)
            }
        }
    }

    func inspectNodes(): Unit {
        // 先检查所有节点通用引用，再对已支持版本执行有限的核查字段规则。
        for (node in graph.nodes) {
            for (target in node.references) {
                if (!byId.contains(target)) {
                    findings.add(Finding("error", "MISSING_REFERENCE_TARGET", nodeId: node.id, path: "/payloadReferences"))
                }
            }
            if (node.externalRefs.size() > 0) {
                externalReferenceCount += node.externalRefs.size()
                findings.add(Finding("warning", "EXTERNAL_LIBRARY_UNCHECKED", nodeId: node.id, path: "/libraryClaimRefs"))
            }
            if (!isKnownType(node.typeId)) {
                unsupportedNodeCount++
                findings.add(Finding("warning", "UNSUPPORTED_NODE_TYPE", nodeId: node.id))
                continue
            }
            if (node.typeVersion != 1) {
                unsupportedNodeCount++
                findings.add(Finding("warning", "UNSUPPORTED_NODE_VERSION", nodeId: node.id))
                continue
            }
            if (node.typeId == "factcheck.source") { continue }
            if (node.typeId == "factcheck.news" || node.typeId == "factcheck.claim") {
                inspectText(node, "content")
                continue
            }
            inspectText(node, "reason")
            inspectScore(node)
            if (node.typeId == "factcheck.opinion") {
                inspectTypedReferences(node, "evidenceClaimIds", "factcheck.claim", false)
            } else {
                inspectTypedReferences(node, "opinionIds", "factcheck.opinion", true)
            }
        }
    }

    func inspectText(/* 正在检查的已支持节点。 */ node: AuditNode, /* 必需非空正文属性。 */ key: String): Unit {
        // 正文缺失或类型错误属于业务字段错误，仍保留其余图内容供报告。
        if (!node.payload.containsKey(key) || !(node.payload[key] is JsonString)) {
            findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: "/payload/${key}"))
        } else if (node.payload[key].asString().getValue().isEmpty()) {
            findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: "/payload/${key}"))
        }
    }

    func inspectScore(/* 核查意见或结论节点。 */ node: AuditNode): Unit {
        // 只接受定义包v1允许的三个分值，原样保留分数而不重新判断真假。
        if (!node.payload.containsKey("score")) {
            findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: "/payload/score"))
            return
        }
        let value = node.payload["score"]
        var valid = false
        if (value is JsonInt) {
            let score = value.asInt().getValue()
            valid = score == 0 || score == 1
        } else if (value is JsonFloat) {
            let score = value.asFloat().getValue()
            valid = score == 0.0 || score == 0.5 || score == 1.0
        }
        if (!valid) {
            findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: "/payload/score"))
        }
    }

    func inspectTypedReferences(/* 产生业务引用的节点。 */ node: AuditNode, /* 引用列表属性。 */ key: String,
        /* 定义包v1要求的目标类型。 */ targetType: String, /* 结论必须至少引用一条意见。 */ nonempty: Bool): Unit {
        // 检查引用列表及目标类型，不引入同一分支或同一producer的额外限制。
        if (!node.payload.containsKey(key) || !(node.payload[key] is JsonArray)) {
            findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: "/payload/${key}"))
            return
        }
        let values = node.payload[key].asArray()
        if (nonempty && values.size() == 0) {
            findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: "/payload/${key}"))
        }
        let seen = HashSet<String>()
        var i: Int64 = 0
        for (value in values.getItems()) {
            let p = "/payload/${key}/${i}"
            i++
            if (!(value is JsonString)) {
                findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: p))
                continue
            }
            let id = value.asString().getValue()
            if (id.isEmpty() || seen.contains(id)) {
                findings.add(Finding("error", "INVALID_PAYLOAD", nodeId: node.id, path: p))
            }
            seen.add(id)
            if (!byId.contains(id)) {
                findings.add(Finding("error", "MISSING_REFERENCE_TARGET", nodeId: node.id, path: p))
            } else {
                let target = byId[id]
                if (target.typeId != targetType) {
                    findings.add(Finding("error", "REFERENCE_TYPE_MISMATCH", nodeId: node.id, path: p))
                } else if (target.typeVersion != 1) {
                    findings.add(Finding("warning", "UNSUPPORTED_REFERENCE_VERSION", nodeId: node.id, path: p))
                }
            }
        }
    }

    func hasConclusion(/* 要检查后继关系的事实标识。 */ start: String): Bool {
        // 有界遍历successor闭包，reference边和业务引用不代表已产生核查结论。
        let seen = HashSet<String>()
        let queue = ArrayList<String>()
        queue.add(start)
        seen.add(start)
        var index: Int64 = 0
        while (index < queue.size) {
            let id = queue[index]
            index++
            for (next in successors[id]) {
                if (byId[next].typeId == "factcheck.verification" && byId[next].typeVersion == 1) { return true }
                if (!seen.contains(next)) { seen.add(next); queue.add(next) }
            }
        }
        return false
    }

    func inspectSuccessorCycles(): Unit {
        // 用入度消除检查结构环，reference环不进入该检查，避免递归栈受输入深度影响。
        let indegree = HashMap<String, Int64>()
        for ((id, _) in byId) { indegree[id] = 0 }
        for ((_, targets) in successors) {
            for (target in targets) { indegree[target] = indegree[target] + 1 }
        }
        let queue = ArrayList<String>()
        for (node in graph.nodes) {
            if (indegree[node.id] == 0 && !queue.contains(node.id)) { queue.add(node.id) }
        }
        var cursor: Int64 = 0
        while (cursor < queue.size) {
            let id = queue[cursor]
            cursor++
            for (target in successors[id]) {
                indegree[target] = indegree[target] - 1
                if (indegree[target] == 0) { queue.add(target) }
            }
        }
        if (cursor < byId.size) {
            findings.add(Finding("error", "SUCCESSOR_CYCLE"))
        }
    }
}

func isKnownType(/* 数据类型标识，不是转换类型标识。 */ typeId: String): Bool {
    // 声明首版支持的事实核查节点类型集合。
    return typeId == "factcheck.source" || typeId == "factcheck.news" || typeId == "factcheck.claim" ||
        typeId == "factcheck.opinion" || typeId == "factcheck.verification"
}

func isSupported(/* 待确认业务覆盖范围的节点。 */ node: AuditNode): Bool {
    // 仅节点类型版本1参与业务字段检查，转换定义的版本与此无关。
    return isKnownType(node.typeId) && node.typeVersion == 1
}
