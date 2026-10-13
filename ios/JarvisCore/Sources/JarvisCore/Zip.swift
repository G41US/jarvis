import Foundation

/// CRC-32 (the zip / PNG one).
public enum CRC32 {
    static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
        return c
    }
    public static func of(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in data { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }
}

/// A minimal zip writer (entries stored, not compressed): enough for a .docx.
public struct ZipWriter {
    private var body = Data(), central = Data(), count: UInt16 = 0
    public init() {}

    private static func u16(_ v: UInt16) -> Data { var x = v.littleEndian; return Data(bytes: &x, count: 2) }
    private static func u32(_ v: UInt32) -> Data { var x = v.littleEndian; return Data(bytes: &x, count: 4) }

    public mutating func add(_ name: String, _ data: Data) {
        let n = Data(name.utf8), crc = CRC32.of(data), size = UInt32(data.count), offset = UInt32(body.count)
        let dosTime: UInt16 = 0, dosDate: UInt16 = (0 << 9) | (1 << 5) | 1         // 1980-01-01 00:00
        var local = Data()
        local += ZipWriter.u32(0x04034b50); local += ZipWriter.u16(20); local += ZipWriter.u16(0x0800); local += ZipWriter.u16(0)
        local += ZipWriter.u16(dosTime); local += ZipWriter.u16(dosDate)
        local += ZipWriter.u32(crc); local += ZipWriter.u32(size); local += ZipWriter.u32(size)
        local += ZipWriter.u16(UInt16(n.count)); local += ZipWriter.u16(0)
        body += local; body += n; body += data
        var c = Data()
        c += ZipWriter.u32(0x02014b50); c += ZipWriter.u16(20); c += ZipWriter.u16(20); c += ZipWriter.u16(0x0800); c += ZipWriter.u16(0)
        c += ZipWriter.u16(dosTime); c += ZipWriter.u16(dosDate)
        c += ZipWriter.u32(crc); c += ZipWriter.u32(size); c += ZipWriter.u32(size)
        c += ZipWriter.u16(UInt16(n.count)); c += ZipWriter.u16(0); c += ZipWriter.u16(0)
        c += ZipWriter.u16(0); c += ZipWriter.u16(0); c += ZipWriter.u32(0); c += ZipWriter.u32(offset)
        central += c; central += n
        count += 1
    }

    public func finish() -> Data {
        var out = body
        let cdOffset = UInt32(body.count)
        out += central
        out += ZipWriter.u32(0x06054b50); out += ZipWriter.u16(0); out += ZipWriter.u16(0)
        out += ZipWriter.u16(count); out += ZipWriter.u16(count)
        out += ZipWriter.u32(UInt32(central.count)); out += ZipWriter.u32(cdOffset); out += ZipWriter.u16(0)
        return out
    }
}

/// A plain Word document: the title in bold, then one paragraph per line (same XML as the Android version).
public enum Docx {
    static func xml(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    public static func make(title: String, body: String) -> Data {
        var d = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>"
        d += "<w:p><w:pPr><w:spacing w:after=\"240\"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val=\"36\"/></w:rPr><w:t xml:space=\"preserve\">\(xml(title))</w:t></w:r></w:p>"
        for para in body.components(separatedBy: "\n") {
            let p = para.hasSuffix("\r") ? String(para.dropLast()) : para
            d += "<w:p><w:r><w:t xml:space=\"preserve\">\(xml(p))</w:t></w:r></w:p>"
        }
        d += "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\"/></w:sectPr></w:body></w:document>"
        var z = ZipWriter()
        z.add("[Content_Types].xml", Data("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>".utf8))
        z.add("_rels/.rels", Data("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>".utf8))
        z.add("word/document.xml", Data(d.utf8))
        return z.finish()
    }
}

/// Little helpers shared by the app: 16-bit PCM <-> bytes, RMS.
public enum Pcm {
    public static func bytes(_ x: [Int16]) -> Data { x.withUnsafeBufferPointer { Data(buffer: $0) } }   // little-endian on every iPhone
    public static func rms(_ x: [Int16]) -> Float {
        var s = 0.0
        for v in x { s += Double(v) * Double(v) }
        return Float((s / Double(max(1, x.count))).squareRoot())
    }
}
