import AppKit
import ImageIO

/// A folder of images that replaces the built-in cat.
///
/// Files are named after moods: `idle.png`, `typing.gif`, or numbered frames
/// `typing_1.png`, `typing_2.png`, … Missing moods fall back to similar ones, then to `idle`.
/// Optional `pack.json` tunes size, speed, and background removal (see README).
final class SpritePack {
    struct Frame {
        let image: CGImage
        let duration: Double
        /// Top of the head: center x and width as fractions of the image width (for hats).
        var headX: CGFloat = 0.5
        var headWidth: CGFloat = 0.5
        /// How far down from the top of the image the head starts (fraction of the height).
        var headTop: CGFloat = 0
    }

    struct MoodSettings {
        var scale: CGFloat = 1
        var offset = CGPoint.zero
        var fps: Double?
        /// Seconds per frame, e.g. [3, 0.25] to hold frame 1 and flash frame 2 as a blink. The last value repeats.
        var durations: [Double]?
    }

    let name: String
    let directory: URL
    /// On-screen height of the idle sprite, in points.
    let height: CGFloat
    let effects: Bool
    let bounce: Bool
    let pixelated: Bool
    let facesLeft: Bool
    private let fps: Double
    private let pointsPerPixel: CGFloat
    private var animations: [Mood: [Frame]] = [:]
    private var settings: [Mood: MoodSettings] = [:]

    /// ~/.deskpet/sprites, or the cloud sync folder's sprites when "sync sprite packs" is on.
    static var root: URL {
        let d = UserDefaults.standard
        if d.bool(forKey: "syncPacks"), let folder = d.string(forKey: "syncFolder") {
            return URL(fileURLWithPath: folder).appendingPathComponent("DeskPet/sprites")
        }
        return DeskPetPaths.root.appendingPathComponent("sprites")
    }

    static func available() -> [String] {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return dirs.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map(\.lastPathComponent).sorted()
    }

    /// Latest modification time of anything in the pack, used to hot-reload while you iterate on art.
    static func fingerprint(_ name: String) -> Date {
        let dir = root.appendingPathComponent(name)
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
            .max() ?? .distantPast
    }

    init(name: String) throws {
        self.name = name
        directory = Self.root.appendingPathComponent(name)

        let options = (try? Data(contentsOf: directory.appendingPathComponent("pack.json")))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        height = min(220, max(40, options["height"] as? CGFloat ?? 120))
        fps = max(0.5, options["fps"] as? Double ?? 6)
        effects = options["effects"] as? Bool ?? true
        bounce = options["bounce"] as? Bool ?? true
        pixelated = options["pixelated"] as? Bool ?? false
        facesLeft = (options["facing"] as? String)?.lowercased() == "left"
        let tolerance = options["tolerance"] as? Int ?? 40
        let removeBackground: Bool = {
            if let b = options["removeBackground"] as? Bool { return b }
            return options["removeBackground"] is String
        }()

        for (key, value) in options["moods"] as? [String: [String: Any]] ?? [:] {
            guard let mood = Self.mood(named: key) else { continue }
            settings[mood] = MoodSettings(
                scale: value["scale"] as? CGFloat ?? 1,
                offset: CGPoint(x: value["offsetX"] as? CGFloat ?? 0, y: value["offsetY"] as? CGFloat ?? 0),
                fps: value["fps"] as? Double,
                durations: (value["durations"] as? [Double]).flatMap { $0.isEmpty ? nil : $0.map { max(0.02, $0) } })
        }

        // Group images by mood, ordered by frame number.
        typealias Entry = (index: Int, frames: [(image: CGImage, duration: Double?)], removeBackground: Bool)
        var fromFiles: [Mood: [Entry]] = [:]
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for url in files where ["png", "gif", "webp", "jpg", "jpeg", "heic"].contains(url.pathExtension.lowercased()) {
            let (base, index) = Self.splitFrameNumber(url.deletingPathExtension().lastPathComponent)
            guard let mood = Self.mood(named: base) else { continue }
            fromFiles[mood, default: []].append((index, Self.loadFrames(url), removeBackground))
        }
        // Spritesheet cells have flat backgrounds, so they get background removal unless explicitly disabled.
        var fromSheets: [Mood: [Entry]] = [:]
        let sheetRemoveBackground = options["removeBackground"] as? Bool ?? true
        for spec in Self.sheetSpecs(options, directory: directory) {
            for cell in Self.slice(spec, in: directory, tolerance: tolerance)?.cells ?? [] {
                let (base, index) = Self.splitFrameNumber(cell.name)
                guard let mood = Self.mood(named: base) else { continue }
                fromSheets[mood, default: []].append((index, [(cell.image, nil)], sheetRemoveBackground))
            }
        }
        // A loose file replaces that mood's sheet cells, so you can fix one bad pose without regenerating the sheet.
        let grouped = fromSheets.merging(fromFiles) { _, files in files }

        for (mood, entries) in grouped {
            let moodFPS = settings[mood]?.fps ?? fps
            var processed: [(CGImage, CGRect, Double, CGRect)] = []
            for entry in entries.sorted(by: { $0.index < $1.index }) {
                for f in entry.frames {
                    guard let p = Self.process(f.image, removeBackground: entry.removeBackground, tolerance: tolerance) else { continue }
                    processed.append((p.image, p.bounds, f.duration ?? 1 / moodFPS, p.head))
                }
            }
            guard !processed.isEmpty else { continue }
            if let durations = settings[mood]?.durations {
                for i in processed.indices { processed[i].2 = durations[min(i, durations.count - 1)] }
            }
            // Crop every frame to the union of their content so animations don't jitter.
            let sameSize = Set(processed.map { "\($0.0.width)x\($0.0.height)" }).count == 1
            let union = processed.map(\.1).reduce(processed[0].1) { $0.union($1) }
            animations[mood] = processed.compactMap { image, bounds, duration, head in
                let crop = sameSize ? union : bounds
                guard let cropped = image.cropping(to: crop) else { return nil }
                return Frame(image: cropped, duration: duration,
                             headX: (head.midX - crop.minX) / crop.width, headWidth: head.width / crop.width,
                             headTop: max(0, head.minY - crop.minY) / crop.height)
            }
        }

        guard let idle = animations[.idle]?.first else {
            throw NSError(domain: "DeskPet", code: 1, userInfo: [NSLocalizedDescriptionKey: "no idle image in \(name)"])
        }
        // Every mood uses idle's pixel density, so poses keep a consistent size relative to each other.
        pointsPerPixel = height / CGFloat(idle.image.height)
    }

