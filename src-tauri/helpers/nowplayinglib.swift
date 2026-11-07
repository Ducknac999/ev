import AppKit
import Foundation

// "Is something playing?" for any app, read from macOS Now Playing (what Control Center shows).
// Since macOS 15.4 only Apple-signed programs may read it, so E.V loads this one function into
// /usr/bin/perl and reads what it prints (the technique of github.com/ungive/mediaremote-adapter,
// BSD-3-Clause). Sending play/pause through Now Playing is blocked on recent macOS, so E.V uses
// the play/pause key for that and checks here that it worked.

private typealias GetPid = @convention(c) (DispatchQueue, @escaping @convention(block) (Int32) -> Void) -> Void
private typealias GetPlaying = @convention(c) (DispatchQueue, @escaping @convention(block) (UInt8) -> Void) -> Void

private func emit(_ value: [String: Any]) -> Never {
    var data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
    exit(0)
}

/// Prints {"playing":true,"pid":123,"app":"Brave Browser","bundle":"com.brave.Browser"} and exits.
@_cdecl("ev_nowplaying_get")
public func evNowPlayingGet() {
    let url = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework") as CFURL
    guard let bundle = CFBundleCreate(kCFAllocatorDefault, url),
          let pidFn = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingApplicationPID" as CFString),
          let playingFn = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying" as CFString)
    else { emit(["error": "Now Playing isn't available"]) }
    let getPid = unsafeBitCast(pidFn, to: GetPid.self)
    let getPlaying = unsafeBitCast(playingFn, to: GetPlaying.self)
    let queue = DispatchQueue(label: "ev.nowplaying")
    let group = DispatchGroup()
    var pid: Int32 = 0
    var playing = false
    group.enter()
    getPid(queue) { p in pid = p; group.leave() }
    group.enter()
    getPlaying(queue) { b in playing = b != 0; group.leave() }
    if group.wait(timeout: .now() + 2) == .timedOut { emit(["error": "Now Playing didn't answer"]) }
    var out: [String: Any] = ["playing": playing, "pid": Int(pid)]
    if pid > 0, let app = NSRunningApplication(processIdentifier: pid) {
        if let name = app.localizedName { out["app"] = name }
        if let id = app.bundleIdentifier { out["bundle"] = id }
    }
    emit(out)
}

private typealias GetInfo = @convention(c) (DispatchQueue, @escaping @convention(block) (CFDictionary?) -> Void) -> Void

/// Prints the song for the notch's music card:
/// {"title","artist","album","duration","elapsed","rate","timestamp","playing","app","artwork"?}.
/// `artwork` (base64 JPEG/PNG) only when EV_NP_ARTWORK=1 — once per song, not every poll.
@_cdecl("ev_nowplaying_info")
public func evNowPlayingInfo() {
    let url = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework") as CFURL
    guard let bundle = CFBundleCreate(kCFAllocatorDefault, url),
          let infoFn = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingInfo" as CFString),
          let pidFn = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingApplicationPID" as CFString),
          let playingFn = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying" as CFString)
    else { emit(["error": "Now Playing isn't available"]) }
    let getInfo = unsafeBitCast(infoFn, to: GetInfo.self)
    let getPid = unsafeBitCast(pidFn, to: GetPid.self)
    let getPlaying = unsafeBitCast(playingFn, to: GetPlaying.self)
    let queue = DispatchQueue(label: "ev.nowplaying.info")
    let group = DispatchGroup()
    var info: [String: Any] = [:]
    var pid: Int32 = 0
    var playing = false
    group.enter()
    getInfo(queue) { dict in
        info = (dict as? [String: Any]) ?? [:]
        group.leave()
    }
    group.enter()
    getPid(queue) { p in pid = p; group.leave() }
    group.enter()
    getPlaying(queue) { b in playing = b != 0; group.leave() }
    if group.wait(timeout: .now() + 2) == .timedOut { emit(["error": "Now Playing didn't answer"]) }
    func value(_ key: String) -> Any? { info["kMRMediaRemoteNowPlayingInfo" + key] }
    var out: [String: Any] = ["playing": playing, "pid": Int(pid)]
    if let t = value("Title") as? String { out["title"] = t }
    if let a = value("Artist") as? String { out["artist"] = a }
    if let a = value("Album") as? String { out["album"] = a }
    if let d = value("Duration") as? Double { out["duration"] = d }
    if let e = value("ElapsedTime") as? Double { out["elapsed"] = e }
    if let r = value("PlaybackRate") as? Double { out["rate"] = r }
    if let ts = value("Timestamp") as? Date { out["timestamp"] = ts.timeIntervalSince1970 }
    if pid > 0, let app = NSRunningApplication(processIdentifier: pid), let name = app.localizedName { out["app"] = name }
    if ProcessInfo.processInfo.environment["EV_NP_ARTWORK"] == "1", let data = value("ArtworkData") as? Data, data.count < 3_000_000 {
        out["artwork"] = data.base64EncodedString()
        out["artworkMime"] = (value("ArtworkMIMEType") as? String) ?? "image/jpeg"
    }
    emit(out)
}
