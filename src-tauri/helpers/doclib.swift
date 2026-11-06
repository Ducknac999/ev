// Documents for the agent's read tool: PDF pages (text layer + picture), any image → JPEG, and
// on-device text recognition (Vision), so models that can't see pictures still get the words.
// Loaded into E.V's process together with capturelib.swift (same dylib).

import Foundation
import PDFKit
import Vision
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

private func cString(_ s: String) -> UnsafeMutablePointer<CChar>? {
    strdup(s)
}

private func json(_ object: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else {
        return cString("{\"error\":\"couldn't encode the result\"}")
    }
    return cString(text)
}

private func failure(_ message: String) -> UnsafeMutablePointer<CChar>? {
    json(["error": message])
}

private func writeJPEG(_ image: CGImage, to path: String, quality: Double) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(dest)
}

/// Draws a PDF page on white at a size whose longest side is `maxSize` pixels.
private func render(_ page: PDFPage, maxSize: Double) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    guard box.width > 0, box.height > 0 else { return nil }
    let rotated = page.rotation % 180 != 0
    let (w, h) = rotated ? (box.height, box.width) : (box.width, box.height)
    let scale = maxSize / max(w, h)
    let width = Int((w * scale).rounded()), height = Int((h * scale).rounded())
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.interpolationQuality = .high
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

/// How much of the page, from the bottom up, is empty (0…1): a check that a document uses its space.
private func blankBottom(_ image: CGImage) -> Double {
    let width = image.width, height = image.height
    guard width > 0, height > 0,
          let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return 0 }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let data = ctx.data else { return 0 }
    let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
    // Row 0 of the bitmap is the top of the page; walk up from the bottom row.
    for row in stride(from: height - 1, through: 0, by: -1) {
        var x = 0
        while x < width {
            let i = (row * width + x) * 4
            if pixels[i] < 235 || pixels[i + 1] < 235 || pixels[i + 2] < 235 { return Double(height - 1 - row) / Double(height) }
            x += 2
        }
    }
    return 1
}

private func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    let observations = (request.results ?? []).sorted { a, b in
        // Top-to-bottom, then left-to-right (Vision's origin is bottom-left).
        let ay = a.boundingBox.midY, by = b.boundingBox.midY
        if abs(ay - by) > 0.01 { return ay > by }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

/// {"pages": N, "title": "..."} or {"error": "..."}; `locked` when it needs a password.
@_cdecl("gideon_pdf_info")
public func gideon_pdf_info(_ path: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: String(cString: path))) else { return failure("not a readable PDF") }
    if doc.isLocked { return json(["pages": doc.pageCount, "locked": true]) }
    let title = (doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String) ?? ""
    return json(["pages": doc.pageCount, "title": title])
}

/// One PDF page (0-based): its text layer, and when `outPath` is non-empty a JPEG of it (plus text
/// recognized from that picture when `ocr` is non-zero).
@_cdecl("gideon_pdf_page")
public func gideon_pdf_page(_ path: UnsafePointer<CChar>, _ index: Int32, _ maxSize: Double, _ outPath: UnsafePointer<CChar>, _ ocr: Int32) -> UnsafeMutablePointer<CChar>? {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: String(cString: path))) else { return failure("not a readable PDF") }
    guard index >= 0, Int(index) < doc.pageCount, let page = doc.page(at: Int(index)) else { return failure("no page \(index + 1)") }
    var result: [String: Any] = ["text": page.string ?? ""]
    let out = String(cString: outPath)
    if !out.isEmpty || ocr != 0 {
        guard let image = render(page, maxSize: maxSize) else { return failure("couldn't draw page \(index + 1)") }
        if !out.isEmpty {
            guard writeJPEG(image, to: out, quality: 0.72) else { return failure("couldn't save the page picture") }
            result["width"] = image.width
            result["height"] = image.height
            result["blank"] = blankBottom(image)
        }
        if ocr != 0 {
            // Recognition reads small print better from a sharper picture.
            let sharp = maxSize >= 2000 ? image : (render(page, maxSize: 2200) ?? image)
            result["ocr"] = recognize(sharp)
        }
    }
    return json(result)
}

/// Any image macOS can open (PNG, JPEG, HEIC, TIFF, GIF, WebP…) → JPEG no larger than `maxSize`,
/// plus recognized text when `ocr` is non-zero.
@_cdecl("gideon_image_jpeg")
public func gideon_image_jpeg(_ path: UnsafePointer<CChar>, _ maxSize: Double, _ outPath: UnsafePointer<CChar>, _ ocr: Int32) -> UnsafeMutablePointer<CChar>? {
    let url = URL(fileURLWithPath: String(cString: path)) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil) else { return failure("not a readable image") }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: Int(maxSize),
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return failure("couldn't decode the image") }
    var result: [String: Any] = ["width": image.width, "height": image.height]
    let out = String(cString: outPath)
    if !out.isEmpty {
        // JPEG has no transparency: flatten onto white so transparent areas don't turn black.
        let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        ctx?.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx?.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        ctx?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let flat = ctx?.makeImage(), writeJPEG(flat, to: out, quality: 0.8) else { return failure("couldn't save the picture") }
    }
    if ocr != 0 {
        let full: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 3000]
        let sharp = CGImageSourceCreateThumbnailAtIndex(source, 0, full as CFDictionary) ?? image
        result["ocr"] = recognize(sharp)
    }
    return json(result)
}
