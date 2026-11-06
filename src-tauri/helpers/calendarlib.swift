import EventKit
import Foundation

// E.V reminders in the Mac's own Calendar (EventKit, no Calendar window): the Mac rings them even
// when E.V is closed. Each event carries ev://event/<id> as its URL, so E.V finds it again to
// change or remove it. One call, JSON in and out:
//   {"action":"upsert","id","title","start":ms,"minutes","notes","repeat":"none|daily|weekly|monthly|yearly","until":ms?,"lead":minutes}
//   {"action":"delete","id"}
// → {"ok":true} or {"ok":false,"error":"…"}

private let store = EKEventStore()

private func reply(_ object: [String: Any]) -> UnsafeMutablePointer<CChar> {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false}".utf8)
    return strdup(String(decoding: data, as: UTF8.self))!
}

private func access() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if status == .fullAccess || status == .authorized { return true }
    if status != .notDetermined { return false }
    let done = DispatchSemaphore(value: 0)
    var granted = false
    store.requestFullAccessToEvents { ok, _ in
        granted = ok
        done.signal()
    }
    _ = done.wait(timeout: .now() + 120)
    return granted
}

private func existing(_ id: String) -> [EKEvent] {
    let url = URL(string: "ev://event/\(id)")
    let from = Date().addingTimeInterval(-60 * 60 * 24 * 400)
    let to = Date().addingTimeInterval(60 * 60 * 24 * 1500)
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    var seen = Set<String>()
    return store.events(matching: predicate).filter { event in
        guard event.url == url, let key = event.eventIdentifier, !seen.contains(key) else { return false }
        seen.insert(key)
        return true
    }
}

@_cdecl("gideon_calendar")
public func gideon_calendar(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
    guard let data = String(cString: request).data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let action = req["action"] as? String, let id = req["id"] as? String
    else { return reply(["ok": false, "error": "bad request"]) }
    guard access() else {
        return reply(["ok": false, "error": "Calendar access is off for E.V: System Settings → Privacy & Security → Calendars"])
    }
    do {
        for event in existing(id) { try store.remove(event, span: .futureEvents, commit: false) }
        if action == "upsert" {
            guard let calendar = store.defaultCalendarForNewEvents else { return reply(["ok": false, "error": "no calendar to add to"]) }
            let start = Date(timeIntervalSince1970: ((req["start"] as? Double) ?? 0) / 1000)
            let event = EKEvent(eventStore: store)
            event.calendar = calendar
            event.title = (req["title"] as? String) ?? "Reminder"
            event.startDate = start
            event.endDate = start.addingTimeInterval(((req["minutes"] as? Double) ?? 30) * 60)
            event.notes = req["notes"] as? String
            event.url = URL(string: "ev://event/\(id)")
            let lead = (req["lead"] as? Double) ?? 0
            event.addAlarm(EKAlarm(relativeOffset: 0))
            if lead > 0 { event.addAlarm(EKAlarm(relativeOffset: -lead * 60)) }
            let frequency: EKRecurrenceFrequency? = ["daily": .daily, "weekly": .weekly, "monthly": .monthly, "yearly": .yearly][(req["repeat"] as? String) ?? "none"]
            if let frequency {
                let end = (req["until"] as? Double).map { EKRecurrenceEnd(end: Date(timeIntervalSince1970: $0 / 1000)) }
                event.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: frequency, interval: 1, end: end))
            }
            try store.save(event, span: .futureEvents, commit: false)
        }
        try store.commit()
        return reply(["ok": true])
    } catch {
        return reply(["ok": false, "error": error.localizedDescription])
    }
}
