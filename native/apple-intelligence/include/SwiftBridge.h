#ifndef SwiftBridge_h
#define SwiftBridge_h

#import <Foundation/Foundation.h>

/**
 * Objective-C bridge to Apple's FoundationModels framework via Swift.
 *
 * Each session is identified by a UUID string. The bridge manages session
 * lifetime and routes calls to the Swift LanguageModelSession API.
 */
@interface SwiftBridge : NSObject

/// Returns "available" or "unavailable".
+ (NSString* _Nonnull)checkAvailability;

/// Returns the model's maximum context size in tokens.
+ (NSInteger)getContextSize;

/// Creates a new LanguageModelSession, optionally with a system prompt.
/// Returns the session UUID string, or nil on error.
+ (NSString* _Nullable)createSession:(NSString* _Nullable)systemPrompt
                               error:(NSError* _Nullable * _Nullable)error;

/// Destroys a session and releases its resources.
+ (void)destroySession:(NSString* _Nonnull)sessionId;

/// Generates a streaming response. If jsonSchema is non-nil, uses guided
/// generation to produce structured JSON output. Calls onToken for each
/// incremental chunk, then onComplete with the full response (or error).
/// Returns a cancel token string.
+ (NSString* _Nonnull)respond:(NSString* _Nonnull)sessionId
                        prompt:(NSString* _Nonnull)prompt
                    jsonSchema:(NSString* _Nullable)jsonSchema
                       onToken:(void (^ _Nonnull)(NSString* _Nonnull token))onToken
                    onComplete:(void (^ _Nonnull)(NSString* _Nullable fullResponse,
                                                  NSError* _Nullable error))onComplete;

/// Cancels an in-flight generation identified by cancelToken.
+ (void)cancelGeneration:(NSString* _Nonnull)cancelToken;

/// Clones a session by rehydrating from the source session's transcript.
/// Returns the new session UUID string, or nil on error.
+ (NSString* _Nullable)cloneSession:(NSString* _Nonnull)sessionId
                               error:(NSError* _Nullable * _Nullable)error;

/// Counts tokens asynchronously. Returns a cancel token string.
+ (NSString* _Nonnull)countTokens:(NSString* _Nonnull)text
                       completion:(void (^ _Nonnull)(NSInteger count,
                                                     NSError* _Nullable error))completion;

@end

#endif