    private func currentFrame(_ resolved: Mood, at t: Double) -> Frame {
        let frames = animations[resolved]!
        let total = frames.reduce(0) { $0 + $1.duration }
        var remaining = fmod(t, max(total, 0.001))
        for f in frames {
            if remaining < f.duration { return f }
            remaining -= f.duration
        }
        return frames[0]
    }

    /// Where the head is in the current frame (fractions of the frame width), for placing hats.
    func head(for mood: Mood, at t: Double) -> (x: CGFloat, width: CGFloat, top: CGFloat) {
        let f = currentFrame(resolve(mood), at: t)
        return (f.headX, f.headWidth, f.headTop)
    }

    /// The image to show for a mood at time `t`, with its size and offset in points.
    func frame(for mood: Mood, at t: Double) -> (image: CGImage, size: NSSize, offset: CGPoint) {
        let resolved = resolve(mood)
        let frame = currentFrame(resolved, at: t)
        let s = settings[resolved] ?? MoodSettings()
        let size = NSSize(width: CGFloat(frame.image.width) * pointsPerPixel * s.scale,
                          height: CGFloat(frame.image.height) * pointsPerPixel * s.scale)
        return (frame.image, size, s.offset)
    }

    /// Whether the pack has its own images for this mood (rather than falling back).
    func hasArt(for mood: Mood) -> Bool { animations[mood] != nil }

    private func resolve(_ mood: Mood) -> Mood {
        for candidate in [mood] + (Self.fallbacks[mood] ?? []) where animations[candidate] != nil { return candidate }
        return .idle
    }

    private static let fallbacks: [Mood: [Mood]] = [
        .walking: [.idle],
        .sleepy: [.sleeping],
        .startled: [.dragged, .needsYou],
        .dragged: [.startled],
        .flying: [.dragged, .startled],
        .dizzy: [.error, .oops, .startled],
        .userTyping: [.idle],
        .petted: [.done],
        .done: [.petted],
        .typing: [.thinking],
        .reading: [.searching, .thinking],
        .searching: [.reading, .thinking],
        .delegating: [.typing, .thinking],
        .tidying: [.typing, .thinking],
        .oops: [.error, .startled],
        .error: [.oops, .startled],
        .needsYou: [.startled],
    ]

