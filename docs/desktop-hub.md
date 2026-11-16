# CloudCLI desktop

The Hub desktop entry is `electron/hub/main.mjs`. It opens `https://ai.hwaipy.cn/cloudcli/` and renders the same React build as the browser, without the legacy Electron launcher or a local backend. The existing `npm run desktop` legacy entry is retained; use the explicit Hub commands below.

## Local Mac build

```sh
npm run desktop:hub
npm run desktop:hub:pack
open "release/hub/mac-arm64/CloudCLI.app"
```

The packaged app has version `0.1.1` by default. Set `CLOUDCLI_DESKTOP_VERSION` when building subsequent shell versions. The minimal shell package contains no Codex CLI, native SQLite, local backend, or user credentials. Normal Hub account login happens inside the unchanged web UI. The app uses its own profile at `~/Library/Application Support/CloudCLI Hub` and does not share Chrome's login storage.

`CLOUDCLI_DESKTOP_URL` overrides the Hub URL. Only HTTPS and loopback HTTP are allowed. `CLOUDCLI_DESKTOP_USER_DATA` selects an isolated profile for tests. These settings do not modify the running Hub or backend.

## Web resources

Vite writes `desktop-assets.json` alongside `index.html` and `boot-assets.json`. It lists the complete build graph and SHA-256 hashes, including lazy-loaded chunks. Deployment validates the manifest against the build files before publishing. The manifest's identity derives from its contents, not the package version or a timestamp.

The desktop checks every 60 seconds. It caches verified files by content hash, downloads only changed assets, and keeps a completed release pending until the user selects **更新并重启** at the top of the sidebar or in the native application menu. Incomplete/invalid downloads never replace the current release. A server rollback withdraws an obsolete pending update. Old unreferenced cache files are pruned on the next launch.

Only static app resources and app navigation documents use this pinned cache. API calls, authenticated file downloads and WebSockets continue to use the real Hub. Resource application restarts only this desktop client; it never restarts a Hub/backend or resubmits a chat message. Local browser storage survives restart.

## Shell releases

The standard `electron-updater` flow downloads shell releases automatically and waits for an explicit update action. `autoInstallOnAppQuit` is disabled. If both web and shell updates are downloading, the application waits for both before enabling the button.

```sh
CLOUDCLI_DESKTOP_VERSION=0.1.1 npm run desktop:hub:dist
```

The generic update feed defaults to `https://ai.hwaipy.cn/cloudcli-desktop/releases/`; override it with `CLOUDCLI_DESKTOP_UPDATE_URL` for a release environment. Publish the generated metadata, ZIP/installer and blockmaps together over HTTPS. macOS releases require the ZIP target and a proper Developer ID signing setup for native auto-installation. Configure electron-builder's standard `CSC_LINK`/`CSC_KEY_PASSWORD` or `CSC_NAME`, then notarize through the release configuration before public distribution.

