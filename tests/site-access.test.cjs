"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "sites.js"), "utf8");
const SITE_A = "https://accounts.example.test";
const SITE_B = "https://work.example.test";
const SITE_C = "https://third.example.test";
const ICBC_ORIGIN = "https://toc.icbc.com.cn";
const ICBC_URL = `${ICBC_ORIGIN}/login.html#/login`;
const PATTERN_A = "https://accounts.example.test:443/*";
const PATTERN_B = "https://work.example.test:443/*";
const PATTERN_C = "https://third.example.test:443/*";
const ICBC_PATTERN = "https://toc.icbc.com.cn:443/*";
const TAB_ID = 17;
const FILL_NOW = "test:fill-now";
const PREFIX = "login-assistant-site-";
const MISSING_RECEIVER = "Could not establish connection. Receiving end does not exist.";
const FILLED = Object.freeze({ ok: true, status: "filled" });

function profile(id = "alpha", loginUrl = `${SITE_A}/login#/signin`) {
  return {
    id, loginUrl,
    name: `Fictional ${id}`,
    enterpriseId: "E1234567",
    username: `fictional-user-${id}`,
    password: "fictional-only-password",
  };
}

function ownedId(origin) {
  return PREFIX + Buffer.from(origin).toString("base64url");
}

// These stubs deliberately cover only exact fixture URLs. common.js has its own
// normalization/matching tests; this suite checks Chrome API access boundaries.
function siteOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function isProfilePage(saved, value) {
  try {
    const expected = new URL(saved.loginUrl);
    const actual = new URL(value);
    return siteOrigin(value) !== null && expected.origin === actual.origin
      && expected.pathname === actual.pathname && expected.hash === actual.hash;
  } catch {
    return false;
  }
}

function createAccess(options = {}) {
  const {
    profiles = [profile()],
    grantedPatterns = [],
    registered = [],
    activeTab = { id: TAB_ID, url: `${SITE_A}/login#/signin` },
    requestResult = true,
    messageResults = [FILLED],
    loadError,
    tabError,
    containsError,
    injectionError,
  } = options;
  const granted = new Set(grantedPatterns);
  const scripts = new Map(registered.map((script) => [script.id, structuredClone(script)]));
  const outcomes = [...messageResults];
  const events = [];
  const record = (method, details) => {
    events.push({ method, details: structuredClone(details) });
  };
  const chrome = {
    permissions: {
      request(details) {
        record("permissions.request", details);
        return Promise.resolve(requestResult).then((result) => {
          if (result) for (const origin of details.origins) granted.add(origin);
          return result;
        });
      },
      async contains(details) {
        record("permissions.contains", details);
        if (containsError) throw containsError;
        return details.origins.every((origin) => granted.has(origin));
      },
    },
    scripting: {
      async getRegisteredContentScripts() {
        record("scripts.get", undefined);
        return [...scripts.values()].map((script) => structuredClone(script));
      },
      async registerContentScripts(definitions) {
        record("scripts.register", definitions);
        for (const script of definitions) {
          assert.equal(scripts.has(script.id), false, "Chrome rejects duplicate registered IDs");
          scripts.set(script.id, structuredClone(script));
        }
      },
      async updateContentScripts(definitions) {
        record("scripts.update", definitions);
        for (const script of definitions) {
          assert.ok(scripts.has(script.id), "only registered scripts may be updated");
          scripts.set(script.id, { ...scripts.get(script.id), ...structuredClone(script) });
        }
      },
      async unregisterContentScripts(details) {
        record("scripts.unregister", details);
        for (const id of details.ids) scripts.delete(id);
      },
      async executeScript(details) {
        record("scripts.execute", details);
        if (injectionError) throw injectionError;
        return [{ frameId: 0 }];
      },
    },
    tabs: {
      async query(details) {
        record("tabs.query", details);
        return activeTab ? [structuredClone(activeTab)] : [];
      },
      async get(tabId) {
        record("tabs.get", { tabId });
        if (tabError) throw tabError;
        return structuredClone(activeTab);
      },
      async sendMessage(tabId, message, options) {
        record("tabs.sendMessage", { tabId, message, options });
        const result = outcomes.length ? outcomes.shift() : FILLED;
        if (result instanceof Error) throw result;
        return structuredClone(result);
      },
    },
  };
  const context = vm.createContext({
    URL, btoa, chrome,
    ICBCAutofill: {
      siteOrigin, isProfilePage,
      getProfile(vault, id, url) {
        return vault.profiles.find((entry) => entry.id === id && isProfilePage(entry, url)) || null;
      },
      MESSAGE: { FILL_NOW },
    },
    VaultStore: {
      async load() {
        record("vault.load", undefined);
        if (loadError) throw loadError;
        return { profiles: structuredClone(profiles) };
      },
    },
  });
  vm.runInContext(source, context, { filename: "sites.js" });
  return {
    api: context.SiteAccess,
    events,
    scripts,
    calls: (method) => events.filter((event) => event.method === method).map((event) => event.details),
  };
}

