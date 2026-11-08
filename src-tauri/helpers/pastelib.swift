import AppKit
import Foundation

// Dictation lands like Handy's: the whole text pasted at once (⌘V), never typed letter by
// letter (fast synthetic keystrokes arrive out of order or get dropped in many apps). Whatever
// was on the clipboard — text, images, files, every type — is put back right after.

private let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

@_cdecl("ev_paste")
public func evPaste(_ text: UnsafePointer<CChar>) -> Bool {
    let string = String(cString: text)
    var ok = false
    let work = {
        let board = NSPasteboard.general
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (board.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        board.clearContents()
        guard board.setString(string, forType: .string) else { return }
        // Marked as passing through, so clipboard histories (E.V's own too) don't keep it.
        board.setData(Data(), forType: transient)
        let ours = board.changeCount
        // ⌘V with only ⌘ held: a key just let go (the dictation key, ⌥) must not change it.
        let source = CGEventSource(stateID: .hidSystemState)
        let v: CGKeyCode = 9
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: false) else { return }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        ok = true
        // The app reads the clipboard on ⌘V; then the old clipboard comes back (unless you copied
        // something new in the meantime).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            guard board.changeCount == ours else { return }
            board.clearContents()
            let items: [NSPasteboardItem] = saved.map { pairs in
                let item = NSPasteboardItem()
                for (type, data) in pairs { item.setData(data, forType: type) }
                return item
            }
            // What was there before: already in any history, so not added again.
            items.first?.setData(Data(), forType: transient)
            if !items.isEmpty { board.writeObjects(items) }
        }
    }
    if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
    return ok
}
