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

#include <drogon/drogon.h>
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

    // Look for ../config/drogon.json relative to the executable, then CWD.
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

    std::cout << "[hyni.web] Starting server..." << std::endl;
    drogon::app().run();
    return 0;
}
