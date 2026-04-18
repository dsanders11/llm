#import <Foundation/Foundation.h>
#import "SwiftBridge.h"
#include <napi.h>
#include <string>

// ─── Helpers ───────────────────────────────────────────────────────────────────

static std::string NSStringToStd(NSString* str) {
    return str ? std::string([str UTF8String]) : std::string();
}

static NSString* StdToNSString(const std::string& str) {
    return [NSString stringWithUTF8String:str.c_str()];
}

// ─── AppleIntelligenceSession ──────────────────────────────────────────────────
//
// A thin N-API wrapper around the Swift LanguageModelSession.  Mirrors the
// pattern of node-llama-cpp's model/context/session hierarchy, but flattened:
//
//   const session = addon.createSession("You are a helpful assistant.");
//   const cancelToken = session.respond("Hello", onToken, onComplete);
//   session.cancel(cancelToken);
//   session.destroy();
//

class AppleIntelligenceSession
    : public Napi::ObjectWrap<AppleIntelligenceSession> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "AppleIntelligenceSession", {
            InstanceMethod("respond", &AppleIntelligenceSession::Respond),
            InstanceMethod("clone", &AppleIntelligenceSession::Clone),
            InstanceMethod("destroy", &AppleIntelligenceSession::Destroy),
            InstanceMethod("countTokens", &AppleIntelligenceSession::CountTokens),
            InstanceAccessor("sessionId", &AppleIntelligenceSession::GetSessionId, nullptr),
        });

        Napi::FunctionReference* constructor = new Napi::FunctionReference();
        *constructor = Napi::Persistent(func);
        exports.Set("AppleIntelligenceSession", func);

        // Store constructor so Clone can instantiate new wrappers
        env.SetInstanceData(constructor);

        return exports;
    }

    AppleIntelligenceSession(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<AppleIntelligenceSession>(info) {
        Napi::Env env = info.Env();

        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "Expected session ID string")
                .ThrowAsJavaScriptException();
            return;
        }

        sessionId_ = info[0].As<Napi::String>().Utf8Value();
    }

    ~AppleIntelligenceSession() {
        DestroyInternal();
    }

