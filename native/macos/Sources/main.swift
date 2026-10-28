import AppKit
import Darwin
import QuartzCore

signal(SIGPIPE, SIG_IGN)

/// Serialized stdout writer for the newline-delimited JSON protocol.
final class ProtocolIO {
    static let shared = ProtocolIO()
    private let lock = NSLock()

    func write(_ object: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? FileHandle.standardOutput.write(contentsOf: data)
        try? FileHandle.standardOutput.write(contentsOf: Data("\n".utf8))
        try? FileHandle.standardOutput.synchronize()
    }
}

private func currentTimestamp() -> Int {
    Int(Date().timeIntervalSince1970 * 1000)
}

private func loadManifest(at root: URL) -> [String: Any]? {
    let manifestURL = root.appendingPathComponent("pet-manifest.json")
    guard let data = try? Data(contentsOf: manifestURL),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return json
}

private func locateAssets() -> (manifest: [String: Any], assetRoot: URL)? {
    if let env = ProcessInfo.processInfo.environment["DSH_DAFEIYU_ASSET_ROOT"] {
        let root = URL(fileURLWithPath: env)
        if let manifest = loadManifest(at: root) {
            return (manifest, root.appendingPathComponent("pet"))
        }
    }
    if let bundleAssets = Bundle.main.resourceURL?.appendingPathComponent("assets"),
       let manifest = loadManifest(at: bundleAssets) {
        return (manifest, bundleAssets.appendingPathComponent("pet"))
    }
    let candidate = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".dsh/profiles/web/node_modules/dsh-dafeiyu/assets")
    if let manifest = loadManifest(at: candidate) {
        return (manifest, candidate.appendingPathComponent("pet"))
    }
    return nil
}

private func appendEventLog(_ message: [String: Any], to url: URL?) {
    guard let url = url,
          let data = try? JSONSerialization.data(withJSONObject: message),
          let line = String(data: data, encoding: .utf8) else { return }
    let payload = Data((line + "\n").utf8)
    if let handle = try? FileHandle(forWritingTo: url) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: payload)
    } else {
        try? payload.write(to: url)
    }
}

// ---- Argument parsing: --headless, --event-log <path>, --snapshot <path> ----
var arguments = Array(CommandLine.arguments.dropFirst())
var headless = false
var eventLogURL: URL?
var snapshotURL: URL?
while !arguments.isEmpty {
    let arg = arguments.removeFirst()
    switch arg {
    case "--headless":
        headless = true
    case "--event-log":
        if !arguments.isEmpty {
            eventLogURL = URL(fileURLWithPath: arguments.removeFirst())
        }
    case "--snapshot":
        if !arguments.isEmpty {
            snapshotURL = URL(fileURLWithPath: arguments.removeFirst())
        }
    default:
        break
    }
}

guard let assets = locateAssets() else {
    FileHandle.standardError.write(Data("Unable to locate BigFish assets\n".utf8))
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let environment = ProcessInfo.processInfo.environment
let webuiURL = environment["DSH_DAFEIYU_WEBUI_URL"] ?? "http://127.0.0.1:3080/"
let model = AnimationModel(manifest: assets.manifest)

if headless {
    ProtocolIO.shared.write([
        "protocolVersion": 1,
        "kind": "ready",
        "timestamp": currentTimestamp(),
    ])
    let stdinQueue = DispatchQueue(label: "dsh-dafeiyu.stdin.headless")
    stdinQueue.async {
        while let line = readLine() {
            guard !line.isEmpty else { continue }
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let version = object["protocolVersion"] as? Int,
                  (version == 1 || version == 2) else {
                ProtocolIO.shared.write([
                    "protocolVersion": 1,
                    "kind": "error",
                    "message": "invalid json",
                ])
                continue
            }
            appendEventLog(object, to: eventLogURL)
            let kind = object["kind"] as? String
            if kind == "ping" {
                ProtocolIO.shared.write([
                    "protocolVersion": version,
                    "kind": "pong",
                    "timestamp": currentTimestamp(),
                ])
            }
            DispatchQueue.main.async {
                if kind == "audio" {
                    AudioPlayer.shared.handleAudio(object)
                } else if kind == "audio_stop" {
                    AudioPlayer.shared.stop()
                } else if kind == "shutdown" {
                    AudioPlayer.shared.stop()
                    exit(0)
                }
            }
        }
        DispatchQueue.main.async {
            AudioPlayer.shared.stop()
            exit(0)
        }
    }
    CFRunLoopRun()
}

let controller = PetController(
    model: model,
    manifest: assets.manifest,
    assetRoot: assets.assetRoot,
    layoutURL: PetLayout.defaultPath(),
    webuiURL: webuiURL,
    eventLogURL: eventLogURL,
    snapshotURL: snapshotURL
)
controller.show()

ProtocolIO.shared.write([
    "protocolVersion": 1,
    "kind": "ready",
    "timestamp": currentTimestamp(),
])

let stdinQueue = DispatchQueue(label: "dsh-dafeiyu.stdin")
stdinQueue.async {
    while let line = readLine() {
        guard !line.isEmpty else { continue }
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["protocolVersion"] as? Int,
              (version == 1 || version == 2) else {
            ProtocolIO.shared.write([
                "protocolVersion": 1,
                "kind": "error",
                "message": "invalid json",
            ])
            continue
        }
        appendEventLog(object, to: eventLogURL)
        let kind = object["kind"] as? String
        if kind == "ping" {
            ProtocolIO.shared.write([
                "protocolVersion": version,
                "kind": "pong",
                "timestamp": currentTimestamp(),
            ])
        }
        DispatchQueue.main.async {
            switch kind {
            case "audio":
                AudioPlayer.shared.handleAudio(object)
            case "audio_stop":
                AudioPlayer.shared.stop()
                controller.apply(object)
            default:
                controller.apply(object)
            }
        }
    }
    DispatchQueue.main.async {
        AudioPlayer.shared.stop()
        controller.quit(reason: "stdin-eof", reportClosed: false)
    }
}

app.run()
exit(0)
