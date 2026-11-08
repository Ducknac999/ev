import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// The instant router: decides, on this Mac and with no tokens, whether one of E.V's instant
// actions does the whole request ("max volume", "skip this", "what's 7 times 8") or the AI is
// needed. Nothing here is written per phrasing:
//  1. Apple's on-device model (macOS 26, Apple Intelligence) picks an action and its values from
//     the actions' own descriptions, as a form per action, so values can't mix.
//  2. A coverage check built from those same descriptions: every word of the request has to be
//     explained by the chosen action (its description, examples and values) or be filler —
//     "turn it down and text Chris" leaves "text Chris", so the AI gets it. Question words are
//     only accepted by actions that answer questions.
// Unsure → the AI. A wrong instant action is worse than a slower right answer.

struct RouterArg: Codable { let name: String; let type: String; let description: String; let choices: [String]? }
struct RouterTool: Codable {
    let name: String
    let description: String
    let args: [RouterArg]
    let examples: [String]?
    /// Question words this action answers ("what" for the time, "where" for files).
    let asks: [String]?
    /// The request itself is what it acts on (file search): no word coverage needed, but it has
    /// to start with one of the action's own verbs.
    let takesRequest: Bool?
    /// The request must contain one of these words (a file search mentions a file: "my", "pdf"…).
    let needsOneOf: [String]?
}
struct RouterLearned: Codable { let text: String; let tool: String }
struct RouterInput: Codable { let tools: [RouterTool]; let learned: [RouterLearned]?; let text: String }

private let filler: Set<String> = Set("""
a an the it its it's this that these those my me i i'm im you your please can could would will just now right some bit little lot all way on off to of in \
for at by with and or so um uh hey ok okay yeah e.v ev evie eevee go turn make set put get give let lets let's really very too more less again thing one is are \
was be do does did much tell show thanks thank enable disable
""".split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))

private let numbers: Set<String> = Set("""
zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty \
sixty seventy eighty ninety hundred thousand million half quarter third percent max maximum full plus minus times divided over squared cubed root square
""".split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init))

private let questionWords: Set<String> = ["what", "what's", "whats", "why", "who", "how", "when", "where", "where's", "wheres", "which", "whose", "is", "are", "does", "do"]