function assertNoPageAccess(browser) {
  assert.deepEqual(browser.calls("scripts.execute"), [], "no script may be injected");
  assert.deepEqual(browser.calls("tabs.sendMessage"), [], "no message may be sent to the page");
}

function assertTopFrameInjection(browser, count = 1) {
  assert.deepEqual(browser.calls("scripts.execute"), Array.from({ length: count }, () => ({
    target: { tabId: TAB_ID, frameIds: [0] },
    files: ["common.js", "content.js"],
  })));
}

function assertIdOnlyMessages(browser, count = 1, profileId = "alpha") {
  assert.deepEqual(browser.calls("tabs.sendMessage"), Array.from({ length: count }, () => ({
    tabId: TAB_ID,
    message: { type: FILL_NOW, profileId },
    options: { frameId: 0 },
  })), "page messages contain only the chosen profile ID, never saved fields");
}

test("permission prompts request one exact scheme, host, and port immediately in the caller's activation", async () => {
  const browser = createAccess();
  for (const [url, pattern] of [
    [`${SITE_A}/login?from=dashboard#/signin`, PATTERN_A],
    ["https://WORK.EXAMPLE.TEST:443/session/new", PATTERN_B],
    ["http://intranet.example.test/login", "http://intranet.example.test:80/*"],
  ]) {
    const previous = browser.calls("permissions.request").length;
    const request = browser.api.requestForUrl(url);
    assert.equal(browser.calls("permissions.request").length, previous + 1, "request must not wait for storage or another async step");
    assert.deepEqual(browser.calls("permissions.request").at(-1), { origins: [pattern] });
    assert.equal(await request, true);
  }
  assert.equal(browser.events.every((event) => event.method === "permissions.request"), true);
  assertNoPageAccess(browser);
});

test("invalid or non-web URLs do not reach Chrome's permission APIs", async () => {
  const browser = createAccess();
  for (const url of ["", "not a URL", "<all_urls>", "javascript:alert(1)", "file:///tmp/login", "chrome://settings", "ftp://example.test/login"]) {
    assert.throws(() => browser.api.requestForUrl(url), /有效/);
    assert.equal(await browser.api.canAccessUrl(url), false);
  }
  assert.deepEqual(browser.events, []);
});

test("access checks remain scoped to the requested site's origin and never request permission", async () => {
  const browser = createAccess({ grantedPatterns: [PATTERN_A] });
  assert.equal(await browser.api.canAccessUrl(`${SITE_A}/different-path`), true);
  assert.equal(await browser.api.canAccessUrl(`${SITE_B}/login`), false);
  assert.deepEqual(browser.calls("permissions.contains"), [
    { origins: [PATTERN_A] }, { origins: [PATTERN_B] },
  ]);
  assert.deepEqual(browser.calls("permissions.request"), []);
  assertNoPageAccess(browser);
});