    private static let moodNames: [String: Mood] = [
        "idle": .idle, "walking": .walking, "walk": .walking, "sleepy": .sleepy, "sleeping": .sleeping, "sleep": .sleeping,
        "petted": .petted, "happy": .petted, "dragged": .dragged, "flying": .flying, "thrown": .flying, "dizzy": .dizzy, "startled": .startled, "surprised": .startled,
        "usertyping": .userTyping, "thinking": .thinking, "typing": .typing, "working": .typing,
        "reading": .reading, "searching": .searching, "delegating": .delegating, "needsyou": .needsYou,
        "attention": .needsYou, "done": .done, "celebrate": .done, "oops": .oops, "error": .error, "tidying": .tidying,
    ]

    static func mood(named name: String) -> Mood? {
        moodNames[name.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")]
    }

    /// "typing_2" -> ("typing", 2); "idle" -> ("idle", 0)
    static func splitFrameNumber(_ s: String) -> (String, Int) {
        let digits = s.reversed().prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count < s.count else { return (s, 0) }
        var base = String(s.dropLast(digits.count))
        if base.hasSuffix("_") || base.hasSuffix("-") { base.removeLast() }
        return (base, Int(String(digits.reversed())) ?? 0)
    }

    /// Frames of an image file; `duration` is set only for animated GIFs.
    private static func loadFrames(_ url: URL) -> [(image: CGImage, duration: Double?)] {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return [] }
        return (0..<CGImageSourceGetCount(source)).compactMap { i in
            guard let image = CGImageSourceCreateImageAtIndex(source, i, nil) else { return nil }
            let props = CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [CFString: Any]
            let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double)
            return (image, delay.map { max(0.02, $0) })
        }
    }

    /// Optionally flood-fills the background (from the image edges) to transparent, and finds the content bounds.
    static func process(_ image: CGImage, removeBackground: Bool, tolerance: Int) -> (image: CGImage, bounds: CGRect, head: CGRect)? {
        let w = image.width, h = image.height
        guard let (ctx, px) = rgba(image) else { return nil }

        if removeBackground && px[3] > 200 {
            let ref = (Int(px[0]), Int(px[1]), Int(px[2]))
            var visited = [Bool](repeating: false, count: w * h)
            var stack: [Int] = []
            for x in 0..<w { stack.append(x); stack.append((h - 1) * w + x) }
            for y in 0..<h { stack.append(y * w); stack.append(y * w + w - 1) }
            while let i = stack.popLast() {
                if visited[i] { continue }
                visited[i] = true
                let o = i * 4
                guard abs(Int(px[o]) - ref.0) <= tolerance, abs(Int(px[o + 1]) - ref.1) <= tolerance,
                      abs(Int(px[o + 2]) - ref.2) <= tolerance else { continue }
                px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0
                let x = i % w, y = i / w
                if x > 0 { stack.append(i - 1) }
                if x < w - 1 { stack.append(i + 1) }
                if y > 0 { stack.append(i - w) }
                if y < h - 1 { stack.append(i + w) }
            }
        }

        // Content bounds in top-left-origin pixel coordinates (bitmap row 0 is the top row).
        var minX = w, minY = h, maxX = -1, maxY = -1
        for y in 0..<h {
            for x in 0..<w where px[(y * w + x) * 4 + 3] > 8 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, let result = ctx.makeImage() else { return nil }
        // The head: the first row from the top that's wide (raised hands, ears, and stray hairs are
        // narrow), then the widest solid span across the next ~12% of the character.
        func longestRun(_ y: Int) -> (start: Int, end: Int)? {
            var best: (Int, Int)?, start = -1
            for x in minX...(maxX + 1) {
                let solid = x <= maxX && px[(y * w + x) * 4 + 3] > 100
                if solid && start < 0 { start = x }
                if !solid && start >= 0 {
                    if best == nil || x - 1 - start > best!.1 - best!.0 { best = (start, x - 1) }
                    start = -1
                }
            }
            return best
        }
        let widthNeeded = max(3, Int(Double(maxX - minX + 1) * 0.25))
        var headTop = minY
        for y in minY...maxY {
            if let run = longestRun(y), run.end - run.start + 1 >= widthNeeded { headTop = y; break }
        }
        let headRows = max(2, Int(Double(maxY - minY) * 0.12))
        var hMin = maxX, hMax = minX
        for y in headTop...min(maxY, headTop + headRows) {
            if let run = longestRun(y) { hMin = min(hMin, run.start); hMax = max(hMax, run.end) }
        }
        if hMax < hMin { (hMin, hMax) = (minX, maxX) }
        return (result, CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1),
                CGRect(x: hMin, y: headTop, width: hMax - hMin + 1, height: headRows))
    }
}

