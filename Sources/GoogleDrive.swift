import AppKit
import CryptoKit
import Foundation
import Network

/// Google Drive sync, same behavior as electron/src/gdrive.js. Signing in uses Google's desktop flow (the browser,
/// a one-time loopback redirect, PKCE). A local folder laid out like a cloud sync folder is mirrored to DeskPet's
/// private app-data space in your Drive, so Sync works on it unchanged; only DeskPet can see those files.
/// Used from the main thread; the async parts run on the main actor too, so state is only touched there.
final class GoogleDrive {
    static let scope = "https://www.googleapis.com/auth/drive.appdata"
    private static let filesURL = "https://www.googleapis.com/drive/v3/files"
    private static let uploadURL = "https://www.googleapis.com/upload/drive/v3/files"
    private static let maxBytes = 5 * 1024 * 1024  // Drive's limit for single-request uploads

    struct Account: Codable {
        var refreshToken: String
        var email: String?
    }

    private struct RemoteFile {
        let id: String
        let name: String
        let md5: String?
        let modifiedTime: String
    }

    /// The folder Sync uses; files live in its DeskPet/ like any cloud folder.
    let dir = DeskPetPaths.root.appendingPathComponent("google-drive")
    var root: URL { dir.appendingPathComponent("DeskPet") }
    private var statePath: URL { dir.appendingPathComponent("state.json") }
    private let accountFile = DeskPetPaths.root.appendingPathComponent("google-account")
    private let own: String
    private let client: (id: String, secret: String)?
    private(set) var account: Account?
    private var access: (token: String, expires: Date)?
    private(set) var error: String?
    private(set) var lastSync: Date?
    private var round: Task<Void, Never>?
    private var finishSignIn: ((Result<(String, String), Error>) -> Void)?
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }

    var available: Bool { client != nil }
    var signedIn: Bool { account != nil }
    var email: String? { account?.email }

    init(deviceID: String) {
        own = "devices/\(deviceID).json"
        client = Self.loadClient()
        account = (try? Data(contentsOf: accountFile)).flatMap { try? JSONDecoder().decode(Account.self, from: $0) }
    }

    /// The "Desktop app" OAuth client from Google Cloud, as downloaded. Kept out of git; build.sh bundles it.
    private static func loadClient() -> (id: String, secret: String)? {
        guard let url = Bundle.main.url(forResource: "google-oauth", withExtension: "json"),
              let obj = (try? Data(contentsOf: url)).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) else { return nil }
        let c = obj["installed"] as? [String: Any] ?? obj
        guard let id = c["client_id"] as? String, let secret = c["client_secret"] as? String else { return nil }
        return (id, secret)
    }

    // MARK: Signing in

    /// Signs in (unless already signed in) and downloads what other devices have, ready for Sync to join.
    @MainActor func signIn() async -> [String: Any] {
        guard let client else { return ["ok": false, "error": "Google sign-in isn't set up in this build of DeskPet."] }
        if account == nil {
            do {
                let (code, redirect, verifier) = try await authorize(clientID: client.id)
                let t = try await tokenRequest(["grant_type": "authorization_code", "code": code, "redirect_uri": redirect, "code_verifier": verifier])
                // Google lets people untick individual permissions on the consent screen.
                guard (t["scope"] as? String ?? "").split(separator: " ").contains(Substring(Self.scope)) else {
                    return ["ok": false, "error": "DeskPet needs permission to keep its sync files in your Google Drive. Sign in again and leave that box ticked."]
                }
                guard let refresh = t["refresh_token"] as? String else { return ["ok": false, "error": "Google didn't send a sign-in token. Try again."] }
                try? FileManager.default.removeItem(at: dir)
                let account = Account(refreshToken: refresh, email: emailFromIDToken(t["id_token"] as? String))
                try save(account)
                self.account = account
                remember(t)
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        }
        await tick()
        if let error { return ["ok": false, "error": error] }
        return ["ok": true, "path": dir.path, "email": email as Any]
    }

    /// Opens Google's sign-in page and waits for the browser to come back to a loopback port with the code.
    @MainActor private func authorize(clientID: String) async throws -> (code: String, redirect: String, verifier: String) {
        cancelSignIn()
        let verifier = randomURLSafe(32), state = randomURLSafe(16)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: params)
        defer { finishSignIn = nil }
        let (code, redirect): (String, String) = try await withCheckedThrowingContinuation { continuation in
            var done = false
            let finish: (Result<(String, String), Error>) -> Void = { result in
                guard !done else { return }
                done = true
                listener.cancel()
                continuation.resume(with: result)
            }
            finishSignIn = finish
            DispatchQueue.main.asyncAfter(deadline: .now() + 300) { finish(.failure(DriveError("Sign-in timed out. Try again."))) }
            listener.newConnectionHandler = { connection in
                connection.start(queue: .main)
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                    let target = data.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                    let url = URLComponents(string: "http://127.0.0.1\(target)")
                    let item = { (name: String) in url?.queryItems?.first { $0.name == name }?.value }
                    guard url?.path == "/", item("state") == state else { return respond(connection, status: "404 Not Found", body: "") }
                    let code = item("code")
                    respond(connection, status: "200 OK", body: donePage(code != nil ? "You're signed in!" : "Sign-in was cancelled."))
                    if let code {
                        finish(.success((code, "http://127.0.0.1:\(listener.port?.rawValue ?? 0)")))
                    } else {
                        finish(.failure(DriveError(item("error") == "access_denied" ? "Sign-in was cancelled." : "Google sign-in failed (\(item("error") ?? "no code")).")))
                    }
                }
            }
            listener.stateUpdateHandler = { listenerState in
                switch listenerState {
                case .ready:
                    guard let port = listener.port?.rawValue else { return }
                    let redirect = "http://127.0.0.1:\(port)"
                    var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
                    c.queryItems = [
                        URLQueryItem(name: "client_id", value: clientID), URLQueryItem(name: "redirect_uri", value: redirect),
                        URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid email \(GoogleDrive.scope)"),
                        URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: challenge),
                        URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "access_type", value: "offline"),
                        URLQueryItem(name: "prompt", value: "consent"),
                    ]
                    if let url = c.url { self.openURL(url) }
                case .failed(let error):
                    finish(.failure(error))
                default:
                    break
                }
            }
            listener.start(queue: .main)
        }
        return (code, redirect, verifier)
    }

    func cancelSignIn() {
        finishSignIn?(.failure(DriveError("Sign-in was cancelled.")))
    }

    private func save(_ account: Account) throws {
        try FileManager.default.createDirectory(at: accountFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(account)
        guard FileManager.default.createFile(atPath: accountFile.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw DriveError("Couldn't save the Google sign-in.")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: accountFile.path)
    }

    /// Before signing out: copy sprite packs that only exist in the mirror into the local sprites folder.
    func bringPacksHome(to local: URL) {
        let fm = FileManager.default
        let synced = root.appendingPathComponent("sprites")
        try? fm.createDirectory(at: local, withIntermediateDirectories: true)
        for name in (try? fm.contentsOfDirectory(atPath: synced.path)) ?? [] where !name.hasPrefix(".") {
            let target = local.appendingPathComponent(name)
            if !fm.fileExists(atPath: target.path) { try? fm.copyItem(at: synced.appendingPathComponent(name), to: target) }
        }
    }

    /// Forgets the account here (Drive keeps the files for other devices) and revokes this device's access.
    @MainActor func signOut() async {
        cancelSignIn()
        let account = self.account
        forget()
        try? FileManager.default.removeItem(at: dir)
        error = nil
        lastSync = nil
        guard let account else { return }
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/revoke")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(formEncode(["token": account.refreshToken]).utf8)
        _ = try? await URLSession.shared.data(for: req)
    }

    private func forget() {
        account = nil
        access = nil
        try? FileManager.default.removeItem(at: accountFile)
    }

    // MARK: Tokens

    @MainActor private func tokenRequest(_ params: [String: String]) async throws -> [String: Any] {
        guard let client else { throw DriveError("Google sign-in isn't set up in this build of DeskPet.") }
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(formEncode(params.merging(["client_id": client.id, "client_secret": client.secret]) { a, _ in a }).utf8)
        let (data, response) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw DriveError(obj["error_description"] as? String ?? obj["error"] as? String ?? "HTTP \(status)", code: obj["error"] as? String)
        }
        return obj
    }

    private func remember(_ t: [String: Any]) {
        access = (t["access_token"] as? String ?? "", Date().addingTimeInterval(t["expires_in"] as? Double ?? 3600))
    }

    @MainActor private func accessToken() async throws -> String {
        if let access, access.expires > Date().addingTimeInterval(60) { return access.token }
        guard let account else { throw DriveError("Signed out of Google. Sign in again.") }
        let t: [String: Any]
        do {
            t = try await tokenRequest(["grant_type": "refresh_token", "refresh_token": account.refreshToken])
        } catch let e as DriveError where e.code == "invalid_grant" {
            forget()
            throw DriveError("Google sign-in expired or was removed. Sign in again.")
        }
        remember(t)
        return access?.token ?? ""
    }

    // MARK: Mirroring

    /// One mirror round; overlapping calls wait for the one already running.
    @MainActor func tick() async {
        if let round { return await round.value }
        let task = Task { await mirrorOnce() }
        round = task
        await task.value
        round = nil
    }

    @MainActor private func mirrorOnce() async {
        guard account != nil else {
            error = "Signed out of Google. Sign in again."
            return
        }
        do {
            let state = (try? Data(contentsOf: statePath)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let r = try await mirror(state: state)
            try JSONEncoder().encode(r.state).write(to: statePath, options: .atomic)
            lastSync = Date()
            error = r.skipped.isEmpty ? nil : "Not synced (over 5 MB): \(r.skipped.joined(separator: ", "))"
        } catch is URLError {
            error = "Can't reach Google Drive right now. DeskPet will keep trying."
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Two-way mirroring between root and Drive. state is each file's md5 as of the last round, so whichever
    /// side changed since then wins; when both did, this device's own file goes up and everything else comes down.
    @MainActor private func mirror(state: [String: String]) async throws -> (state: [String: String], skipped: [String]) {
        var remote: [String: RemoteFile] = [:]
        for f in try await list() {
            guard let seen = remote[f.name] else {
                remote[f.name] = f
                continue
            }
            // Two devices uploaded the same new file at once: keep the newer copy.
            let (keep, drop) = seen.modifiedTime >= f.modifiedTime ? (seen, f) : (f, seen)
            remote[f.name] = keep
            try await remove(drop.id)
        }
        var local: [String: String] = [:]
        scanFolder(root, into: &local)
        var next: [String: String] = [:]
        var skipped: [String] = []
        for name in Set(local.keys).union(remote.keys).union(state.keys).sorted() {
            let base = state[name], mine = local[name], file = remote[name], theirs = file?.md5
            if mine == theirs {
                if let mine { next[name] = mine }
                continue
            }
            let localChanged = mine != base, remoteChanged = theirs != base
            let push = localChanged && remoteChanged ? mine != nil && (theirs == nil || name == own) : localChanged
            let url = root.appendingPathComponent(name)
            if push, mine == nil, let file {
                try await remove(file.id)
            } else if push {
                let data = try Data(contentsOf: url)
                if data.count > Self.maxBytes {
                    skipped.append(name)
                    if let base { next[name] = base }
                    continue
                }
                if let file { try await update(file.id, data) } else { try await create(name, data) }
                next[name] = mine
            } else if let file {
                let data = try await download(file.id)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
                next[name] = theirs
            } else {
                removeLocal(name)
            }
        }
        return (next, skipped)
    }

    private func removeLocal(_ name: String) {
        try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
        // A sprite pack removed on another device leaves empty folders behind.
        var folder = (name as NSString).deletingLastPathComponent
        while !folder.isEmpty {
            let path = root.appendingPathComponent(folder).path
            guard (try? FileManager.default.contentsOfDirectory(atPath: path))?.isEmpty == true else { break }
            try? FileManager.default.removeItem(atPath: path)
            folder = (folder as NSString).deletingLastPathComponent
        }
    }

    // MARK: Drive v3, limited to the appDataFolder space

    @MainActor private func request(_ url: URL, method: String = "GET", contentType: String? = nil, body: Data? = nil, allowMissing: Bool = false) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) || (allowMissing && status == 404) { return data }
        let detail = (((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
        throw DriveError("Google Drive: \(detail ?? "HTTP \(status)")")
    }

    @MainActor private func list() async throws -> [RemoteFile] {
        var files: [RemoteFile] = []
        var page: String?
        repeat {
            var c = URLComponents(string: Self.filesURL)!
            c.queryItems = [URLQueryItem(name: "spaces", value: "appDataFolder"), URLQueryItem(name: "pageSize", value: "1000"),
                            URLQueryItem(name: "fields", value: "nextPageToken,files(id,name,md5Checksum,modifiedTime)")]
            if let page { c.queryItems?.append(URLQueryItem(name: "pageToken", value: page)) }
            let obj = try JSONSerialization.jsonObject(with: try await request(c.url!)) as? [String: Any] ?? [:]
            for f in obj["files"] as? [[String: Any]] ?? [] {
                guard let id = f["id"] as? String, let name = f["name"] as? String else { continue }
                files.append(RemoteFile(id: id, name: name, md5: f["md5Checksum"] as? String, modifiedTime: f["modifiedTime"] as? String ?? ""))
            }
            page = obj["nextPageToken"] as? String
        } while page != nil
        return files
    }

    @MainActor private func download(_ id: String) async throws -> Data {
        try await request(URL(string: "\(Self.filesURL)/\(id)?alt=media")!)
    }

    @MainActor private func create(_ name: String, _ data: Data) async throws {
        let boundary = "deskpet-\(randomURLSafe(8))"
        let meta = try JSONSerialization.data(withJSONObject: ["name": name, "parents": ["appDataFolder"]])
        var body = Data("--\(boundary)\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".utf8)
        body += meta
        body += Data("\r\n--\(boundary)\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        body += data
        body += Data("\r\n--\(boundary)--".utf8)
        _ = try await request(URL(string: "\(Self.uploadURL)?uploadType=multipart&fields=id")!, method: "POST",
                              contentType: "multipart/related; boundary=\(boundary)", body: body)
    }

    @MainActor private func update(_ id: String, _ data: Data) async throws {
        _ = try await request(URL(string: "\(Self.uploadURL)/\(id)?uploadType=media&fields=id")!, method: "PATCH",
                              contentType: "application/octet-stream", body: data)
    }

    @MainActor private func remove(_ id: String) async throws {
        _ = try await request(URL(string: "\(Self.filesURL)/\(id)")!, method: "DELETE", allowMissing: true)
    }
}

struct DriveError: LocalizedError {
    let message: String
    var code: String?
    init(_ message: String, code: String? = nil) {
        self.message = message
        self.code = code
    }
    var errorDescription: String? { message }
}

/// Files under dir as ["devices/x.json": md5], leaving out dotfiles and half-written .tmp files.
private func scanFolder(_ dir: URL, _ rel: String = "", into out: inout [String: String]) {
    let fm = FileManager.default
    let here = rel.isEmpty ? dir : dir.appendingPathComponent(rel)
    for item in (try? fm.contentsOfDirectory(atPath: here.path)) ?? [] where !item.hasPrefix(".") && !item.hasSuffix(".tmp") {
        let name = rel.isEmpty ? item : "\(rel)/\(item)"
        let path = dir.appendingPathComponent(name).path
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir) else { continue }
        if isDir.boolValue {
            scanFolder(dir, name, into: &out)
        } else if let data = fm.contents(atPath: path) {
            out[name] = Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
    }
}

private func respond(_ connection: NWConnection, status: String, body: String) {
    let data = Data(body.utf8)
    let head = "HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n"
    connection.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
}

private func donePage(_ text: String) -> String {
    """
    <!doctype html><meta charset="utf-8"><title>DeskPet</title>
    <body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#fdf6ee;color:#3a2d25">
    <div style="text-align:center"><div style="font-size:56px">🐾</div><h2>\(text)</h2><p>You can close this tab and go back to DeskPet.</p></div>
    """
}

private func randomURLSafe(_ bytes: Int) -> String {
    var data = Data(count: bytes)
    _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
    return data.base64URL
}

private func formEncode(_ params: [String: String]) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return params.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
}

/// Straight from Google's token endpoint over HTTPS, and only shown in the panel.
private func emailFromIDToken(_ token: String?) -> String? {
    guard let part = token?.split(separator: ".").dropFirst().first else { return nil }
    var b64 = part.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
    guard let data = Data(base64Encoded: b64), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj["email"] as? String
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
