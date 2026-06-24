#ifndef HYNI_TYPES_H
#define HYNI_TYPES_H

#include <string>
#include <vector>

namespace hyni {

struct image_data {
    std::string image_base64;
    std::string mime_type = "image/jpeg";

    bool is_valid() const {
        return !image_base64.empty() && !mime_type.empty();
    }
};

enum class API_PROVIDER {
    OpenAI,
    Anthropic,
    DeepSeek,
    Mistral,
    /**
     * Generic OpenAI-compatible local endpoint (llama.cpp server, vLLM,
     * Ollama with /v1/chat/completions, LM Studio, etc.). URL is configured
     * via the LOCAL_LLM_URL env var on the server; the model slug is whatever
     * the local server reports. No API key required by default.
     */
    Local,
    Unknown
};

enum class QUESTION_TYPE {
    General,
    Coding,
    Behavioral,
    SystemDesign
};

inline std::string provider_to_str(API_PROVIDER p) {
    switch (p) {
    case API_PROVIDER::OpenAI:    return "openai";
    case API_PROVIDER::Anthropic: return "anthropic";
    case API_PROVIDER::DeepSeek:  return "deepseek";
    case API_PROVIDER::Mistral:   return "mistral";
    case API_PROVIDER::Local:     return "local";
    default:                       return "unknown";
    }
}

inline API_PROVIDER provider_from_str(const std::string& s) {
    if (s == "openai")    return API_PROVIDER::OpenAI;
    if (s == "anthropic") return API_PROVIDER::Anthropic;
    if (s == "deepseek")  return API_PROVIDER::DeepSeek;
    if (s == "mistral")   return API_PROVIDER::Mistral;
    if (s == "local")     return API_PROVIDER::Local;
    return API_PROVIDER::Unknown;
}

inline std::string mode_to_str(QUESTION_TYPE t) {
    switch (t) {
    case QUESTION_TYPE::General:      return "general";
    case QUESTION_TYPE::Coding:       return "coding";
    case QUESTION_TYPE::Behavioral:   return "behavioral";
    case QUESTION_TYPE::SystemDesign: return "system_design";
    }
    return "general";
}

inline QUESTION_TYPE mode_from_str(const std::string& s) {
    if (s == "coding")        return QUESTION_TYPE::Coding;
    if (s == "behavioral")    return QUESTION_TYPE::Behavioral;
    if (s == "system_design") return QUESTION_TYPE::SystemDesign;
    return QUESTION_TYPE::General;
}

struct chat_message {
    std::string role;                  // "user" | "assistant"
    std::string text;
    std::vector<image_data> images;    // only meaningful on user messages
};

} // namespace hyni

#endif // HYNI_TYPES_H
