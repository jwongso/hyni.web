#pragma once

// Tiny libcurl-backed HTTP helper for the hyni.web integration tests.
//
// Synchronous, blocking, single-request. Captures status + body + the
// Content-Type header. For streaming-endpoint tests, the chunked SSE
// response body is captured as one string and split by the test.
//
// Curl is initialised once per process (curl_global_init) via a static
// guard in HttpClient::ensure_global().

#include <chrono>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include <curl/curl.h>

namespace hyni_tests {

struct HttpResponse {
    long status = 0;
    std::string body;
    std::string content_type;
    long long latency_ms = 0;
};

class HttpClient {
public:
    HttpClient() { ensure_global(); }

    HttpResponse get(const std::string& url,
                     const std::vector<std::string>& extra_headers = {}) {
        return request("GET", url, /*body=*/"", extra_headers);
    }

    HttpResponse post_json(const std::string& url,
                           const std::string& json_body,
                           const std::vector<std::string>& extra_headers = {}) {
        std::vector<std::string> headers = extra_headers;
        headers.push_back("Content-Type: application/json");
        return request("POST", url, json_body, headers);
    }

private:
    static void ensure_global() {
        static std::once_flag flag;
        std::call_once(flag, []() { curl_global_init(CURL_GLOBAL_DEFAULT); });
    }

    static size_t write_cb(void* contents, size_t size, size_t nmemb, void* userp) {
        const size_t n = size * nmemb;
        static_cast<std::string*>(userp)->append(static_cast<char*>(contents), n);
        return n;
    }

    static size_t header_cb(char* buffer, size_t size, size_t nitems, void* userp) {
        const size_t n = size * nitems;
        const std::string line(buffer, n);
        // Look for "Content-Type:"
        const std::string key = "content-type:";
        std::string lower;
        lower.reserve(line.size());
        for (char c : line) lower.push_back(static_cast<char>(std::tolower(c)));
        if (lower.rfind(key, 0) == 0) {
            std::string val = line.substr(key.size());
            while (!val.empty() && (val.front() == ' ' || val.front() == '\t'))
                val.erase(0, 1);
            while (!val.empty() && (val.back() == '\r' || val.back() == '\n'))
                val.pop_back();
            *static_cast<std::string*>(userp) = val;
        }
        return n;
    }

    HttpResponse request(const char* method,
                         const std::string& url,
                         const std::string& body,
                         const std::vector<std::string>& headers) {
        CURL* curl = curl_easy_init();
        if (!curl) throw std::runtime_error("curl_easy_init failed");

        HttpResponse resp;
        struct curl_slist* hdrs = nullptr;
        for (const auto& h : headers) hdrs = curl_slist_append(hdrs, h.c_str());

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method);
        if (!body.empty()) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
        }
        if (hdrs) curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,  write_cb);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA,      &resp.body);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_cb);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA,     &resp.content_type);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 60L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

        const auto t0 = std::chrono::steady_clock::now();
        CURLcode rc = curl_easy_perform(curl);
        const auto t1 = std::chrono::steady_clock::now();
        resp.latency_ms =
            std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);

        curl_slist_free_all(hdrs);
        curl_easy_cleanup(curl);

        if (rc != CURLE_OK) {
            throw std::runtime_error(std::string("curl error: ") + curl_easy_strerror(rc));
        }
        return resp;
    }
};

} // namespace hyni_tests
