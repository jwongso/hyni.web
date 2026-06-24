# Cloudflare Tunnel — hyni.localrun.ai

The Drogon backend listens on `http://localhost:8848` by default. To expose
it as `https://hyni.localrun.ai`, route Cloudflare Tunnel traffic to it.

You already have a tunnel configured in `~/.cloudflared/config.yml` serving
several other `*.localrun.ai` hostnames. There are two ways to add hyni.web.

---

## Option A — Add to your existing global tunnel (recommended)

1. Open `~/.cloudflared/config.yml`.
2. Insert this entry **above** the catch-all `service: http_status:404` line:

   ```yaml
   - hostname: hyni.localrun.ai
     service: http://localhost:8848
   ```

3. Tell Cloudflare to route the hostname to your tunnel (one-time):

   ```bash
   cloudflared tunnel route dns <your-tunnel-name-or-uuid> hyni.localrun.ai
   ```

4. Restart cloudflared so the new ingress is picked up:

   ```bash
   sudo systemctl restart cloudflared        # if running as a service
   # OR, if you run it manually:
   cloudflared tunnel run <your-tunnel-name-or-uuid>
   ```

5. Browse to `https://hyni.localrun.ai`. The Drogon server's `/` will
   redirect to `/app/` and load the SPA.

---

## Option B — Standalone tunnel just for hyni

Useful if you want to run hyni in isolation (e.g. on another machine) without
touching your shared tunnel. See `config.standalone.example.yml`. Steps:

1. Create the tunnel:
   ```bash
   cloudflared tunnel create hyni
   ```
   This creates `~/.cloudflared/<UUID>.json`.

2. Copy `config.standalone.example.yml` to e.g.
   `~/.cloudflared/hyni-config.yml` and update the `tunnel:` and
   `credentials-file:` fields with the new UUID.

3. Route DNS:
   ```bash
   cloudflared tunnel route dns hyni hyni.localrun.ai
   ```

4. Run:
   ```bash
   cloudflared tunnel --config ~/.cloudflared/hyni-config.yml run hyni
   ```

---

## Test locally without the tunnel

```bash
cd backend && cmake --build build -j
./build/hyni_web_server
# in another shell:
curl -i http://localhost:8848/api/config
```

Then open `http://localhost:8848/` in Chrome or Edge. Firefox lacks the
SpeechRecognition API (Web Speech STT will be disabled in the engine picker,
but Web Speech TTS still works).
