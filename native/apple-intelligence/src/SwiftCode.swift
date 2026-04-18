import Foundation
import FoundationModels

@objc public class SwiftCode: NSObject {
    /// Active sessions keyed by UUID string.
    private static var sessions: [String: LanguageModelSession] = [:]

    /// Active generation tasks keyed by cancel-token UUID string.
    private static var activeTasks: [String: Task<Void, Never>] = [:]

    private static let lock = NSLock()

    @objc public static func checkAvailability() -> String {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            return "available"
        case .unavailable:
            return "unavailable"
        @unknown default:
            return "unavailable"
        }
    }

    @objc public static func getContextSize() -> Int {
        return SystemLanguageModel.default.contextSize
    }

    @objc public static func createSession(_ systemPrompt: String?) throws -> String {
        let sessionId = UUID().uuidString
        let session: LanguageModelSession

        if let prompt = systemPrompt, !prompt.isEmpty {
            session = LanguageModelSession(instructions: Instructions(prompt))
        } else {
            session = LanguageModelSession()
        }

        lock.lock()
        sessions[sessionId] = session
        lock.unlock()

        return sessionId
    }

    @objc public static func destroySession(_ sessionId: String) {
        lock.lock()
        sessions.removeValue(forKey: sessionId)
        lock.unlock()
    }

    /// Starts a streaming generation. Returns a cancel-token UUID string that
    /// can be passed to ``cancelGeneration(_:)`` to abort the task.
    ///
    /// If `jsonSchema` is non-nil, it is treated as a JSON Schema string and
    /// the model uses guided generation (DynamicGenerationSchema) to produce
    /// structured output.  The full response will be a JSON string conforming
    /// to the schema, and streaming tokens will be incremental JSON fragments.
    @objc public static func respond(
        _ sessionId: String,
        prompt: String,
        jsonSchema: String?,
        onToken: @escaping (String) -> Void,
        onComplete: @escaping (String?, Error?) -> Void
    ) -> String {
        let cancelToken = UUID().uuidString

        lock.lock()
        guard let session = sessions[sessionId] else {
            lock.unlock()
            onComplete(nil, NSError(
                domain: "AppleIntelligence",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Session not found"]
            ))
            return cancelToken
        }
        lock.unlock()

        let task = Task {
            do {
                if let schemaJson = jsonSchema, !schemaJson.isEmpty {
                    guard #available(macOS 26.4, *) else {
                        removeCancelToken(cancelToken)
                        onComplete(nil, NSError(
                            domain: "AppleIntelligence",
                            code: 4,
                            userInfo: [NSLocalizedDescriptionKey: "Structured output requires macOS 26.4 or newer"]
                        ))
                        return
                    }
                    // Guided generation: parse JSON Schema → DynamicGenerationSchema
                    let schema = try Self.buildGenerationSchema(from: schemaJson)
                    let stream = session.streamResponse(to: Prompt(prompt), schema: schema)
                    var fullText = ""
                    for try await partial in stream {
                        try Task.checkCancellation()
                        let currentText = partial.content.jsonString
                        if currentText.count > fullText.count {
                            let newPart = String(currentText.dropFirst(fullText.count))
                            onToken(newPart)
                        }
                        fullText = currentText
                    }
                    removeCancelToken(cancelToken)
                    onComplete(fullText, nil)
                } else {
                    // Plain text generation
                    let stream = session.streamResponse(to: Prompt(prompt))
                    var fullText = ""
                    for try await partial in stream {
                        try Task.checkCancellation()
                        let currentText = partial.content
                        if currentText.count > fullText.count {
                            let newPart = String(currentText.dropFirst(fullText.count))
                            onToken(newPart)
                        }
                        fullText = currentText
                    }
                    removeCancelToken(cancelToken)
                    onComplete(fullText, nil)
                }
            } catch is CancellationError {
                removeCancelToken(cancelToken)
                onComplete(nil, NSError(
                    domain: "AppleIntelligence",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Generation was cancelled"]
                ))
            } catch {
                removeCancelToken(cancelToken)
                onComplete(nil, error)
            }
        }

        lock.lock()
        activeTasks[cancelToken] = task
        lock.unlock()

        return cancelToken
    }

    @objc public static func cancelGeneration(_ cancelToken: String) {
        lock.lock()
        let task = activeTasks.removeValue(forKey: cancelToken)
        lock.unlock()
        task?.cancel()
    }

    private static func removeCancelToken(_ cancelToken: String) {
        lock.lock()
        activeTasks.removeValue(forKey: cancelToken)
        lock.unlock()
    }

    /// Converts a JSON Schema dictionary into a DynamicGenerationSchema,
    /// then wraps it in a GenerationSchema for guided generation.
    /// Requires macOS 26.4+.
    @available(macOS 26.4, *)
    private static func buildGenerationSchema(from jsonSchemaString: String) throws -> GenerationSchema {
        guard let data = jsonSchemaString.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(
                domain: "AppleIntelligence",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Invalid JSON Schema string"]
            )
        }

        let rootSchema = try parseDynamicSchema(json, name: "Root")
        return try GenerationSchema(root: rootSchema, dependencies: [])
    }

    /// Recursively parses a JSON Schema dictionary into a DynamicGenerationSchema.
    @available(macOS 26.4, *)
    private static func parseDynamicSchema(_ schema: [String: Any], name: String) throws -> DynamicGenerationSchema {
        let description = schema["description"] as? String
        let type = schema["type"] as? String

        // Handle enum → anyOf
        if let enumValues = schema["enum"] as? [String] {
            return DynamicGenerationSchema(name: name, description: description, anyOf: enumValues)
        }

        switch type {
        case "object":
            let properties = schema["properties"] as? [String: Any] ?? [:]
            let required = Set(schema["required"] as? [String] ?? [])
            var dynProperties: [DynamicGenerationSchema.Property] = []

            // Maintain order if possible; dictionaries are unordered, but
            // JSON Schema doesn't guarantee order either.
            for (propName, propValue) in properties {
                guard let propSchema = propValue as? [String: Any] else { continue }
                let childSchema = try parseDynamicSchema(propSchema, name: propName)
                let isOptional = !required.contains(propName)
                dynProperties.append(
                    DynamicGenerationSchema.Property(
                        name: propName,
                        schema: isOptional
                            ? DynamicGenerationSchema(name: propName, anyOf: [childSchema, .null])
                            : childSchema
                    )
                )
            }

            return DynamicGenerationSchema(name: name, description: description, properties: dynProperties)

        case "array":
            let itemsSchema: DynamicGenerationSchema
            if let items = schema["items"] as? [String: Any] {
                itemsSchema = try parseDynamicSchema(items, name: "\(name)Item")
            } else {
                // Default to string items
                itemsSchema = DynamicGenerationSchema(type: String.self, guides: [])
            }
            let minItems = schema["minItems"] as? Int
            let maxItems = schema["maxItems"] as? Int
            return DynamicGenerationSchema(
                arrayOf: itemsSchema,
                minimumElements: minItems,
                maximumElements: maxItems
            )

        case "string":
            return DynamicGenerationSchema(type: String.self, guides: [])

        case "number":
            return DynamicGenerationSchema(type: Double.self, guides: [])

        case "integer":
            return DynamicGenerationSchema(type: Int.self, guides: [])

        case "boolean":
            return DynamicGenerationSchema(type: Bool.self, guides: [])

        default:
            // Fall back to string for unknown types
            return DynamicGenerationSchema(type: String.self, guides: [])
        }
    }

    @objc public static func cloneSession(_ sessionId: String) throws -> String {
        lock.lock()
        guard let session = sessions[sessionId] else {
            lock.unlock()
            throw NSError(
                domain: "AppleIntelligence",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Session not found"]
            )
        }
        let transcript = session.transcript
        lock.unlock()

        let newSessionId = UUID().uuidString
        let newSession = LanguageModelSession(transcript: transcript)

        lock.lock()
        sessions[newSessionId] = newSession
        lock.unlock()

        return newSessionId
    }

    @objc public static func countTokens(
        _ text: String,
        completion: @escaping (Int, Error?) -> Void
    ) -> String {
        let cancelToken = UUID().uuidString

        let task = Task {
            do {
                try Task.checkCancellation()
                let model = SystemLanguageModel.default
                if #available(macOS 26.4, *) {
                    let count = try await model.tokenCount(for: Prompt(text))
                    try Task.checkCancellation()
                    completion(count, nil)
                } else {
                    // Pre-26.4 fallback: ~4 chars per token
                    completion((text.count + 3) / 4, nil)
                }
            } catch is CancellationError {
                completion(0, NSError(
                    domain: "AppleIntelligence",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Token counting was cancelled"]
                ))
            } catch {
                completion(0, error)
            }
            removeCancelToken(cancelToken)
        }

        lock.lock()
        activeTasks[cancelToken] = task
        lock.unlock()

        return cancelToken
    }
}