test("non-default localhost, LAN, and IPv6 ports survive permission requests, checks, and registration", async (t) => {
  for (const [name, origin] of [
    ["localhost", "http://localhost:3000"],
    ["loopback IPv4", "http://127.0.0.1:8765"],
    ["LAN HTTPS", "https://192.168.1.10:8443"],
    ["loopback IPv6", "http://[::1]:8080"],
  ]) {
    await t.test(name, async () => {
      const loginUrl = `${origin}/login`;
      const expectedPattern = `${origin}/*`;
      const browser = createAccess({
        profiles: [profile("alpha", loginUrl)],
        activeTab: { id: TAB_ID, url: loginUrl },
      });
      assert.equal(await browser.api.ensureForUrl(loginUrl), true);
      assert.deepEqual(browser.calls("permissions.request"), [{ origins: [expectedPattern] }]);
      assert.equal(await browser.api.canAccessUrl(loginUrl), true);
      assert.deepEqual(browser.calls("permissions.contains"), [
        { origins: [expectedPattern] }, { origins: [expectedPattern] },
      ]);
      assert.deepEqual([...browser.scripts.values()].map((script) => ({ id: script.id, matches: script.matches })), [
        { id: ownedId(origin), matches: [expectedPattern] },
      ]);
      assert.deepEqual(structuredClone(await browser.api.fill(TAB_ID, "alpha")), FILLED);
      assertTopFrameInjection(browser);
      assertIdOnlyMessages(browser);
    });
  }
});

test("implicit and explicit default ports share origin IDs while all permission and registration patterns name the port", async () => {
  const httpOrigin = "http://intranet.example.test";
  const httpPattern = "http://intranet.example.test:80/*";
  const profiles = [
    profile("https-default", `${SITE_A}/login`),
    profile("https-explicit", `${SITE_A}:443/another-login`),
    profile("http-default", `${httpOrigin}/login`),
    profile("http-explicit", `${httpOrigin}:80/another-login`),
  ];
  const browser = createAccess({ profiles, grantedPatterns: [PATTERN_A, httpPattern], activeTab: null });
  for (const saved of profiles) assert.equal(await browser.api.requestForUrl(saved.loginUrl), true);
  assert.deepEqual(browser.calls("permissions.request"), [
    { origins: [PATTERN_A] }, { origins: [PATTERN_A] },
    { origins: [httpPattern] }, { origins: [httpPattern] },
  ]);
  await browser.api.sync();
  assert.deepEqual(browser.calls("permissions.contains"), [{ origins: [PATTERN_A] }, { origins: [httpPattern] }]);
  assert.deepEqual([...browser.scripts.values()].map((script) => ({ id: script.id, matches: script.matches })), [
    { id: ownedId(SITE_A), matches: [PATTERN_A] },
    { id: ownedId(httpOrigin), matches: [httpPattern] },
  ]);
  assertNoPageAccess(browser);
});

test("different ports on one host retain independent permission, registration, and filling boundaries", async (t) => {
  const originA = "http://localhost:3000";
  const originB = "http://localhost:3001";
  const patternA = "http://localhost:3000/*";
  const patternB = "http://localhost:3001/*";
  for (const [name, grantedPatterns] of [
    ["only the first port is authorized", [patternA]],
    ["both ports are separately authorized", [patternA, patternB]],
  ]) {
    await t.test(name, async () => {
      const browser = createAccess({
        profiles: [profile("alpha", `${originA}/login`), profile("beta", `${originB}/login`)],
        activeTab: { id: TAB_ID, url: `${originB}/login` },
        grantedPatterns,
      });
      await browser.api.sync();
      const definitions = [...browser.scripts.values()];
      assert.deepEqual(definitions.map((script) => script.matches), grantedPatterns.map((pattern) => [pattern]));
      assert.deepEqual(definitions.map((script) => script.id), [ownedId(originA), ownedId(originB)].slice(0, grantedPatterns.length));
      assert.deepEqual(structuredClone(await browser.api.fill(TAB_ID, "alpha")), { ok: false, status: "wrong-page" });
      assert.deepEqual(browser.calls("tabs.sendMessage"), [], "an account on another port must never receive a fill request");
      const result = structuredClone(await browser.api.fill(TAB_ID, "beta"));
      if (grantedPatterns.includes(patternB)) {
        assert.deepEqual(result, FILLED);
        assertTopFrameInjection(browser);
        assertIdOnlyMessages(browser, 1, "beta");
      } else {
        assert.deepEqual(result, { ok: false, status: "permission-required" });
        assertNoPageAccess(browser);
      }
      assert.deepEqual(browser.calls("permissions.request"), []);
    });
  }
});