private:
    std::string sessionId_;

    void DestroyInternal() {
        if (!sessionId_.empty()) {
            [SwiftBridge destroySession:StdToNSString(sessionId_)];
            sessionId_.clear();
        }
    }

    Napi::Value GetSessionId(const Napi::CallbackInfo& info) {
        return Napi::String::New(info.Env(), sessionId_);
    }

    // ── respond(prompt, jsonSchema, onToken, onComplete, signal?) ───────
    //
    // Starts a streaming generation.  If jsonSchema is a non-empty string,
    // uses Apple's guided generation (DynamicGenerationSchema) to produce
    // structured JSON output.
    //
    // Accepts an optional AbortSignal as the 5th argument.
    //
    // onToken(chunk: string)  — called on each incremental text chunk
    // onComplete(err: string|null, fullResponse: string|null)
    //
    // Both callbacks are invoked via ThreadSafeFunction so they are safe
    // to call from Swift's cooperative thread pool.

    Napi::Value Respond(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (sessionId_.empty()) {
            Napi::Error::New(env, "Session has been destroyed")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        if (info.Length() < 4 || !info[0].IsString() ||
            !info[2].IsFunction() || !info[3].IsFunction()) {
            Napi::TypeError::New(
                env,
                "Expected (prompt: string, jsonSchema: string|null, onToken: function, onComplete: function, signal?: AbortSignal)"
            ).ThrowAsJavaScriptException();
            return env.Undefined();
        }

        std::string prompt = info[0].As<Napi::String>().Utf8Value();

        // jsonSchema: string | null | undefined
        NSString* nsJsonSchema = nil;
        if (!info[1].IsNull() && !info[1].IsUndefined() && info[1].IsString()) {
            std::string schemaStr = info[1].As<Napi::String>().Utf8Value();
            if (!schemaStr.empty()) {
                nsJsonSchema = StdToNSString(schemaStr);
            }
        }

        Napi::Function onTokenFn = info[2].As<Napi::Function>();
        Napi::Function onCompleteFn = info[3].As<Napi::Function>();

        // Check if already aborted before starting
        if (info.Length() > 4 && info[4].IsObject()) {
            Napi::Object signal = info[4].As<Napi::Object>();
            if (signal.Has("aborted") &&
                signal.Get("aborted").ToBoolean().Value()) {
                onCompleteFn.Call({
                    Napi::String::New(env, "The operation was aborted"),
                    env.Null(),
                });
                return env.Undefined();
            }
        }

        // Create threadsafe functions for cross-thread callbacks
        auto tsfnToken = Napi::ThreadSafeFunction::New(
            env, onTokenFn, "onToken", 0, 1);
        auto tsfnComplete = Napi::ThreadSafeFunction::New(
            env, onCompleteFn, "onComplete", 0, 1);

        NSString* nsSessionId = StdToNSString(sessionId_);
        NSString* nsPrompt = StdToNSString(prompt);

        NSString* cancelToken = [SwiftBridge respond:nsSessionId
            prompt:nsPrompt
            jsonSchema:nsJsonSchema
            onToken:^(NSString* token) {
                std::string tokenStr = NSStringToStd(token);
                tsfnToken.NonBlockingCall(
                    [tokenStr](Napi::Env env, Napi::Function callback) {
                        callback.Call({Napi::String::New(env, tokenStr)});
                    });
            }
            onComplete:^(NSString* fullResponse, NSError* error) {
                std::string errStr = error
                    ? NSStringToStd([error localizedDescription])
                    : "";
                std::string respStr = NSStringToStd(fullResponse);

                tsfnComplete.NonBlockingCall(
                    [errStr, respStr](Napi::Env env, Napi::Function callback) {
                        if (errStr.empty()) {
                            callback.Call({
                                env.Null(),
                                Napi::String::New(env, respStr),
                            });
                        } else {
                            callback.Call({
                                Napi::String::New(env, errStr),
                                env.Null(),
                            });
                        }
                    });

                tsfnToken.Release();
                tsfnComplete.Release();
            }];

        // Wire up AbortSignal → native cancellation
        if (info.Length() > 4 && info[4].IsObject()) {
            Napi::Object signal = info[4].As<Napi::Object>();
            if (signal.Has("addEventListener")) {
                std::string cancelTokenStr = NSStringToStd(cancelToken);

                // Create a threadsafe function for the abort listener so we
                // can call SwiftBridge from the correct thread context
                auto tsfnAbort = Napi::ThreadSafeFunction::New(
                    env,
                    Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
                    "onAbort", 0, 1);

                Napi::Function abortHandler = Napi::Function::New(env,
                    [cancelTokenStr, tsfnAbort](const Napi::CallbackInfo&) mutable {
                        [SwiftBridge cancelGeneration:
                            StdToNSString(cancelTokenStr)];
                        tsfnAbort.Release();
                    });

                Napi::Object addEventListenerOpts = Napi::Object::New(env);
                addEventListenerOpts.Set("once", Napi::Boolean::New(env, true));

                signal.Get("addEventListener").As<Napi::Function>().Call(
                    signal, {
                        Napi::String::New(env, "abort"),
                        abortHandler,
                        addEventListenerOpts,
                    });
            }
        }

        return env.Undefined();
    }

    // ── clone() → AppleIntelligenceSession ───────────────────────────────

    Napi::Value Clone(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (sessionId_.empty()) {
            Napi::Error::New(env, "Session has been destroyed")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        NSError* error = nil;
        NSString* newId = [SwiftBridge cloneSession:StdToNSString(sessionId_)
                                              error:&error];

        if (error || !newId) {
            Napi::Error::New(env,
                error ? NSStringToStd([error localizedDescription])
                      : "Failed to clone session"
            ).ThrowAsJavaScriptException();
            return env.Undefined();
        }

        // Instantiate a new JS wrapper around the cloned session
        auto* ctor = env.GetInstanceData<Napi::FunctionReference>();
        return ctor->New({Napi::String::New(env, NSStringToStd(newId))});
    }

    // ── destroy() ────────────────────────────────────────────────────────

    void Destroy(const Napi::CallbackInfo&) {
        DestroyInternal();
    }

    // ── countTokens(text, callback, signal?) ────────────────────────────
    //
    // Counts tokens asynchronously via the model's tokenizer.
    // callback(err: string|null, count: number)

    Napi::Value CountTokens(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();

        if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
            Napi::TypeError::New(env,
                "Expected (text: string, callback: function, signal?: AbortSignal)")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }

        std::string text = info[0].As<Napi::String>().Utf8Value();
        Napi::Function callbackFn = info[1].As<Napi::Function>();

        // Check if already aborted
        if (info.Length() > 2 && info[2].IsObject()) {
            Napi::Object signal = info[2].As<Napi::Object>();
            if (signal.Has("aborted") &&
                signal.Get("aborted").ToBoolean().Value()) {
                callbackFn.Call({
                    Napi::String::New(env, "The operation was aborted"),
                    Napi::Number::New(env, 0),
                });
                return env.Undefined();
            }
        }

        auto tsfnCallback = Napi::ThreadSafeFunction::New(
            env, callbackFn, "countTokensCallback", 0, 1);

        NSString* nsText = StdToNSString(text);

        NSString* cancelToken = [SwiftBridge countTokens:nsText
            completion:^(NSInteger count, NSError* error) {
                std::string errStr = error
                    ? NSStringToStd([error localizedDescription])
                    : "";
                double countVal = (double)count;

                tsfnCallback.NonBlockingCall(
                    [errStr, countVal](Napi::Env env, Napi::Function callback) {
                        if (errStr.empty()) {
                            callback.Call({
                                env.Null(),
                                Napi::Number::New(env, countVal),
                            });
                        } else {
                            callback.Call({
                                Napi::String::New(env, errStr),
                                Napi::Number::New(env, 0),
                            });
                        }
                    });

                tsfnCallback.Release();
            }];

        // Wire AbortSignal
        if (info.Length() > 2 && info[2].IsObject()) {
            Napi::Object signal = info[2].As<Napi::Object>();
            if (signal.Has("addEventListener")) {
                std::string cancelTokenStr = NSStringToStd(cancelToken);
                Napi::Function abortHandler = Napi::Function::New(env,
                    [cancelTokenStr](const Napi::CallbackInfo&) {
                        [SwiftBridge cancelGeneration:
                            StdToNSString(cancelTokenStr)];
                    });

                Napi::Object opts = Napi::Object::New(env);
                opts.Set("once", Napi::Boolean::New(env, true));

                signal.Get("addEventListener").As<Napi::Function>().Call(
                    signal, {
                        Napi::String::New(env, "abort"),
                        abortHandler,
                        opts,
                    });
            }
        }

        return env.Undefined();
    }
};

