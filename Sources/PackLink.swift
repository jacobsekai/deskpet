import Foundation

/// Importing a sprite pack from a Google Drive share link, same rules as electron/src/packlink.js. No sign-in needed:
/// Drive serves files shared with "Anyone with the link" to anyone. Only .zip packs, checked before unzipping since
/// the link may come from anyone.
enum PackLink {
    static let maxBytes = 50 * 1024 * 1024
    private static let notShared = DriveError("that file isn't shared yet: in Google Drive, choose Share → General access → \"Anyone with the link\"")
    private static let damaged = DriveError("that .zip looks damaged")

    enum Ref: Equatable {
        case file(String)
        case folder
    }

    static func driveFileID(_ link: String) -> Ref? {
        guard let url = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https",
              let host = url.host, ["drive.google.com", "docs.google.com", "drive.usercontent.google.com"].contains(host) else { return nil }
        if url.path.contains("/folders/") { return .folder }
        let parts = url.path.split(separator: "/").map(String.init)
        let afterD = parts.firstIndex(of: "d").flatMap { $0 + 1 < parts.count ? parts[$0 + 1] : nil }
        guard let id = afterD ?? url.queryItems?.first(where: { $0.name == "id" })?.value, id.count >= 10,
              id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        return .file(id)
    }

    /// Throws unless data is a zip whose entries all stay inside the folder it's unpacked into.
    static func checkZip(_ data: Data) throws {
        let b = [UInt8](data)
        func u16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
        func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
        guard b.count >= 22, u32(0) == 0x04034b50 else { throw DriveError("that link isn't a .zip sprite pack") }
        guard let end = stride(from: b.count - 22, through: max(0, b.count - 65557), by: -1).first(where: { u32($0) == 0x06054b50 }) else { throw damaged }
        var p = u32(end + 16)
        for _ in 0..<u16(end + 10) {
            guard p + 46 <= b.count, u32(p) == 0x02014b50 else { throw damaged }
            let nameLength = u16(p + 28), mode = u32(p + 38) >> 16
            guard p + 46 + nameLength <= b.count else { throw damaged }
            let name = String(decoding: b[(p + 46)..<(p + 46 + nameLength)], as: UTF8.self).replacingOccurrences(of: "\\", with: "/")
            if name.hasPrefix("/") || name.range(of: "^[A-Za-z]:", options: .regularExpression) != nil
                || name.split(separator: "/", omittingEmptySubsequences: false).contains("..") || mode & 0o170000 == 0o120000 {
                throw DriveError("that .zip has an unsafe file in it (\(name))")
            }
            p += 46 + nameLength + u16(p + 30) + u16(p + 32)
        }
    }

    /// The pack name from Drive's Content-Disposition, safe to use as a folder name.
    static func zipName(_ disposition: String?) -> String {
        let d = disposition ?? ""
        func capture(_ pattern: String) -> String? {
            guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
                  let m = re.firstMatch(in: d, range: NSRange(d.startIndex..., in: d)), let r = Range(m.range(at: 1), in: d) else { return nil }
            return String(d[r])
        }
        var name = capture("filename\\*=UTF-8''([^;]+)").flatMap { $0.removingPercentEncoding } ?? capture("filename=\"?([^\";]+)\"?") ?? "drive-pack"
        name = (name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        if name.lowercased().hasSuffix(".zip") { name = String(name.dropLast(4)) }
        name = String(name.map { $0.isLetter || $0.isNumber || " ._-".contains($0) ? $0 : "-" })
        name = String(name.drop { $0 == "." || $0.isWhitespace }).trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "drive-pack" : name
    }

    /// Downloads the linked .zip into a new temp folder and returns its path; the caller imports it and removes the folder.
    static func download(_ link: String) async throws -> URL {
        guard let ref = driveFileID(link) else { throw DriveError("paste a Google Drive share link to a sprite pack .zip") }
        guard case .file(let id) = ref else { throw DriveError("that's a folder link: share the pack's .zip file instead") }
        var req = URLRequest(url: URL(string: "https://drive.usercontent.google.com/download?id=\(id)&export=download&confirm=t")!)
        req.setValue("DeskPet", forHTTPHeaderField: "User-Agent")
        var data = Data()
        let http: HTTPURLResponse?
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: req)
            http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            if status == 401 || status == 403 { throw notShared }
            guard (200..<300).contains(status) else {
                throw DriveError(status == 404 ? "couldn't find that file on Google Drive: check the link, and that it's shared with \"Anyone with the link\""
                                               : "Google Drive said HTTP \(status)")
            }
            // A private file comes back as Google's sign-in page.
            if (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("text/html") { throw notShared }
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBytes { throw DriveError("that pack is over 50 MB") }
            }
        } catch let error as DriveError {
            throw error
        } catch {
            throw DriveError("can't reach Google Drive right now")
        }
        try checkZip(data)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deskpet-link-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(zipName(http?.value(forHTTPHeaderField: "Content-Disposition"))).zip")
        try data.write(to: file)
        return file
    }
}
