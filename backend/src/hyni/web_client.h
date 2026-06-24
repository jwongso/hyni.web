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
    /**
     * Optional client-supplied API key (from the frontend's Settings page
     * localStorage). When set, takes precedence over server-side env vars.
     * Lives only on the request — never logged, never persisted on the
     * server.
     */
    std::string client_api_key;
    /**
     * Optional override for the Local provider URL. Lets the user point
     * hyni at their llama.cpp / Ollama / vLLM / LM Studio endpoint without
     * a server restart. Ignored for any provider other than Local.
     * Must include the full path (e.g. http://localhost:8080/v1/chat/completions).
     */
    std::string local_url;
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

/** A single curated model entry surfaced to the frontend. */
struct model_info {
    std::string id;            // exact slug to send in the API call
    std::string label;         // human-readable picker label
    bool        vision = false;// model accepts image inputs
};

/** List the curated models for a provider (hand-maintained in web_client.cpp). */
std::vector<model_info> list_models(API_PROVIDER provider);

// Execute a stateless chat completion. Reads the API key from `api_key`.
// Returns a chat_result; on transport/HTTP failure success=false and error
// is populated.
chat_result send_chat(const chat_request& req, const std::string& api_key);

// ---------------------------------------------------------------------------
// Streaming variant.
//
// Sets `stream: true` on the outgoing payload, parses Server-Sent-Event
// frames from the provider (OpenAI / DeepSeek / Mistral all use the same
// `data: {json}\n\n` shape; Anthropic uses `event:` + `data:` pairs with
// content_block_delta events), and invokes `on_delta` for each text chunk
// as it arrives. `on_reasoning` (optional) fires separately for chunks of
// a reasoning model's internal monologue (Qwen3 / DeepSeek-R1 / GPT-5's
// `reasoning_content` field) — keeping it on its own channel lets the
// frontend render the chain-of-thought collapsibly instead of mixing it
// into the visible answer.
//
// `on_delta(text_chunk)` should return false to request cancellation. When
// the upstream call finishes (successfully, with an error, or cancelled),
// `on_done(chat_result)` is invoked exactly once with usage/latency/error.
//
// This call is synchronous from the caller's perspective: it returns only
// after the upstream stream ends (or the caller cancels). Both callbacks
// run on the calling thread.
// ---------------------------------------------------------------------------
using stream_delta_cb     = std::function<bool(std::string_view text)>;
using stream_reasoning_cb = std::function<bool(std::string_view text)>;
using stream_done_cb      = std::function<void(const chat_result&)>;

void send_chat_stream(const chat_request& req,
                      const std::string& api_key,
                      const stream_delta_cb& on_delta,
                      const stream_done_cb& on_done);

// Overload with separate reasoning channel. Passing an empty/null
// reasoning callback is equivalent to the 4-arg form (and reasoning
// chunks are silently dropped from the visible answer).
void send_chat_stream(const chat_request& req,
                      const std::string& api_key,
                      const stream_delta_cb& on_delta,
                      const stream_reasoning_cb& on_reasoning,
                      const stream_done_cb& on_done);

} // namespace hyni

#endif // HYNI_WEB_CLIENT_H
