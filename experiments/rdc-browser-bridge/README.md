# RDC Browser Secure Bridge — isolated experiment

**Status: EXPERIMENTAL / test-only. NOT integrated into Desktop Commander Free/Pro/Team. DO NOT deploy.**

This standalone package demonstrates only two **read-only** MCP tools over a short-lived local HTTP endpoint bound to `127.0.0.1`:

- `rdc_browser_status` — state of a prebound browser tab; does not select arbitrary tabs or expose browser profile contents.
- `rdc_browser_snapshot` — bounded ARIA snapshot of a prebound tab only when its actual origin belongs to the trusted allowlist.

It does **not** connect to, replace or harden the existing `app/native-server` MCP bridge, does not install a native host, does not control the user's default Chrome, and does not implement production policy, human approvals, audit or device routing. The current original mcp-chrome bridge must not be exposed publicly.

## Security contract (prototype)

The trusted embedding process must provide `deviceId`, random 32-byte hex `token` kept out of files/logs, explicit `enabled` tool booleans, exact trusted `allowedOrigins`, a prebound read-only `backend`, and trusted `authorize({deviceId,tool,action})` callback. This callback is **not** an RDC policy implementation; the test callback is a synthetic stand-in and is not production authority.

Without `enabled: {rdc_browser_status:true,...}`, no tools are advertised. Without a returned exact `ALLOW`, every invocation is denied; `DENY`, `REQUIRE_APPROVAL`, exceptions and unknown results are never treated as approval. The caller cannot supply device ID, browser URL, tab ID, code, raw CDP or filesystem path. Snapshot text is capped at 8,192 chars. No browser contents or token are written to the bridge's ordinary logs; the test never uses real accounts or secrets.

HTTP checks: loopback-only bind, exact Host, reject requests with Origin, bearer comparison with timing-safe value comparison, JSON-only POST /mcp, 16 KiB body limit, malformed request denial, no CORS allowances. Five-second socket/header/body timeouts, forced connection closure on shutdown, at most sixteen concurrently retained TCP connections and eight active authenticated MCP requests, two-second authorization decision deadline and five-second observation deadline apply. At most one underlying browser snapshot may run at a time; a timed-out or cancelled snapshot permanently degrades this particular bridge instance to unavailable, requiring a fresh isolated session rather than silently retrying unresponsive browser work. The underlying promise may remain unresolved if the trusted backend ignores cancellation. The bridge propagates AbortSignal to trusted policy and backend callbacks for timeout, client disconnect and shutdown; the exclusive disposable Playwright backend closes its test page when an in-flight snapshot is cancelled. Backend frame-event listeners are disposed when the bridge closes. Browser frame navigation, attachment or detachment during a snapshot invalidates its result, including same-origin document replacement and A-to-B-to-A races. Before and after capture, every embedded iframe must have a provably allowlisted origin; unknown, opaque and third-party frame origins fail closed. This strict experiment-only rule may reject ordinary sites that embed external content. Deadlines cannot forcibly cancel arbitrary uncooperative callbacks; closing a disposable page is the only browser-work hard-stop used in this experiment, and must never be applied to a normal personal browser session. Navigation event ordering is not an atomic document-security proof; this remains a preproduction limitation. This is NOT OS-level isolation: any trusted local process that can obtain a token or control the same browser profile may interfere. The ephemeral token must be delivered only via an authenticated RDC-controlled channel before any real use; no such channel is implemented here. Server and backend lifetimes must be controlled by the embedding agent, not the webpage.

## Test

From this folder, with Node 22+:

```
npm ci --ignore-scripts
npm test
```

The standalone real-browser smoke (`npm run test:e2e`) uses a dedicated, disposable Playwright Chromium and local test HTTP server. It expects a preinstalled Playwright Chromium in `C:\RDCWebsiteStudio\browser-control-pilot-20261012\browsers` on the Cube pilot. No regular Chrome profile or extension is required. The E2E test validates a real MCP client, actual ARIA observation, and fail-closed origin change; it does not validate policy integration.

## Release gates / not yet done

1. Decide whether the secured browser backend uses Chrome extension native messaging, authenticated CDP, or another adapter; enforce an allowlisted extension ID and privileged message validation before any native host registration.
2. Bind the capability token/bootstrap and per-device/per-tool `ALLOW/DENY/REQUIRE_APPROVAL` to the real RDC policy engine; approvals remain exact-action-bound, one-time and external to ordinary MCP tools.
3. Add stale snapshot token, redirects/navigation race, browser identity/session sharing, malformed payload, service shutdown/uninstall and audit privacy negative tests to production integration.
4. Coordinate with the ongoing Blocker C self-protection lane; do not bypass upstream command/allowed-directory checks or consider this a security sandbox.
5. Only after RED→GREEN, broad tests, PR/CI and exact prototype integration may these tools be described as RDC features. No merge into upstream mirror `main`; no deployment without explicit owner authorization.

## 2026-10-12 cancellation / lifecycle safety checkpoint

Implemented in this **experiment only**:

- Trusted policy and browser backend callbacks receive a scoped `AbortSignal`; timeouts, client disconnects and bridge shutdown propagate cancellation. Timeout errors are distinguishable from user cancellations internally.
- HTTP connection admission now limits raw and incomplete-header sockets to 16, with an independent 8-request MCP cap. Reclaimed slots are verified by a negative test. Shutdown is idempotent and disposes the trusted browser backend event listeners.
- The read-only Playwright adapter tracks main/embedded frame navigation from backend creation, checks origin allowlists before and after snapshots, and rejects a navigation even if the initial and final URL agree.
- **Only a disposable, exclusively owned Chromium test tab** is closed when a snapshot is cancelled. This is not suitable for, and must not be attached to, a user's ordinary Chrome.
- A snapshot operation that times out or is cancelled makes this bridge report the browser session as unavailable, rather than silently allowing additional observations. Recovery requires creating a new test session.
- Test coverage now includes cancellation signaling, TCP capacity and slot release, client disconnect, bridge shutdown, backend disposal, initial navigation race, and disposable real-Chromium page closure.

**Unresolved release blockers (Terra red-team review):** A JavaScript `AbortSignal` and a closed tab do not prove an arbitrary uncooperative callback or underlying browser operation has settled; cancellation of an actively executing Playwright operation and process-isolated termination need more proof. MCP transport and streamed-response lifecycle need stronger slow-reader/keep-alive stress evidence; navigation-frame event ordering is not an atomic document identity proof; and actual RDC device-policy, approvals, isolation and audit binding are absent. Therefore the draft PR is **DO NOT MERGE AS PRODUCT**, even with all local experiments green.