This first local Mac package is explicitly marked as an unsigned test build. It does **not** enable native shell auto-installation; checking updates explains this in the application menu. Web resource download and update/restart are fully available. No shell installation success is claimed without a signed release. Windows NSIS/Linux AppImage targets are configured but are not locally validated on this Mac.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [electron-builder v26 update flow](https://www.electron.build/v26/docs/features/auto-update/).

## Tests

```sh
npm run test:desktop
node scripts/test-hub-desktop.mjs
CLOUDCLI_TEST_DESKTOP_BINARY="$PWD/release/hub/mac-arm64/CloudCLI.app/Contents/MacOS/CloudCLI" node scripts/test-hub-desktop.mjs
```

The native integration test uses an isolated loopback fixture and profile. It verifies that a newer web graph downloads without changing the current page, then actually restarts Electron and checks the new page. It also verifies that `require` is unavailable to remote content. It sends no business requests and stops its own test windows afterwards.

## 0.1.1 Origin forwarding repair

The main-process HTTPS forwarder preserves request options and recovers a missing
write Origin only from the browser-controlled referrer under the configured app
path, with both source and destination matching the configured origin. Existing
Origin values (including `null`) are never replaced. Hub origin enforcement is
unchanged. This requires a new shell package; web resource updates cannot repair
an old shell. Unsigned Mac builds require manual shell replacement.

Run the real Chromium HTTPS regression in an isolated profile:

```sh
node_modules/.bin/electron scripts/test-hub-desktop-network.mjs
```

It trusts only its temporary loopback certificate and checks login reaches password
validation (fixture 401), authenticated JSON and multipart forwarding, and rejection
of writes originating outside the app path. It uses no real credentials or services.

0.1.1 unsigned Apple Silicon test packages are published at:
`https://ai.hwaipy.cn/cloudcli-desktop/releases/CloudCLI-Hub-0.1.1-mac-arm64.dmg`.
The feed `latest-mac.yml` and `SHA256SUMS-0.1.1.txt` accompany the ZIP/DMG and
blockmaps. Download, quit the old app, and replace it manually; account data is
kept separately. No backend restart is involved.

## Signed Mac release setup

Create a **Developer ID Application** certificate in Apple Developer using the
CSR generated on this Mac. Keep its matching private key local, outside the
repository. Install the downloaded certificate and matching key in the login
keychain; `security find-identity -v -p codesigning` must list a valid identity.
An Apple Development/Apple Distribution identity does not replace Developer ID
for this direct-download release.

Save notarization credentials locally using `xcrun notarytool store-credentials
cloudcli-notary` and its interactive prompts. Use an app-specific Apple password
or an appropriate App Store Connect API key. Never place passwords or private
keys in the repo or chat. Validate the profile with `xcrun notarytool history
--keychain-profile cloudcli-notary`.

```sh
CLOUDCLI_DESKTOP_SIGNED=1 \
CSC_NAME="Developer ID Application: YOUR CERTIFICATE NAME (TEAMID)" \
APPLE_KEYCHAIN_PROFILE=cloudcli-notary \
CLOUDCLI_DESKTOP_VERSION=0.1.2 npm run desktop:hub:dist
```

Signed builds require the explicit identity and keychain profile, enforce code
signing, enable hardened runtime, and use electron-builder's notarization and
stapling. Unsigned test builds explicitly disable distribution signing and
notarization; installing a certificate does not silently change a test build.
After building, verify `codesign --verify --deep --strict --verbose=2`,
`xcrun stapler validate`, and `spctl --assess --type execute --verbose=2` against
the app. Verify the DMG's stapled ticket too before publishing. Test an actual
signed-to-signed update using an isolated profile before claiming shell update
installation works. Existing unsigned clients may require one manual replacement
with the first signed package.


### Dedicated local signing keychain

This Mac now uses `~/.config/cloudcli-signing/cloudcli-signing.keychain-db`.
The matching password file and private key stay outside the repository with
private permissions. Default/login keychains and their search list are not
changed. Use the wrapper so the keychain remains available during a long Apple
notarization wait, and is locked after the build:

```sh
node scripts/release/build-signed-hub.mjs 0.1.2 --check-only
node scripts/release/build-signed-hub.mjs 0.1.2
```

The wrapper verifies a Developer ID identity and the `cloudcli-notary` profile,
passes `CSC_KEYCHAIN` and `APPLE_KEYCHAIN` explicitly, and fails on credential or
build errors. It never prints the keychain password. Shell verification in an
isolated fixture can be run with an unlocked keychain:

```sh
CSC_NAME="Example Developer (EXAMPLETEAM)" \
CSC_KEYCHAIN="$HOME/.config/cloudcli-signing/cloudcli-signing.keychain-db" \
CLOUDCLI_TEST_SIGNED_APP="$PWD/release/hub/mac-arm64/CloudCLI.app" \
node scripts/test-hub-desktop-shell.mjs
```

This uses re-signed disposable versioned apps with a unique bundle identifier,
profile and updater cache, exercising actual download, signature validation,
installation and native restart. It does not install over the user's app or
claim that modified fixture apps retain the public package's notarization.
The public package is separately checked with codesign, stapler and Gatekeeper.

### Signed release 0.1.2

0.1.2 is the first Developer ID-signed and Apple-notarized arm64 release.
Both the app and DMG have stapled tickets and pass Gatekeeper. The wrapper also
runs `notarize-hub-dmg.mjs` after packaging: that signs/notarizes/staples the DMG,
then regenerates its block map and update SHA-512/size because stapling changes
container bytes. Publish metadata only after checking the final artifact hashes.

The standalone ZIP and DMG are available under
`https://ai.hwaipy.cn/cloudcli-desktop/releases/`, together with
`SHA256SUMS-0.1.2.txt`. Existing unsigned test installations need one manual app
replacement with this signed version; subsequent signed shell downloads wait for
the user's update/restart action. User data remains in the existing profile.

Verification performed: desktop unit tests; real Electron HTTPS login/JSON/upload
fixture; signed packaged web download/apply/restart; isolated signed shell upgrade
0.1.1 to 0.1.2 using Squirrel.Mac; public ZIP extraction/signature/ticket/Gatekeeper;
DMG signature/notarization/stapling/Gatekeeper and final update metadata hashes.

The header update icon is shown only while an update downloads, is ready, or is
being applied. Idle checks and standalone check errors do not occupy a header
slot. Downloads use a downward arrow/progress ring (details and percentages on
hover); ready updates use the upward update icon and await a click. Both web and
shell channels download automatically when detected; installing/restarting is
still user initiated. Manual checks remain in the native application menu.

The displayed application name is `CloudCLI` starting with 0.1.3. The bundle ID, updater cache identity, download filename prefix and existing `CloudCLI Hub` profile directory remain unchanged for update and login continuity.

On macOS, Cmd+W and the window close button hide the existing window rather than destroying its renderer. Dock activation or reopening the app restores the same view, retaining in-memory session caches, unsent drafts and scroll position. Cmd+Q exits normally; explicit native update installation also bypasses close-to-hide. Hidden renderer timers remain enabled. Run `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron electron/hub/tests/fixtures/window-lifecycle.mjs` to verify real close/reopen and quit behavior.

### System notifications and unread badge (0.1.5)

Browser Web Push and desktop native notifications are separate device channels. Enable each client in Settings → Notifications and grant the relevant OS/browser permission. Browser subscriptions use one service-worker scope per backend so each backend may retain its own VAPID key. Notification clicks preserve the `/cloudcli/` application path and backend/session identity.

The Hub desktop shell opens authenticated notification sockets for every online backend, with reconnect and discovery independent of the selected chat. Registration uses the current Hub account; authentication tokens remain in the renderer transport and are never stored in the native badge file. Native notification settings and unread identities are scoped per account. Viewing a session in the focused visible window clears that session's count. Notifications for the current focused session are suppressed. Dock counts represent distinct backend/session pairs rather than the number of events. Closing with Cmd+W retains reception; explicit quit stops it. macOS must permit notifications for Dock badges to appear. On logout or account change the badge clears and previous-account notifications cannot navigate.

Codex question RPCs additionally emit the existing `permission.required` notification without including the question body or answer. This requires deploying and manually restarting the conversation backends; existing completion/error notification events do not require that backend patch.

Verification: `npm run test:desktop`, frontend notification hooks, Web Push multi-backend scope tests, `node --test scripts/tests/notification-worker.test.mjs`, and provider question notification regressions. Actual banner presentation and Dock badge visibility depend on the user's macOS notification authorization and Focus settings.

Fast consecutive Codex turns: completion/error notification deduplication now includes the native turn ID and user identity. A second turn in the same session must not be swallowed by the prior session-wide 20-second cooldown. Desktop wire events have unique IDs; the reusable session/code tag remains only for notification grouping. Existing Electron 0.1.5 clients are compatible. This backend-only correction takes effect after a manual backend restart. The real macOS focus probe confirmed a visible window loses both application and document focus when switching to another app; regression coverage also checks a quick second completion after the first was read.

### 通知未读计数（0.1.6）

Dock badge 按当前 Hub 账户下不同的 `backendId + sessionId` 计数，同一会话重复通知不会累加。
打开会话且窗口可见并获得焦点、点击对应系统通知、在客户端归档或删除对应会话都会清除该会话的未读记录。
“设置 → 通知”显示本机未读会话数，并提供“全部标为已读”；该操作不会关闭后续通知。
关闭桌面通知也会清空遗留 badge。未读清理能力需要 Electron 壳 0.1.6，旧壳不会显示不支持的清除按钮。
此记录目前是每个客户端独立保存的；在另一台设备或网页阅读不会同步标记本客户端已读。