// MARK: - Spritesheets

extension SpritePack {
    struct SheetSpec {
        let file: String
        let columns: Int
        let rows: Int
        /// Mood/frame names in reading order; "" skips a cell.
        let cells: [String]
        /// "auto" finds poses by the empty gaps between them; "grid" splits into equal cells.
        let mode: String
    }

    /// The default 4x4 sheet layout (see README).
    static let defaultCells = [
        "idle_1", "idle_2", "typing_1", "typing_2",
        "thinking", "needs-you", "done", "petted",
        "sleeping", "sleepy", "dragged", "startled",
        "reading", "searching", "oops", "error",
    ]

    /// Sheets come from `"sheet"`/`"sheets"` in pack.json, or a bare `sheet.png` using the default 4x4 layout.
    static func sheetSpecs(_ options: [String: Any], directory: URL) -> [SheetSpec] {
        var raw: [[String: Any]] = []
        if let one = options["sheet"] as? [String: Any] { raw = [one] }
        else if let file = options["sheet"] as? String { raw = [["file": file]] }
        else if let many = options["sheets"] as? [[String: Any]] { raw = many }
        else if FileManager.default.fileExists(atPath: directory.appendingPathComponent("sheet.png").path) { raw = [["file": "sheet.png"]] }

        return raw.map { d in
            var cells = defaultCells
            if let rows = d["cells"] as? [[Any]] { cells = rows.flatMap { $0.map { $0 as? String ?? "" } } }
            else if let flat = d["cells"] as? [Any] { cells = flat.map { $0 as? String ?? "" } }
            let columns = max(1, d["columns"] as? Int ?? 4)
            let rows = max(1, d["rows"] as? Int ?? Int((Double(cells.count) / Double(columns)).rounded(.up)))
            return SheetSpec(file: d["file"] as? String ?? "sheet.png", columns: columns, rows: rows,
                             cells: cells, mode: (d["mode"] as? String ?? "auto").lowercased())
        }
    }

    /// Cuts a sheet into named cell images (top-left-origin pixel rects, reading order).
    static func slice(_ spec: SheetSpec, in directory: URL, tolerance: Int)
        -> (cells: [(name: String, image: CGImage)], autoDetected: Bool)? {
        let url = directory.appendingPathComponent(spec.file)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let sheet = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let detected = spec.mode == "grid" ? nil : detectCells(sheet, columns: spec.columns, rows: spec.rows, tolerance: tolerance)
        let rects = detected ?? equalGrid(width: sheet.width, height: sheet.height, columns: spec.columns, rows: spec.rows)
        let cells = zip(spec.cells, rects).compactMap { name, rect -> (String, CGImage)? in
            guard !name.isEmpty, let image = sheet.cropping(to: rect) else { return nil }
            return (name, image)
        }
        return (cells, detected != nil)
    }

    private static func equalGrid(width: Int, height: Int, columns: Int, rows: Int) -> [CGRect] {
        let cw = CGFloat(width) / CGFloat(columns), ch = CGFloat(height) / CGFloat(rows)
        return (0..<rows).flatMap { r in
            (0..<columns).map { c in CGRect(x: CGFloat(c) * cw, y: CGFloat(r) * ch, width: cw, height: ch).integral }
        }
    }

