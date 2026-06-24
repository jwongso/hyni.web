// hyni.web — Drogon entry point.
//
// Responsibilities:
//   1. Register HTTP controllers (defined in src/controllers/).
//   2. Attach a post-handling advice that sets the COOP / COEP / CORP
//      response headers required for SharedArrayBuffer (needed by the
//      wstream WASM STT adapter on the frontend).
//   3. Serve the built frontend (../public) including the wstream WASM
//      assets at /wstream/*.
//
// Configuration is loaded from a JSON file (default: ../config/drogon.json
// relative to the binary). The path can be overridden with the first CLI
// argument.

#include "hyni/mcp_client.h"
#include <drogon/drogon.h>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>

namespace fs = std::filesystem;

namespace {

// Attach cross-origin isolation headers so the browser allows
// SharedArrayBuffer (required by whisper.cpp WASM threads).
void install_coop_coep_headers() {
    drogon::app().registerPostHandlingAdvice(
        [](const drogon::HttpRequestPtr& /*req*/,
           const drogon::HttpResponsePtr& resp) {
            resp->addHeader("Cross-Origin-Opener-Policy",   "same-origin");
            resp->addHeader("Cross-Origin-Embedder-Policy", "credentialless");
            resp->addHeader("Cross-Origin-Resource-Policy", "cross-origin");
        });
}

std::string resolve_config_path(int argc, char* argv[]) {
    if (argc >= 2) return argv[1];

    fs::path exe;
    try { exe = fs::canonical("/proc/self/exe"); } catch (...) {}
    if (!exe.empty()) {
        const fs::path candidate = exe.parent_path() / ".." / "config" / "drogon.json";
        if (fs::exists(candidate)) return fs::weakly_canonical(candidate).string();
    }

    const fs::path cwd_candidate = fs::path("config") / "drogon.json";
    if (fs::exists(cwd_candidate)) return cwd_candidate.string();
    return "config/drogon.json";
}

// Spawn every MCP server listed in HYNI_MCP_SERVERS. Failed entries are
// logged and skipped — the server still starts (MCP is opt-in).
void start_mcp_servers() {
    const char* raw = std::getenv("HYNI_MCP_SERVERS");
    if (!raw || !*raw) return;
    const auto specs = hyni::mcp::parse_servers_env(raw);
    if (specs.empty()) return;
    const std::size_t up = hyni::mcp::registry::startup(specs);
    std::cout << "[hyni.web] MCP servers: " << up << " of " << specs.size()
              << " healthy" << std::endl;
}

} // namespace

int main(int argc, char* argv[]) {
    const std::string config_path = resolve_config_path(argc, argv);
    std::cout << "[hyni.web] Loading config from: " << config_path << std::endl;

    install_coop_coep_headers();

    try {
        drogon::app().loadConfigFile(config_path);
    } catch (const std::exception& e) {
        std::cerr << "[hyni.web] Failed to load config: " << e.what() << std::endl;
        return 1;
    }

    start_mcp_servers();
    // Tear MCP servers down cleanly on process exit (also fires on the
    // SIGTERM path Drogon installs internally — at that point our atexit
    // handler still gets to send SIGTERM to children and waitpid them).
    std::atexit([]() { hyni::mcp::registry::shutdown(); });

    std::cout << "[hyni.web] Starting server..." << std::endl;
    drogon::app().run();
    hyni::mcp::registry::shutdown();
    return 0;
}
