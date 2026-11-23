# PhantomDock

> A hardened localhost bridge that turns web AI chats (Qwen Chat, DeepSeek, ChatGPT) into
> agentic coding assistants with real filesystem access, Agent Skills (`SKILL.md`), and MCP
> tools — via a Rust daemon (`pdock`) and a cross-browser MV3 extension.

[![CI](https://github.com/AmanCode22/phantomdock/actions/workflows/ci.yml/badge.svg)](https://github.com/AmanCode22/phantomdock/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-spec%20locked%20·%20milestones%201--3%20complete-blue)
![License](https://img.shields.io/badge/license-MIT-green)

**Status:** Milestones 1–3 implemented and tested (49 Rust tests + 38 extension tests, CI-verified).
Milestone 4 (live selector / anti-bot calibration against production sites) is intentionally
deferred — selectors ship as tunable presets and are editable at runtime.

---

## How it works

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                       BROWSER (Chromium / Firefox / Zen)                     │
│                                                                              │
│  ┌─────────────────────────────────────┐   ┌──────────────────────────────┐  │
│  │  Web AI Tab (Qwen / DeepSeek / GPT) │   │  PhantomDock Extension Popup │  │
│  │                                     │   │  • Pairing Token Input       │  │
│  │  [Passive MutationObserver]         │   │  • On-Demand Session Picker  │  │
│  │         │                           │   │  • Skills & MCP Health List  │  │
│  │         ▼                           │   │  • Jitter/Cooldown/Guard UI  │  │
│  │  [Post-Stream Closed Shadow DOM     │   │  • Adapter JSON Editor       │  │
│  │   Overlay — Tool Cards / Pills /    │◄─►│  Extension Background Context│  │
│  │   Control Bar]                      │   │  • runtime.Port <-> Content  │  │
│  └─────────────────────────────────────┘   │  • 127.0.0.1 HTTP/WS Client  │  │
│           runtime.Port (no PNA/Mixed)      └──────────────┬───────────────┘  │
└────────────────────────────────────────────────────────────┴──────────────────┘
                                                             │ localhost WS + Origin
                                                             │ check + pairing token
                                                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     RUST CLI DAEMON (`pdock`, in your cwd)                   │
│  Axum HTTP/WS (47800–47820) · Hardened FS Sandbox · Skills Engine · MCP      │
└──────────────────────────────────────────────────────────────────────────────┘
```

A model emits tool calls as fenced `pdock_call` JSON blocks. The extension parses them
post-stream, renders approval cards in a **closed** Shadow DOM (zero React/ProseMirror
interference), executes approved calls against the daemon, and returns one combined
`<tool_result>` reply with human-paced, randomized timing.

## Feature highlights

- **Transport & auth** — localhost-only Axum server on an auto-selected port in `47800–47820`;
  `GET /handshake` returns non-sensitive metadata only; `/ws` requires a one-time 256-bit
  pairing token (constant-time SHA-256 comparison); strict `Origin` validation
  (`chrome-extension://` / `moz-extension://` only, zero wildcard CORS); 20s WS keepalive
  pings + text keepalives so MV3 service workers stay alive.
- **Hardened sandbox** — nearest-existing-parent canonical jail with symlink-escape rejection;
  secret deny-list (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/**` + `.phantomdockignore`);
  exact-once `edit_file` (reports all match lines on ambiguity); oversized outputs offload to
  `.phantomdock/outputs/` with head/tail previews and `.git/info/exclude` hygiene;
  `run_shell` omitted from the manifest and hard-rejected unless `pdock --allow-shell`.
- **Agent Skills** — `SKILL.md` discovery (`.phantomdock/skills` > `.agents/skills` >
  `~/.config/phantomdock/skills` > custom dirs), `<name>-skill.md` bundle compilation,
  cascading upload (input → paste → drop) with chunked inline fallback split on Markdown
  boundaries without breaking code fences.
- **MCP** — `mcp.json` (Claude/Cursor compatible) stdio clients with per-tool timeouts
  (default 30s), isolated stderr logging, exponential-backoff auto-restart (3 retries), and
  live health status in the popup.
- **Stealth & safety** — no prototype tampering, no CDP; native input insertion; randomized
  click coordinates inside the send button; active-tab gate; CAPTCHA/challenge circuit breaker;
  hourly + consecutive turn budgets; exponential-backoff cooldowns; persistent STOP control.
- **Cross-browser** — one TypeScript codebase, dual Vite builds (`dist/chrome` MV3
  service worker, `dist/firefox` MV3 background scripts + gecko settings). All localhost
  traffic flows through the background context — content scripts never touch `http://127.0.0.1`,
  so Private Network Access and Mixed Content restrictions never apply.

## Quick start

### 1. Build and run the daemon

```bash
cd phantomdock-cli
cargo build --release
# binary: target/release/pdock  (add it to your PATH)
```

```bash
cd /path/to/your/project
pdock                 # safe mode: FS tools + skills + MCP, no shell
pdock --allow-shell   # additionally exposes run_shell (manual approval only)
```

The startup banner prints the bound port and a **one-time pairing token** (it is never
exposed via `/handshake` and never leaves localhost).

### 2. Build and load the extension

```bash
cd phantomdock-ext
npm ci
npm run build          # typechecks? no — build only; run `npm run typecheck` + `npm run test` too
```

- **Chrome / Edge / Brave / Zen (Chromium):** `chrome://extensions` → Developer mode →
  *Load unpacked* → select `phantomdock-ext/dist/chrome`.
- **Firefox / Zen (Gecko):** `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on* → pick `phantomdock-ext/dist/firefox/manifest.json`.

### 3. Pair and use

1. Open a chat at `chat.qwen.ai`, `chat.deepseek.com`, or `chatgpt.com`.
2. Click the PhantomDock toolbar icon → **Refresh** → pick your workspace → paste the
   pairing token → **Pair & Bind**.
3. Click **Attach Workspace** in the floating control bar (or enable
   *Auto-prepend workspace manifest on the first turn* in the popup).
4. Ask the model to do something in your repo. When it emits a `pdock_call` block, an
   approval card appears after streaming finishes — Approve, Reject, or trust the tool for
   the session. Read-only tools (`read_file`, `list_dir`, `search_files`,
   `activate_skill`, `read_skill_resource`) can be auto-approved (on by default).
5. Use **STOP** at any time to halt automation and lock sends until you resume.

## The `pdock_call` wire protocol

The workspace manifest injected into the chat instructs the model to emit:

~~~markdown
```pdock_call
{"id":"call_01","name":"read_file","args":{"path":"src/main.rs","start_line":1,"end_line":80}}
```
~~~

…then stop generating. Multiple blocks in one turn are batched: each renders its own card,
and once all resolve, the extension submits **one** combined user reply:

```xml
<tool_result id="call_01" name="read_file" status="ok">
...file contents (offloaded preview if oversized)...
</tool_result>
```

Built-in tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`,
`activate_skill`, `read_skill_resource`, plus `run_shell` (only with `--allow-shell`) and
`mcp__<server>__<tool>` for every MCP tool in your `mcp.json`.

## Configuration

### `phantomdock.toml` (workspace or `~/.config/phantomdock/config.toml`)

```toml
max_inline_chars = 16000
inline_skill_chunk_chars = 6000
mcp_tool_timeout_secs = 30
skill_dirs = []

[sandbox]
deny_globs = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", ".git/**"]
```

See [`phantomdock.toml.example`](phantomdock.toml.example). Extra deny globs can be added
per-project via `.phantomdockignore` (one glob per line, `#` comments).

### `mcp.json` (Claude/Cursor compatible)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

### Site adapters (`adapter.json` v2)

Fully declarative and hot-reloadable from the popup (edit, validate, duplicate, import,
export). Bundled presets: `qwen-chat`, `deepseek-chat`, `chatgpt`, `universal-fallback`.
All selectors, timing ranges, upload cascade, and loop-protection budgets are per-site —
see `phantomdock-ext/src/adapters/qwen.json` for the full schema.

## Security model

| Layer | Guarantee |
| --- | --- |
| Network | Binds `127.0.0.1` only; strict Origin allow-list; no wildcard CORS |
| Auth | One-time 256-bit token gates `/ws`; constant-time hash comparison |
| Filesystem | Canonical jail to `cwd` (symlink-safe, incl. new-file parents); secret deny-list |
| Shell | Off by default, `--allow-shell` opt-in, always manual approval, process-group timeout kill |
| History | Reloaded threads hydrate as collapsed *Executed* cards — never re-run |
| Rate safety | Turn budgets, active-tab gate, challenge circuit breaker, backoff cooldowns, STOP |

## Development

```bash
# Rust daemon — 49 tests (sandbox jail, deny-list, splitter, exact-once edits,
# offloading, MCP fake-server e2e, WS bridge e2e against a live server)
cd phantomdock-cli
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check

# Extension — 38 tests (pdock_call parser, guards/backoff, diffs, adapter schema)
cd phantomdock-ext
npm run typecheck
npm run test
npm run build           # dual target + bundle verification (scripts/verify-dist.mjs)
```

### CI / releases

GitHub Actions (`.github/workflows/`):

- **ci.yml** — on every push/PR: rustfmt + clippy (`-D warnings`) + tests + release build on
  Ubuntu; cross-OS build on Windows/macOS; daemon smoke test (bind + `/handshake` with
  extension origin, token never leaked); extension typecheck + vitest + dual build +
  manifest-reference verification, with bundles uploaded as artifacts.
- **release.yml** — on `v*` tags: builds `pdock` for Linux/Windows/macOS plus the
  chrome/firefox extension zips, generates `SHA256SUMS`, and publishes a GitHub Release.

```bash
git tag v0.1.0 && git push origin main --tags   # triggers the release pipeline
```

## Repository layout

```text
phantomdock/
├── .github/workflows/        # CI + release pipelines
├── phantomdock-cli/          # Rust daemon (Axum, sandbox, skills, MCP)
│   ├── src/
│   │   ├── main.rs           # CLI, port auto-select, banner + pairing token
│   │   ├── config.rs         # TOML layering + deny-list merging
│   │   ├── server.rs         # /handshake + /ws (origin, token, keepalive)
│   │   ├── sandbox.rs        # canonical jail + secret deny-list
│   │   ├── skills/           # discovery, bundler, markdown chunk splitter
│   │   ├── tools/            # registry, fs tools, gated shell, manifest
│   │   ├── mcp/              # stdio JSON-RPC clients, restart/backoff, health
│   │   └── offload.rs        # oversized output offloading
│   └── tests/ws_e2e.rs       # live end-to-end WS bridge test
└── phantomdock-ext/          # TypeScript MV3 extension (chrome + firefox)
    ├── manifests/            # chrome.json / firefox.json
    ├── scripts/              # build orchestrator + bundle verifier
    └── src/
        ├── background/       # port scanner, WS client, storage, routing
        ├── content/          # observer, parser, injector, uploader, guards
        │   └── ui/           # closed Shadow DOM: ControlBar, ToolCard, ResultPill
        ├── adapters/         # zod schema + 4 bundled presets
        └── popup/            # React popup (OS-adaptive theme)
```

## Roadmap

- **Milestone 4 (deferred):** calibrate live DOM selectors, detached file inputs, and
  ProseMirror/React input events on the real sites; tune default timing ranges against
  live challenge flows. Everything is already configurable per-adapter to make this a
  data-gathering exercise rather than a code change.

## License

MIT — see [LICENSE](LICENSE).