// ─── Module-level functions ────────────────────────────────────────────────────

static Napi::Value CheckAvailability(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NSString* result = [SwiftBridge checkAvailability];
    return Napi::String::New(env, NSStringToStd(result));
}

static Napi::Value GetContextSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NSInteger size = [SwiftBridge getContextSize];
    return Napi::Number::New(env, (double)size);
}

static Napi::Value CreateSession(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    NSString* systemPrompt = nil;
    if (info.Length() > 0 && info[0].IsString()) {
        systemPrompt = StdToNSString(
            info[0].As<Napi::String>().Utf8Value());
    }

    NSError* error = nil;
    NSString* sessionId = [SwiftBridge createSession:systemPrompt error:&error];

    if (error || !sessionId) {
        Napi::Error::New(env,
            error ? NSStringToStd([error localizedDescription])
                  : "Failed to create session"
        ).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Return a new AppleIntelligenceSession wrapping this session ID
    auto* ctor = env.GetInstanceData<Napi::FunctionReference>();
    return ctor->New({Napi::String::New(env, NSStringToStd(sessionId))});
}

static Napi::Value CountTokens(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env,
            "Expected (text: string, callback: function, signal?: AbortSignal)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string text = info[0].As<Napi::String>().Utf8Value();
    Napi::Function callbackFn = info[1].As<Napi::Function>();

    auto tsfnCallback = Napi::ThreadSafeFunction::New(
        env, callbackFn, "countTokensCallback", 0, 1);

    NSString* nsText = StdToNSString(text);

    [SwiftBridge countTokens:nsText
        completion:^(NSInteger count, NSError* error) {
            std::string errStr = error
                ? NSStringToStd([error localizedDescription])
                : "";
            double countVal = (double)count;

            tsfnCallback.NonBlockingCall(
                [errStr, countVal](Napi::Env env, Napi::Function callback) {
                    if (errStr.empty()) {
                        callback.Call({
                            env.Null(),
                            Napi::Number::New(env, countVal),
                        });
                    } else {
                        callback.Call({
                            Napi::String::New(env, errStr),
                            Napi::Number::New(env, 0),
                        });
                    }
                });

            tsfnCallback.Release();
        }];

    return env.Undefined();
}

// ─── Module Init ───────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    AppleIntelligenceSession::Init(env, exports);

    exports.Set("checkAvailability",
        Napi::Function::New(env, CheckAvailability));
    exports.Set("getContextSize",
        Napi::Function::New(env, GetContextSize));
    exports.Set("createSession",
        Napi::Function::New(env, CreateSession));
    exports.Set("countTokens",
        Napi::Function::New(env, CountTokens));

    return exports;
}

NODE_API_MODULE(apple_intelligence, Init)
