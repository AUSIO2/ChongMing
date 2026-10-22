package evidence_audit

import std.collection.*
import stdx.encoding.json.*

class InputFailure <: Exception {
    public let fieldPath: String

    public init(/* 不能继续结构检查的输入字段路径，不包含输入正文。 */ fieldPath: String) {
        // 保存可公开定位的字段路径，避免解析器异常泄露输入正文。
        super("输入字段缺失或类型不符合图结构协议")
        this.fieldPath = fieldPath
    }
}

class AuditNode {
    public let id: String
    public let revision: Int64
    public let typeId: String
    public let typeVersion: Int64
    public let payload: JsonObject
    public let references: ArrayList<String>
    public let externalRefs: JsonArray

    public init(/* 已经通过基础字段检查的节点对象。 */ value: JsonObject, /* 输入节点的数组位置。 */ index: Int64) {
        // 只解析检查与报告需要的节点字段，不对运行元信息或完整业务模式作保证。
        let p = "/nodes/${index}"
        id = readText(value, "id", p)
        revision = readNatural(value, "revision", p)
        typeId = readText(value, "typeId", p)
        typeVersion = readNatural(value, "typeVersion", p)
        payload = readObject(value, "payload", p)
        references = ArrayList<String>()
        if (value.containsKey("payloadReferences")) {
            let refs = readArray(value, "payloadReferences", p)
            var i: Int64 = 0
            for (item in refs.getItems()) {
                let ref = requireObject(item, "${p}/payloadReferences/${i}")
                readText(ref, "path", "${p}/payloadReferences/${i}")
                references.add(readText(ref, "targetId", "${p}/payloadReferences/${i}"))
                i++
            }
        }
        externalRefs = if (value.containsKey("libraryClaimRefs")) {
            readArray(value, "libraryClaimRefs", p)
        } else {
            JsonArray()
        }
        var i: Int64 = 0
        for (item in externalRefs.getItems()) {
            requireObject(item, "${p}/libraryClaimRefs/${i}")
            i++
        }
    }
}

class AuditEdge {
    public let id: String
    public let kind: String
    public let from: String
    public let to: String

    public init(/* 已通过对象类型检查的边记录。 */ value: JsonObject, /* 输入边的数组位置。 */ index: Int64) {
        // 保留边类型供检查阶段报告未知类型，不把异常边静默忽略。
        let p = "/edges/${index}"
        id = readText(value, "id", p)
        kind = readText(value, "kind", p)
        from = readText(value, "from", p)
        to = readText(value, "to", p)
    }
}

class AuditGraph {
    public let mapId: String
    public let workspaceId: String
    public let name: String
    public let revision: Int64
    public let nodes = ArrayList<AuditNode>()
    public let edges = ArrayList<AuditEdge>()

    public init(/* 完整快照或含核心图字段的历史投影。 */ value: JsonValue) {
        // 按图核心字段读取节点与关系，允许快照携带本模块未使用的额外字段。
        let object = requireObject(value, "")
        mapId = readText(object, "mapId", "")
        workspaceId = readText(object, "workspaceId", "")
        name = readText(object, "name", "", allowEmpty: true)
        revision = readNatural(object, "revision", "")
        var i: Int64 = 0
        for (node in readArray(object, "nodes", "").getItems()) {
            nodes.add(AuditNode(requireObject(node, "/nodes/${i}"), i))
            i++
        }
        i = 0
        for (edge in readArray(object, "edges", "").getItems()) {
            edges.add(AuditEdge(requireObject(edge, "/edges/${i}"), i))
            i++
        }
    }
}

func requireObject(/* 未经过对象校验的JSON值。 */ value: JsonValue, /* 用于诊断的JSON路径。 */ path: String): JsonObject {
    // 拒绝数组和标量，避免把非法输入当作空对象。
    if (!(value is JsonObject)) { throw InputFailure(path) }
    return value.asObject()
}

func readObject(/* 父级JSON对象。 */ object: JsonObject, /* 必需对象字段。 */ key: String, /* 父级字段路径。 */ path: String): JsonObject {
    // 读取必需的对象字段并定位缺失或类型问题。
    if (!object.containsKey(key)) { throw InputFailure("${path}/${key}") }
    return requireObject(object[key], "${path}/${key}")
}

func readArray(/* 父级JSON对象。 */ object: JsonObject, /* 必需数组字段。 */ key: String, /* 父级字段路径。 */ path: String): JsonArray {
    // 读取数组字段，不对错误类型应用空数组默认值。
    if (!object.containsKey(key) || !(object[key] is JsonArray)) { throw InputFailure("${path}/${key}") }
    return object[key].asArray()
}

func readText(/* 父级JSON对象。 */ object: JsonObject, /* 必需文本字段。 */ key: String, /* 父级字段路径。 */ path: String,
    /* 仅图名称允许合法空串。 */ allowEmpty!: Bool = false): String {
    // 读取文本并按协议拒绝缺失、错误类型或空标识。
    if (!object.containsKey(key) || !(object[key] is JsonString)) { throw InputFailure("${path}/${key}") }
    let text = object[key].asString().getValue()
    if (!allowEmpty && text.isEmpty()) { throw InputFailure("${path}/${key}") }
    return text
}

func readNatural(/* 父级JSON对象。 */ object: JsonObject, /* 必需非负整数字段。 */ key: String, /* 父级字段路径。 */ path: String): Int64 {
    // 按JSON数值语义接受非负安全整数，允许1.0或1e0并防止Node与仓颉往返丢失精度。
    if (!object.containsKey(key)) { throw InputFailure("${path}/${key}") }
    let value = object[key]
    if (value is JsonInt) {
        let number = value.asInt().getValue()
        if (number < 0 || number > 9007199254740991) { throw InputFailure("${path}/${key}") }
        return number
    }
    if (value is JsonFloat) {
        let number = value.asFloat().getValue()
        if (number.isNaN() || number.isInf() || number < 0.0 || number > 9007199254740991.0) {
            throw InputFailure("${path}/${key}")
        }
        let integer = Int64(number)
        if (Float64(integer) != number) { throw InputFailure("${path}/${key}") }
        return integer
    }
    throw InputFailure("${path}/${key}")
}
