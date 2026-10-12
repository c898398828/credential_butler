# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

"凭据管家 · 多站点自动填充" (Credential Butler) is a Manifest V3 Chrome extension for managing multiple credentials per website and autofilling login pages. It features per-origin default accounts, automatic and manual autofill, custom selector matching, secure password generation, and password-encrypted PBKDF2/AES-GCM backups. It contains dedicated compatibility logic for ICBC's treasury cloud (财资云) login portal.

- **Stack**: Pure Vanilla JavaScript (ES2022+), HTML5, CSS3. Zero build steps, zero npm dependencies.
- **Minimum Chrome Version**: 116+ (relies on Manifest V3, Web Locks API, `chrome.scripting.registerContentScripts`, `chrome.sidePanel`).

## Development & Test Commands

The project uses Node.js's built-in test runner (`node:test`).

```bash
# Run all unit and integration tests
node --test tests/*.test.cjs

# Run a single test file
node --test tests/config.test.cjs
node --test tests/vault.test.cjs
node --test tests/site-access.test.cjs
node --test tests/content-race.test.cjs

# CDP-based browser integration tests (requires Chrome started with remote debugging)
node tests/browser-v2.mjs <CDP_PORT>
node tests/live-icbc-v2.mjs <CDP_PORT>

# Rebuild extension icons (requires Python 3 + Pillow)
python tools/make-icons.py
```

### Loading Extension into Chrome
1. Navigate to `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` directory.
4. After making edits to files in `extension/`, click the refresh icon on the extension card in `chrome://extensions`.

## Architecture & Code Structure

The extension uses Chrome's native Side Panel API with a lightweight background service worker to manage panel behavior:

```
extension/
├── manifest.json       # MV3 manifest: storage, activeTab, scripting, sidePanel, optional_host_permissions
├── background.js       # Background service worker: side panel auto-open & action click handler
├── common.js           # Shared utilities: URL normalization, login matching, validation
├── vault.js            # Storage layer: CRUD, Web Locks, v1->v2 migration, AES-GCM backup/import
├── sites.js            # Chrome permissions & dynamic content script registration management
├── content.js          # In-page autofill engine: DOM scanning, Shadow DOM, ICBC Vue adapter
├── popup.html          # Extension side panel / popup UI structure
├── popup.css           # Modern commercial light theme stylesheet (responsive full height)
├── popup.js            # UI controller: account list, editor, tools, reactive tab context
└── icons/              # Extension icons (16, 32, 48, 128px)
```

### Module Responsibilities

1. **`common.js` (`ICBCAutofill` namespace)**:
   - Pure, stateless parsing and validation functions.
   - `originOf(url)`: Extracts scheme, host, and port (normalizes default 80/443).
   - `matchesLoginUrl(pageUrl, savedLoginUrl)`: Enforces exact scheme, host, port, pathname, and `#` hash route match.
   - `normalizeProfile(raw)` / `validateProfile(profile)`: Bounds checking (max 500 profiles, field limits, ICBC-specific 8-char enterprise ID rule).

2. **`vault.js` (`VaultStore` namespace)**:
   - Interacts with `chrome.storage.local` under the `accountVault` key (schema v2: `profiles`, `defaultProfiles` map keyed by origin, and `enabled` boolean).
   - Concurrency serialization using `navigator.locks.request("login-assistant-vault")`.
   - Migration: Transparently upgrades v1 `defaultProfile` to v2 format on load, ensuring zero data loss.
   - Backup: Encrypted with PBKDF2-SHA256 (100,000 iterations) + AES-GCM with 128-bit authentication tag. Import enforces 8 MB ceiling and deduplicates records without overwriting existing passwords.

3. **`sites.js` (`SiteAccess` namespace)**:
   - Manages Chrome's optional permissions (`chrome.permissions.request({ origins: [...] })`).
   - Dynamic script lifecycle: Registers/unregisters top-frame content scripts via `chrome.scripting.registerContentScripts` scoped to authorized origins.
   - Dispatch: When triggering manual fill from popup, sends only the `profileId` via message; content script reads credentials from storage directly.

4. **`content.js`**:
   - Injected into top frames only (`window.top === window`) at `document_start`.
   - Traverses standard DOM and open Shadow DOM trees.
   - Heuristics: Detects visible, non-disabled username and password fields; deliberately ignores OTP/2FA, new-password, and password confirmation fields.
   - Race-condition safeguards: Aborts credential fill if user types, the DOM node is replaced, or URL route changes during asynchronous processing.
   - ICBC Adapter: Custom logic for Vue 2/Element UI `.ComPasswordInput` component; emits synthetic input events and manages masked asterisk fields.

## Key Development Rules & Invariants

- **Never pass plain credentials across runtime messages**: The popup only sends profile IDs to content scripts; the content script reads the record directly from `chrome.storage.local`.
- **Top frame isolation**: Content scripts and injections must strictly enforce `all_frames: false` / `window.top === window`.
- **Scope matching**: Always match origin, pathname, and hash route. Never match cross-origin or cross-port.
- **Test with fictional data only**: Never commit or include real credentials or personal data in tests or source files.
