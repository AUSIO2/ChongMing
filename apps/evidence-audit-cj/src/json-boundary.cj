package evidence_audit

func hasStandardJsonTokens(/* 已通过UTF-8解码、尚未交给stdx解析的JSON文本。 */ text: String): Bool {
    // 限制stdx默认接受的数字扩展，仅校验词法；对象、数组和分隔符语法仍由stdx处理。
    let bytes = text.toArray()
    var cursor: Int64 = 0
    while (cursor < bytes.size) {
        let byte = bytes[cursor]
        if (isJsonSpace(byte) || isJsonPunctuation(byte)) {
            cursor++
            continue
        }
        if (byte == b'"') {
            cursor = readStringEnd(bytes, cursor + 1)
            if (cursor < 0) { return false }
            continue
        }
        let start = cursor
        while (cursor < bytes.size && !isJsonSpace(bytes[cursor]) && !isJsonPunctuation(bytes[cursor]) && bytes[cursor] != b'"') {
            cursor++
        }
        let token = String.fromUtf8(bytes[start..cursor])
        if (token != "true" && token != "false" && token != "null" && !isJsonNumber(bytes, start, cursor)) {
            return false
        }
    }
    return true
}

func readStringEnd(/* 完整UTF-8输入字节。 */ bytes: Array<UInt8>, /* 起始引号后一字节的位置。 */ start: Int64): Int64 {
    // 检查字符串控制字符与转义，返回结束引号后一位置，非法或未闭合时返回-1。
    var cursor = start
    while (cursor < bytes.size) {
        let byte = bytes[cursor]
        cursor++
        if (byte == b'"') { return cursor }
        if (byte < 0x20) { return -1 }
        if (byte != b'\\') { continue }
        if (cursor >= bytes.size) { return -1 }
        let escape = bytes[cursor]
        cursor++
        if (escape == b'"' || escape == b'\\' || escape == b'/' || escape == b'b' || escape == b'f' ||
            escape == b'n' || escape == b'r' || escape == b't') { continue }
        if (escape != b'u' || cursor + 4 > bytes.size) { return -1 }
        for (index in cursor..cursor + 4) {
            if (!isHexDigit(bytes[index])) { return -1 }
        }
        cursor += 4
    }
    return -1
}

func isJsonNumber(/* 完整输入字节。 */ bytes: Array<UInt8>, /* 数值词素起点。 */ start: Int64,
    /* 数值词素的排他终点。 */ end: Int64): Bool {
    // 按JSON的十进制整数、可选小数和指数规则检查数字，不接受前导加号或其他进制。
    var cursor = start
    if (cursor < end && bytes[cursor] == b'-') { cursor++ }
    if (cursor >= end) { return false }
    if (bytes[cursor] == b'0') {
        cursor++
    } else {
        if (bytes[cursor] < b'1' || bytes[cursor] > b'9') { return false }
        while (cursor < end && isDecimalDigit(bytes[cursor])) { cursor++ }
    }
    if (cursor < end && bytes[cursor] == b'.') {
        cursor++
        let digitsStart = cursor
        while (cursor < end && isDecimalDigit(bytes[cursor])) { cursor++ }
        if (cursor == digitsStart) { return false }
    }
    if (cursor < end && (bytes[cursor] == b'e' || bytes[cursor] == b'E')) {
        cursor++
        if (cursor < end && (bytes[cursor] == b'+' || bytes[cursor] == b'-')) { cursor++ }
        let digitsStart = cursor
        while (cursor < end && isDecimalDigit(bytes[cursor])) { cursor++ }
        if (cursor == digitsStart) { return false }
    }
    return cursor == end
}

func isJsonSpace(/* 待分类的UTF-8单字节。 */ byte: UInt8): Bool {
    // JSON只允许空格、水平制表、回车和换行作为结构空白。
    return byte == b' ' || byte == b'\t' || byte == b'\n' || byte == b'\r'
}

func isJsonPunctuation(/* 待分类的UTF-8单字节。 */ byte: UInt8): Bool {
    // 识别结构标点，具体排列由现有JSON解析器检查。
    return byte == b'{' || byte == b'}' || byte == b'[' || byte == b']' || byte == b',' || byte == b':'
}

func isDecimalDigit(/* 数字词素中的单字节。 */ byte: UInt8): Bool {
    // 区分十进制数字和扩展进制或其他标识字符。
    return byte >= b'0' && byte <= b'9'
}

func isHexDigit(/* Unicode转义中的单字节。 */ byte: UInt8): Bool {
    // Unicode转义固定使用四个ASCII十六进制数字。
    return isDecimalDigit(byte) || (byte >= b'a' && byte <= b'f') || (byte >= b'A' && byte <= b'F')
}