test("denying a permission request never loads the vault, synchronizes scripts, or accesses a page", async () => {
  const browser = createAccess({ requestResult: false });
  assert.equal(await browser.api.ensureForUrl(`${SITE_A}/login#/signin`), false);
  assert.deepEqual(browser.events, [{
    method: "permissions.request", details: { origins: [PATTERN_A] },
  }]);
  assert.equal(browser.scripts.size, 0);
  assertNoPageAccess(browser);
});

test("granting permission synchronizes only after the decision and activates a matching open login page", async () => {
  let answer;
  const requestResult = new Promise((resolve) => { answer = resolve; });
  const browser = createAccess({ requestResult });
  const pending = browser.api.ensureForUrl(`${SITE_A}/login#/signin`);
  assert.deepEqual(browser.events.map((event) => event.method), ["permissions.request"]);
  answer(true);
  assert.equal(await pending, true);
  assert.equal(browser.calls("vault.load").length, 1);
  assert.equal(browser.scripts.size, 1);
  assertTopFrameInjection(browser);
  assert.deepEqual(browser.calls("tabs.sendMessage"), []);
});

test("sync creates one persistent top-frame script per authorized origin and skips the static ICBC origin", async () => {
  const browser = createAccess({
    profiles: [
      profile("a1"), profile("a2", `${SITE_A}/another-login`), profile("blocked", `${SITE_B}/login`),
      profile("c", `${SITE_C}/signin`), profile("bank", ICBC_URL), profile("invalid", "chrome://settings"),
    ],
    grantedPatterns: [PATTERN_A, PATTERN_C, ICBC_PATTERN],
    activeTab: { id: TAB_ID, url: "about:blank" },
  });
  await browser.api.sync();
  assert.deepEqual(browser.calls("permissions.contains"), [
    { origins: [PATTERN_A] }, { origins: [PATTERN_B] },
    { origins: [PATTERN_C] }, { origins: [ICBC_PATTERN] },
  ]);
  const definitions = browser.calls("scripts.register").flat();
  assert.equal(definitions.length, 2);
  assert.deepEqual(definitions.map((script) => script.matches), [[PATTERN_A], [PATTERN_C]]);
  assert.equal(new Set(definitions.map((script) => script.id)).size, 2);
  for (const script of definitions) {
    assert.ok(script.id.startsWith(PREFIX));
    assert.deepEqual(script.js, ["common.js", "content.js"]);
    assert.equal(script.persistAcrossSessions, true);
    assert.equal(script.allFrames, false);
    assert.equal(script.runAt, "document_start");
    assert.equal(script.world, "ISOLATED");
  }
  assert.deepEqual(browser.calls("permissions.request"), []);
  assert.equal(browser.scripts.size, 2);
  assertNoPageAccess(browser);
});

