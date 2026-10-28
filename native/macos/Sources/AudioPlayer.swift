import AVFoundation
import Foundation

/// 表示单个 TTS 语音分句或音效的排队项
struct AudioQueueItem {
    let id: String
    let seq: Int
    let path: String
    let interrupt: Bool
    let fileURL: URL

    init?(dictionary: [String: Any]) {
        guard let id = dictionary["id"] as? String,
              let path = dictionary["path"] as? String else {
            return nil
        }
        self.id = id
        self.path = path
        if let seqInt = dictionary["seq"] as? Int {
            self.seq = seqInt
        } else if let seqDouble = dictionary["seq"] as? Double {
            self.seq = Int(seqDouble)
        } else if let seqStr = dictionary["seq"] as? String, let seqParsed = Int(seqStr) {
            self.seq = seqParsed
        } else {
            self.seq = 0
        }
        self.interrupt = dictionary["interrupt"] as? Bool ?? false
        self.fileURL = URL(fileURLWithPath: path)
    }
}

/// 常驻 Helper 内部的高性能音频播放引擎
/// 管理 AVAudioPlayer 播放、顺序排队、即时打断与非阻塞 stdout 状态上报
final class AudioPlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayer()

    /// 播放状态变化回调（供 PetController 或上层监听以联动说话待机姿态）
    var onPlaybackStateChanged: ((_ isPlaying: Bool) -> Void)?

    private var currentPlayer: AVAudioPlayer?
    private var currentItem: AudioQueueItem?
    private var queue: [AudioQueueItem] = []
    private var isPlaying = false

    /// 全局静音标记（支持热键静音与直播静音）
    var isMuted: Bool = false {
        didSet {
            currentPlayer?.volume = isMuted ? 0.0 : 1.0
        }
    }

    override private init() {
        super.init()
    }

    // MARK: - 公开消息处理接口

    /// 处理来自 Core 的 `audio` 消息
    /// 具备线程安全保证：若在后台队列触发会自动调度至主线程执行
    func handleAudio(_ message: [String: Any]) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in
                self?.handleAudio(message)
            }
            return
        }

        guard let item = AudioQueueItem(dictionary: message) else {
            return
        }

        if item.interrupt {
            // 强制打断：停止当前音频，上报 interrupted，清空队列，并立即播放新项
            stopCurrent(reason: "interrupted")
            queue.removeAll()
            startPlayback(item: item)
        } else {
            if currentPlayer == nil {
                startPlayback(item: item)
            } else {
                queue.append(item)
            }
        }
    }

    /// 处理来自 Core 的 `audio_stop` 或急停指令
    /// 立即停止当前播放，清空排队队列，并上报 interrupted
    func stop() {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in
                self?.stop()
            }
            return
        }

        stopCurrent(reason: "interrupted")
        queue.removeAll()
        updatePlaybackState(false)
    }

    /// 跳过当前正在播放的句子并立即播放下一句（供全局热键 ⌃⌥⌘N 使用）
    func skipCurrent() {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in
                self?.skipCurrent()
            }
            return
        }

        stopCurrent(reason: "interrupted")
        playNext()
    }

    // MARK: - 内部播放与队列调度

    private func startPlayback(item: AudioQueueItem) {
        guard FileManager.default.fileExists(atPath: item.fileURL.path) else {
            // 音频文件不存在：立即上报 interrupted (duration 0) 并推进下一首，避免队列卡死
            emitAudioEvent(id: item.id, seq: item.seq, event: "interrupted", durationMs: 0)
            playNext()
            return
        }

        do {
            let player = try AVAudioPlayer(contentsOf: item.fileURL)
            player.delegate = self
            player.volume = isMuted ? 0.0 : 1.0

            guard player.prepareToPlay(), player.play() else {
                emitAudioEvent(id: item.id, seq: item.seq, event: "interrupted", durationMs: 0)
                playNext()
                return
            }

            self.currentPlayer = player
            self.currentItem = item

            let totalDurationMs = max(0, Int(player.duration * 1000))
            emitAudioEvent(id: item.id, seq: item.seq, event: "started", durationMs: totalDurationMs)
            updatePlaybackState(true)
        } catch {
            emitAudioEvent(id: item.id, seq: item.seq, event: "interrupted", durationMs: 0)
            playNext()
        }
    }

    private func stopCurrent(reason: String) {
        guard let current = currentItem, let player = currentPlayer else {
            return
        }

        let elapsedMs = max(0, Int(player.currentTime * 1000))
        player.delegate = nil // 解绑委托，防止触发 didFinishPlaying 造成重复回调
        player.stop()

        emitAudioEvent(id: current.id, seq: current.seq, event: reason, durationMs: elapsedMs)

        currentPlayer = nil
        currentItem = nil
    }

    private func playNext() {
        guard !queue.isEmpty else {
            currentPlayer = nil
            currentItem = nil
            updatePlaybackState(false)
            return
        }

        let nextItem = queue.removeFirst()
        startPlayback(item: nextItem)
    }

    private func updatePlaybackState(_ playing: Bool) {
        guard isPlaying != playing else { return }
        isPlaying = playing
        onPlaybackStateChanged?(playing)
    }

    private func emitAudioEvent(id: String, seq: Int, event: String, durationMs: Int) {
        let payload: [String: Any] = [
            "protocolVersion": 2,
            "kind": "audio_event",
            "id": id,
            "seq": seq,
            "event": event,
            "durationMs": durationMs,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        ProtocolIO.shared.write(payload)
    }

    // MARK: - AVAudioPlayerDelegate 回调

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard let current = currentItem else {
            playNext()
            return
        }

        if flag {
            let totalDurationMs = max(0, Int(player.duration * 1000))
            emitAudioEvent(id: current.id, seq: current.seq, event: "ended", durationMs: totalDurationMs)
        } else {
            let elapsedMs = max(0, Int(player.currentTime * 1000))
            emitAudioEvent(id: current.id, seq: current.seq, event: "interrupted", durationMs: elapsedMs)
        }

        currentPlayer = nil
        currentItem = nil

        playNext()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        guard let current = currentItem else {
            playNext()
            return
        }

        let elapsedMs = max(0, Int(player.currentTime * 1000))
        emitAudioEvent(id: current.id, seq: current.seq, event: "interrupted", durationMs: elapsedMs)

        currentPlayer = nil
        currentItem = nil

        playNext()
    }
}