    /// Finds rows of poses by horizontal empty bands, then poses within each row by vertical empty gaps.
    /// Returns nil (use the equal grid) unless exactly `rows` rows are found; a row with the wrong number
    /// of poses is split evenly instead.
    private static func detectCells(_ sheet: CGImage, columns: Int, rows: Int, tolerance: Int) -> [CGRect]? {
        // The context owns the pixel memory, so it must stay alive while `px` is read.
        guard let (ctx, px) = rgba(sheet) else { return nil }
        defer { withExtendedLifetime(ctx) {} }
        let w = sheet.width, h = sheet.height
        let background = (Int(px[0]), Int(px[1]), Int(px[2]), Int(px[3]))
        func isContent(_ x: Int, _ y: Int) -> Bool {
            let o = (y * w + x) * 4
            if px[o + 3] < 8 { return false }
            if background.3 < 200 { return true }
            return abs(Int(px[o]) - background.0) > tolerance || abs(Int(px[o + 1]) - background.1) > tolerance
                || abs(Int(px[o + 2]) - background.2) > tolerance
        }

        var mask = [Bool](repeating: false, count: w * h)
        var rowCounts = [Int](repeating: 0, count: h)
        for y in 0..<h {
            for x in 0..<w where isContent(x, y) {
                mask[y * w + x] = true
                rowCounts[y] += 1
            }
        }
        let bands = runs(rowCounts, noise: max(1, w / 500), minGap: max(2, h / 60), minLength: max(4, h / (rows * 5)))
        guard bands.count == rows else { return nil }

        let margin = 4
        var rects: [CGRect] = []
        for band in bands {
            var colCounts = [Int](repeating: 0, count: w)
            for y in band { for x in 0..<w where mask[y * w + x] { colCounts[x] += 1 } }
            var spans = runs(colCounts, noise: 1, minGap: max(2, w / 60), minLength: max(4, w / (columns * 5)))
            if spans.count != columns {
                let cw = w / columns
                spans = (0..<columns).map { $0 * cw ..< ($0 + 1) * cw }
            }
            for span in spans {
                let x0 = max(0, span.lowerBound - margin), x1 = min(w, span.upperBound + margin)
                let y0 = max(0, band.lowerBound - margin), y1 = min(h, band.upperBound + margin)
                rects.append(CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
            }
        }
        return rects
    }

    /// Ranges where `counts` exceeds `noise`, merging ranges separated by less than `minGap`
    /// and dropping ones shorter than `minLength` (stray specks).
    private static func runs(_ counts: [Int], noise: Int, minGap: Int, minLength: Int) -> [Range<Int>] {
        var result: [Range<Int>] = []
        var start: Int?
        for (i, c) in counts.enumerated() {
            if c >= noise { if start == nil { start = i } }
            else if let s = start { result.append(s..<i); start = nil }
        }
        if let s = start { result.append(s..<counts.count) }

        var merged: [Range<Int>] = []
        for r in result {
            if let last = merged.last, r.lowerBound - last.upperBound < minGap {
                merged[merged.count - 1] = last.lowerBound..<r.upperBound
            } else {
                merged.append(r)
            }
        }
        return merged.filter { $0.count >= minLength }
    }

    /// Draws an image into an RGBA8 buffer. Bitmap row 0 is the top row.
    static func rgba(_ image: CGImage) -> (CGContext, UnsafeMutablePointer<UInt8>)? {
        let w = image.width, h = image.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = ctx.data else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return (ctx, data.bindMemory(to: UInt8.self, capacity: w * h * 4))
    }

    /// `DeskPet slice <pack>`: writes each cut-out pose to <pack>/sliced/ so you can check the result.
    static func runSliceCommand(_ args: [String]) -> Never {
        guard args.count > 2 else {
            print("usage: DeskPet slice <pack name or folder>")
            exit(1)
        }
        let arg = (args[2] as NSString).expandingTildeInPath
        let dir = arg.contains("/") ? URL(fileURLWithPath: arg) : root.appendingPathComponent(arg)
        let options = (try? Data(contentsOf: dir.appendingPathComponent("pack.json")))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let tolerance = options["tolerance"] as? Int ?? 40
        let removeBackground = options["removeBackground"] as? Bool ?? true
        let specs = sheetSpecs(options, directory: dir)
        if specs.isEmpty { print("No spritesheet in \(dir.path): add sheet.png or a \"sheet\" entry in pack.json"); exit(1) }

        let out = dir.appendingPathComponent("sliced")
        try? FileManager.default.removeItem(at: out)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        for spec in specs {
            guard let result = slice(spec, in: dir, tolerance: tolerance) else { print("\(spec.file): can't read image"); continue }
            print("\(spec.file): \(result.autoDetected ? "found poses automatically" : "split into an even \(spec.columns)x\(spec.rows) grid (couldn't find \(spec.rows) clear rows)")")
            for cell in result.cells {
                let unknown = mood(named: splitFrameNumber(cell.name).0) == nil ? "  <- not a mood name, ignored" : ""
                guard let p = process(cell.image, removeBackground: removeBackground, tolerance: tolerance),
                      let trimmed = p.image.cropping(to: p.bounds),
                      let dest = CGImageDestinationCreateWithURL(out.appendingPathComponent("\(cell.name).png") as CFURL,
                                                                 "public.png" as CFString, 1, nil) else {
                    print("  \(cell.name): empty cell"); continue
                }
                CGImageDestinationAddImage(dest, trimmed, nil)
                CGImageDestinationFinalize(dest)
                print("  \(cell.name): \(trimmed.width)x\(trimmed.height)\(unknown)")
            }
        }
        print("Previews written to \(out.path)")
        exit(0)
    }
}