private func words(_ text: String) -> [String] {
    text.lowercased().components(separatedBy: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.'%").inverted).filter { !$0.isEmpty }.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".'")) }.filter { !$0.isEmpty }
}

private func vocabulary(_ tool: RouterTool) -> Set<String> {
    var text = tool.description + " " + (tool.examples ?? []).joined(separator: " ")
    for arg in tool.args { text += " " + arg.description + " " + (arg.choices ?? []).joined(separator: " ") }
    var vocab = Set(words(text))
    for w in vocab where w.hasSuffix("'s") { vocab.insert(String(w.dropLast(2))) }
    for w in vocab where w.hasSuffix("s") { vocab.insert(String(w.dropLast())) }
    return vocab
}

/// "playing" → "play", "lowered" → "lower", "songs" → "song": close enough to count.
private func known(_ w: String, in set: Set<String>) -> Bool {
    if set.contains(w) { return true }
    for suffix in ["s", "ing", "ed", "er", "ly"] where w.hasSuffix(suffix) && w.count > suffix.count + 2 {
        let stem = String(w.dropLast(suffix.count))
        if set.contains(stem) || set.contains(stem + "e") { return true }
    }
    return false
}

/// The coverage check: does the chosen action explain the whole request?
func routerCovers(_ text: String, tool: RouterTool, values: [String: Any]) -> Bool {
    let ws = words(text)
    let asks = Set(tool.asks ?? [])
    if let first = ws.first, questionWords.contains(first), !asks.contains(first) { return false }
    let vocab = vocabulary(tool)
    var valueWords = Set<String>()
    for value in values.values { valueWords.formUnion(words("\(value)")) }
    // Something besides filler ("thanks" is no command).
    let content = ws.filter { !filler.contains($0) && !asks.contains($0) }
    guard !content.isEmpty else { return false }
    // A word that's about this action, not only numbers: "50" alone (an answer to a question) is no command.
    guard content.contains(where: { known($0, in: vocab) }) || tool.takesRequest == true else { return false }
    if let needs = tool.needsOneOf, !ws.contains(where: { w in needs.contains(w) || needs.contains(where: { w.hasPrefix($0) }) }) { return false }
    if tool.takesRequest == true {
        return (ws.first.map { asks.contains($0) } ?? false) || known(content[0], in: vocab)
    }
    let covered = vocab.union(filler).union(numbers).union(asks).union(valueWords)
    return ws.allSatisfy { w in known(w, in: covered) || w.allSatisfy { "0123456789.%".contains($0) } }
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private enum Router {
    static func argSchema(_ tool: String, _ arg: RouterArg) -> DynamicGenerationSchema {
        switch arg.type {
        case "integer": return DynamicGenerationSchema(type: Int.self)
        case "number": return DynamicGenerationSchema(type: Double.self)
        case "boolean": return DynamicGenerationSchema(type: Bool.self)
        case "enum": return DynamicGenerationSchema(name: "\(tool)_\(arg.name)", anyOf: arg.choices ?? [])
        default: return DynamicGenerationSchema(type: String.self)
        }
    }

    /// One form per action (its name and only its own values), or "none".
    static func schema(_ tools: [RouterTool]) throws -> GenerationSchema {
        var choices: [DynamicGenerationSchema] = tools.map { tool in
            DynamicGenerationSchema(
                name: tool.name, description: tool.description,
                properties: [.init(name: "tool", schema: DynamicGenerationSchema(name: "\(tool.name)_name", anyOf: [tool.name]))]
                    + tool.args.map { .init(name: $0.name, description: $0.description, schema: argSchema(tool.name, $0), isOptional: tool.args.count > 1) })
        }
        choices.append(DynamicGenerationSchema(name: "none", description: "No single action does the whole request",
                                               properties: [.init(name: "tool", schema: DynamicGenerationSchema(name: "none_name", anyOf: ["none"]))]))
        return try GenerationSchema(root: DynamicGenerationSchema(name: "Route", anyOf: choices), dependencies: [])
    }

    static func instructions(_ input: RouterInput) -> String {
        var s = """
        You route spoken or typed requests for a Mac assistant to an instant action. People say things many ways; match the meaning, not the words.
        Pick the action when it does the whole request. Pick none when the request needs something else too (a second task, writing, the web, an explanation, a question these actions can't answer) or a needed value is missing.
        Actions:
        """
        for t in input.tools {
            s += "\n- \(t.name): \(t.description)"
            if !t.args.isEmpty { s += " Values: " + t.args.map { "\($0.name) (\($0.description))" }.joined(separator: "; ") + "." }
            let examples = (t.examples ?? []) + (input.learned ?? []).filter { $0.tool == t.name }.suffix(6).map(\.text)
            if !examples.isEmpty { s += " For example: " + examples.map { "\"\($0)\"" }.joined(separator: ", ") }
        }
        return s
    }

    static func route(_ input: RouterInput) async throws -> [String: Any] {
        let session = LanguageModelSession(instructions: instructions(input))
        let response = try await session.respond(to: input.text, schema: try schema(input.tools), includeSchemaInPrompt: false, options: GenerationOptions(temperature: 0))
        return (try JSONSerialization.jsonObject(with: Data(response.content.jsonString.utf8)) as? [String: Any]) ?? [:]
    }

    static var available: Bool {
        if case .available = SystemLanguageModel.default.availability { return true }
        return false
    }

    static var warmed = false
    static func prewarm() {
        guard available, !warmed else { return }
        warmed = true
        LanguageModelSession(instructions: "Route requests.").prewarm()
    }
}
#endif

private func reply(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
    return strdup(String(decoding: data, as: UTF8.self))
}

/// JSON in: {tools, learned?, text}. JSON out: {available, tool, values, ms, reason?}.
/// `tool` is "none" whenever the AI should handle it. Blocks (call it off the main thread).
@_cdecl("ev_route")
public func evRoute(_ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let started = Date()
    guard let input = try? JSONDecoder().decode(RouterInput.self, from: Data(String(cString: json).utf8)) else {
        return reply(["available": false, "tool": "none", "reason": "bad input"])
    }
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *), Router.available {
        var result: [String: Any] = ["available": true, "tool": "none"]
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                var picked = try await Router.route(input)
                let name = picked.removeValue(forKey: "tool") as? String ?? "none"
                if let tool = input.tools.first(where: { $0.name == name }) {
                    if routerCovers(input.text, tool: tool, values: picked) {
                        result["tool"] = name
                        result["values"] = picked
                    } else {
                        result["reason"] = "\(name) doesn't cover the whole request"
                    }
                }
            } catch {
                result["reason"] = "\(error)"
            }
            done.signal()
        }
        if done.wait(timeout: .now() + 6) == .timedOut { result = ["available": true, "tool": "none", "reason": "timed out"] }
        result["ms"] = Int(Date().timeIntervalSince(started) * 1000)
        return reply(result)
    }
    #endif
    return reply(["available": false, "tool": "none", "reason": "Apple's on-device model isn't available on this Mac"])
}

/// Loads the on-device model ahead of time, so the first request isn't slow.
@_cdecl("ev_route_prewarm")
public func evRoutePrewarm() -> Bool {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        Router.prewarm()
        return Router.available
    }
    #endif
    return false
}

@_cdecl("ev_route_free")
public func evRouteFree(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private enum Polisher {
    static let instructions = """
    You tidy dictated text. Keep the speaker's own words, order and meaning. Only: apply their self-corrections ("Friday, actually Thursday" → "Thursday"; "send it to Sam, no, to Maya" → "send it to Maya"), drop false starts and repeated words, and fix punctuation and capitals. Never add, answer, summarize or explain anything. Reply with the tidied text only.
    """
    static func polish(_ text: String) async throws -> String {
        let session = LanguageModelSession(instructions: instructions)
        let r = try await session.respond(to: text, options: GenerationOptions(temperature: 0))
        return r.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
#endif

/// Dictation's "polished" clean-up with Apple's on-device model; returns the text unchanged when
/// the model isn't there, is slow (over 3 s), or its result strays from what was said.
@_cdecl("ev_polish")
public func evPolish(_ text: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let input = String(cString: text)
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *), Router.available, input.count > 12 {
        var output = input
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            if let polished = try? await Polisher.polish(input), !polished.isEmpty {
                // A tidy-up keeps about the same words: anything much longer or shorter is the model
                // doing more than it was asked, so the plain clean-up stands.
                let ratio = Double(polished.count) / Double(max(1, input.count))
                if ratio > 0.5 && ratio < 1.25 { output = polished }
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 3)
        return strdup(output)
    }
    #endif
    return strdup(input)
}
