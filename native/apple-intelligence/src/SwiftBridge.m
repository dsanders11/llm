#import "SwiftBridge.h"
#import "apple_intelligence-Swift.h"
#import <Foundation/Foundation.h>

@implementation SwiftBridge

+ (NSString*)checkAvailability {
    return [SwiftCode checkAvailability];
}

+ (NSInteger)getContextSize {
    return [SwiftCode getContextSize];
}

+ (NSString*)createSession:(NSString*)systemPrompt error:(NSError**)error {
    return [SwiftCode createSession:systemPrompt error:error];
}

+ (void)destroySession:(NSString*)sessionId {
    [SwiftCode destroySession:sessionId];
}

+ (NSString*)respond:(NSString*)sessionId
              prompt:(NSString*)prompt
          jsonSchema:(NSString*)jsonSchema
             onToken:(void(^)(NSString*))onToken
          onComplete:(void(^)(NSString*, NSError*))onComplete {
    return [SwiftCode respond:sessionId prompt:prompt jsonSchema:jsonSchema onToken:onToken onComplete:onComplete];
}

+ (void)cancelGeneration:(NSString*)cancelToken {
    [SwiftCode cancelGeneration:cancelToken];
}

+ (NSString*)cloneSession:(NSString*)sessionId error:(NSError**)error {
    return [SwiftCode cloneSession:sessionId error:error];
}

+ (NSString*)countTokens:(NSString*)text
              completion:(void(^)(NSInteger, NSError*))completion {
    return [SwiftCode countTokens:text completion:completion];
}

@end
