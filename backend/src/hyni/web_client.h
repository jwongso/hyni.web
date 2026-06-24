#ifndef HYNI_WEB_CLIENT_H
#define HYNI_WEB_CLIENT_H

#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "types.h"
#include "sys_prompts.h"

namespace hyni {

struct chat_request {
    API_PROVIDER provider = API_PROVIDER::OpenAI;
    std::string model;                       // empty -> provider default
    QUESTION_TYPE mode = QUESTION_TYPE::General;
    user_profile profile;                    // injected into system prompt
    std::vector<chat_message> history;       // prior turns (frontend-managed)
    std::string user_message;                // newest user turn
    std::vector<image_data> images;          // attached to the new user turn
    double temperature = 0.7;
    int max_tokens = 4096;
    int timeout_seconds = 90;
};

struct chat_result {
    bool success = false;
    std::string content;                     // assistant reply text
    std::string error;                       // human-readable error
    int http_status = 0;
    long long latency_ms = 0;
    // Optional usage metrics if the provider returns them.
    int prompt_tokens = 0;
    int completion_tokens = 0;
};

// Build the request payload for the given provider. Exposed for testing.
nlohmann::json build_payload(const chat_request& req);

// Default model per provider.
std::string default_model(API_PROVIDER provider);

// Execute a stateless chat completion. Reads the API key from `api_key`.
// Returns a chat_result; on transport/HTTP failure success=false and error
// is populated.
chat_result send_chat(const chat_request& req, const std::string& api_key);

} // namespace hyni

#endif // HYNI_WEB_CLIENT_H
