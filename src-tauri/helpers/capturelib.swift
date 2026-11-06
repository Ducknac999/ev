// E.V's in-process window capture (ScreenCaptureKit), loaded by E.V itself so it runs under
// E.V's own Screen Recording permission. Works for windows on other desktops too.
import Foundation

import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Writes a JPEG of window `windowID` to `path`. Returns nil on success, or an error message
/// (caller frees it with gideon_free_string).
@_cdecl("gideon_capture_window")
public func gideon_capture_window(_ windowID: UInt32, _ path: UnsafePointer<CChar>, _ maxSize: Double) -> UnsafeMutablePointer<CChar>? {
    // ScreenCaptureKit needs a window-server connection; a process that hasn't opened a window yet has none.
    _ = CGMainDisplayID()
    let output = URL(fileURLWithPath: String(cString: path))
    var failure: String? = "timed out"
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        defer { done.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else { failure = "window not found"; return }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            let frame = window.frame
            let scale = min(2.0, max(0.1, maxSize / max(frame.width, frame.height)))
            config.width = max(1, Int(frame.width * scale))
            config.height = max(1, Int(frame.height * scale))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { failure = "can't write image"; return }
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
            failure = CGImageDestinationFinalize(dest) ? nil : "can't finish image"
        } catch {
            failure = "capture failed: \(error.localizedDescription)"
        }
    }
    if done.wait(timeout: .now() + 10) == .timedOut { return strdup("timed out") }
    return failure.map { strdup($0) }
}

/// 64×40 grey thumbnail of window `windowID` into `out` (2560 bytes): the 64×40-point area around
/// the global point (x, y), or the whole window when x < 0. Returns 1 on success. Used to tell
/// whether an action changed what's on screen when no control changed.
@_cdecl("gideon_window_fingerprint")
public func gideon_window_fingerprint(_ windowID: UInt32, _ x: Double, _ y: Double, _ out: UnsafeMutablePointer<UInt8>) -> Int32 {
    _ = CGMainDisplayID()
    final class Box: @unchecked Sendable { var image: CGImage? }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        defer { done.signal() }
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
              let window = content.windows.first(where: { $0.windowID == windowID }) else { return }
        let config = SCStreamConfiguration()
        config.width = 64
        config.height = 40
        config.showsCursor = false
        if x >= 0 {
            config.sourceRect = CGRect(x: x - window.frame.minX - 32, y: y - window.frame.minY - 20, width: 64, height: 40)
        }
        box.image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
    }
    guard done.wait(timeout: .now() + 0.6) == .success, let image = box.image,
          let context = CGContext(data: out, width: 64, height: 40, bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return 0 }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 40))
    return 1
}

@_cdecl("gideon_free_string")
public func gideon_free_string(_ s: UnsafeMutablePointer<CChar>?) {
    free(s)
}