test("sync updates existing owned registrations, removes stale owned IDs, and preserves unrelated scripts", async () => {
  const unrelated = { id: "another-feature-script", matches: [`${SITE_B}/*`], js: ["unrelated.js"] };
  const stale = { id: `${PREFIX}obsolete-installation`, matches: [`${SITE_C}/*`], js: ["old.js"] };
  const browser = createAccess({
    grantedPatterns: [PATTERN_A],
    registered: [
      { id: ownedId(SITE_A), matches: [`${SITE_A}/*`], js: ["outdated.js"] },
      stale, unrelated,
    ],
    activeTab: null,
  });
  await browser.api.sync();
  assert.deepEqual(browser.calls("scripts.unregister"), [{ ids: [stale.id] }]);
  assert.deepEqual(browser.calls("scripts.register"), []);
  assert.deepEqual(browser.calls("scripts.update").flat().map((script) => script.id), [ownedId(SITE_A)]);
  assert.deepEqual(browser.scripts.get(ownedId(SITE_A)).js, ["common.js", "content.js"]);
  assert.deepEqual(browser.scripts.get(ownedId(SITE_A)).matches, [PATTERN_A], "existing registrations narrow their old all-port pattern without changing IDs");
  assert.deepEqual(browser.scripts.get(unrelated.id), unrelated);
  assert.equal(browser.scripts.size, 2);
  await browser.api.sync();
  assert.equal(browser.calls("scripts.unregister").length, 1, "a repeated sync does not attempt stale removals again");
  assert.deepEqual(browser.calls("scripts.register"), []);
  assert.deepEqual(browser.scripts.get(unrelated.id), unrelated);
  assertNoPageAccess(browser);
});

test("revoked host permission removes its old registration even when an account and login tab remain", async () => {
  const browser = createAccess({
    registered: [{ id: ownedId(SITE_A), matches: [`${SITE_A}/*`], js: ["common.js", "content.js"] }],
  });
  await browser.api.sync();
  assert.deepEqual(browser.calls("scripts.unregister"), [{ ids: [ownedId(SITE_A)] }]);
  assert.equal(browser.scripts.size, 0);
  assert.deepEqual(browser.calls("scripts.register"), []);
  assertNoPageAccess(browser);
});

test("sync injects into the active tab only when a saved login page matches and that origin is authorized", async (t) => {
  for (const [name, activeTab, expected] of [
    ["matching login", { id: TAB_ID, url: `${SITE_A}/login#/signin` }, true],
    ["matching static ICBC login", { id: TAB_ID, url: ICBC_URL }, true],
    ["same-origin non-login path", { id: TAB_ID, url: `${SITE_A}/settings#/signin` }, false],
    ["wrong hash route", { id: TAB_ID, url: `${SITE_A}/login#/reset` }, false],
    ["lookalike host", { id: TAB_ID, url: `${SITE_A}.evil.test/login#/signin` }, false],
    ["HTTP is a distinct origin", { id: TAB_ID, url: "http://accounts.example.test/login#/signin" }, false],
    ["saved but unauthorized site", { id: TAB_ID, url: `${SITE_B}/login` }, false],
    ["authorized site without an account", { id: TAB_ID, url: `${SITE_C}/login` }, false],
    ["no tab ID", { url: `${SITE_A}/login#/signin` }, false],
    ["no active tab", null, false],
  ]) {
    await t.test(name, async () => {
      const browser = createAccess({
        profiles: [profile(), profile("blocked", `${SITE_B}/login`), profile("bank", ICBC_URL)],
        grantedPatterns: [PATTERN_A, PATTERN_C, ICBC_PATTERN],
        activeTab,
      });
      await browser.api.sync();
      assertTopFrameInjection(browser, expected ? 1 : 0);
      assert.deepEqual(browser.calls("tabs.sendMessage"), []);
      assert.deepEqual(browser.calls("tabs.query"), [{ active: true, currentWindow: true }]);
    });
  }
});

test("fill rejects unknown accounts and nonmatching URLs before any page access", async (t) => {
  for (const [name, url, id] of [
    ["unknown account", `${SITE_A}/login#/signin`, "missing"],
    ["another account's website", `${SITE_A}/login#/signin`, "beta"],
    ["different origin", `${SITE_B}/login#/signin`, "alpha"],
    ["same-origin non-login page", `${SITE_A}/dashboard#/signin`, "alpha"],
    ["different hash route", `${SITE_A}/login#/forgot`, "alpha"],
    ["lookalike origin", `${SITE_A}.evil.test/login#/signin`, "alpha"],
  ]) {
    await t.test(name, async () => {
      const browser = createAccess({
        profiles: [profile(), profile("beta", `${SITE_B}/login#/signin`)],
        grantedPatterns: [PATTERN_A, PATTERN_B],
        activeTab: { id: TAB_ID, url },
      });
      assert.deepEqual(structuredClone(await browser.api.fill(TAB_ID, id)), { ok: false, status: "wrong-page" });
      assert.deepEqual(browser.calls("permissions.contains"), []);
      assert.deepEqual(browser.calls("permissions.request"), []);
      assertNoPageAccess(browser);
    });
  }
});

test("fill on a matching but unauthorized page sends no message, injects no script, and does not prompt", async () => {
  const browser = createAccess();
  assert.deepEqual(structuredClone(await browser.api.fill(TAB_ID, "alpha")), { ok: false, status: "permission-required" });
  assert.deepEqual(browser.calls("permissions.contains"), [{ origins: [PATTERN_A] }]);
  assert.deepEqual(browser.calls("permissions.request"), []);
  assertNoPageAccess(browser);
});

test("an existing content listener receives only a profile ID in the top frame without reinjection", async (t) => {
  for (const response of [FILLED, { ok: false, status: "user-edited" }]) {
    await t.test(response.status, async () => {
      const browser = createAccess({ grantedPatterns: [PATTERN_A], messageResults: [response] });
      assert.deepEqual(structuredClone(await browser.api.fill(TAB_ID, "alpha")), response);
      assertIdOnlyMessages(browser);
      assert.deepEqual(browser.calls("scripts.execute"), []);
      assert.deepEqual(browser.calls("permissions.request"), []);
    });
  }
});

test("a missing content receiver triggers one top-frame injection followed by one ID-only retry", async () => {
  const browser = createAccess({
    grantedPatterns: [PATTERN_A],
    messageResults: [new Error(MISSING_RECEIVER), FILLED],
  });
  assert.deepEqual(structuredClone(await browser.api.fill(TAB_ID, "alpha")), FILLED);
  assertTopFrameInjection(browser);
  assertIdOnlyMessages(browser, 2);
  assert.deepEqual(browser.events.filter((event) => ["tabs.sendMessage", "scripts.execute"].includes(event.method))
    .map((event) => event.method), ["tabs.sendMessage", "scripts.execute", "tabs.sendMessage"]);
});

test("communication failures or an empty reply do not prove a missing receiver and must not inject again", async (t) => {
  for (const [name, response] of [
    ["listener closed its port", new Error("The message port closed before a response was received.")],
    ["tab was closed", new Error(`No tab with id: ${TAB_ID}.`)],
    ["permission was revoked", new Error("Cannot access contents of the page. Extension manifest must request permission.")],
    ["listener returned no response", undefined],
  ]) {
    await t.test(name, async () => {
      const browser = createAccess({ grantedPatterns: [PATTERN_A], messageResults: [response] });
      const result = await browser.api.fill(TAB_ID, "alpha");
      assert.deepEqual(browser.calls("scripts.execute"), [], "only the explicit missing-receiver error permits fallback injection");
      assertIdOnlyMessages(browser);
      assert.notEqual(result?.ok, true);
    });
  }
});

test("failed fallback injection stops before retrying a page message", async () => {
  const browser = createAccess({
    grantedPatterns: [PATTERN_A],
    messageResults: [new Error(MISSING_RECEIVER)],
    injectionError: new Error("Page navigated before script injection"),
  });
  const result = await browser.api.fill(TAB_ID, "alpha");
  assert.equal(result?.ok, false);
  assertTopFrameInjection(browser);
  assertIdOnlyMessages(browser);
});

test("tab, vault, and permission-check failures stop before page injection or messaging", async (t) => {
  for (const key of ["tabError", "loadError", "containsError"]) {
    await t.test(key, async () => {
      const browser = createAccess({ grantedPatterns: [PATTERN_A], [key]: new Error(`Fictional ${key} detail`) });
      const result = await browser.api.fill(TAB_ID, "alpha");
      assert.equal(result?.ok, false);
      assertNoPageAccess(browser);
    });
  }
});
