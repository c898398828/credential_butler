"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.join(__dirname, "..", "extension");
const commonSource = fs.readFileSync(path.join(directory, "common.js"), "utf8");
const vaultSource = fs.readFileSync(path.join(directory, "vault.js"), "utf8");
const ICBC_URL = "https://toc.icbc.com.cn/login.html#/login";
const ICBC_ORIGIN = "https://toc.icbc.com.cn";
const SITE_A = "https://accounts.example.test";
const SITE_B = "https://work.example.test";
const SITE_C = "https://third.example.test";
// All credentials are fictional. Spaces, Unicode, and line endings must survive unchanged.
const PASSWORD = "  Fictional*密码🙂\t \r\n";
const PASSPHRASE = "  Fictional backup 口令🙂  ";
const legacy = Object.freeze({ enterpriseId: "E1234567", username: "legacy-demo", password: PASSWORD, enabled: false });

function profile(id = "alpha", values = {}) {
  return {
    id,
    name: `测试 ${id}`,
    loginUrl: `${SITE_A}/login`,
    enterpriseId: "",
    username: `demo-${id}`,
    password: PASSWORD,
    selectors: { enterpriseId: "", username: "", password: "" },
    createdAt: 1234,
    updatedAt: 2345,
    ...values,
  };
}

function vault(profiles = [], defaultProfiles = {}, enabled = true) {
  return { version: 2, profiles, defaultProfiles, defaultProfileId: defaultProfiles[ICBC_ORIGIN] || "", enabled };
}

function createMemory(initial = {}) {
  const memory = {
    state: structuredClone(initial), events: [], failReads: 0, failWrites: 0, failRemovals: 0,
  };
  memory.local = {
    async get(keys) {
      memory.events.push("get");
      if (memory.failReads > 0) {
        memory.failReads -= 1;
        throw new Error(`Internal storage detail ${PASSWORD}`);
      }
      const selected = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (Object.hasOwn(memory.state, key)) selected[key] = structuredClone(memory.state[key]);
      }
      return selected;
    },
    async set(values) {
      memory.events.push("set");
      if (memory.failWrites > 0) {
        memory.failWrites -= 1;
        throw new Error(`Internal storage detail ${PASSWORD}`);
      }
      Object.assign(memory.state, structuredClone(values));
    },
    async remove(key) {
      memory.events.push(`remove:${key}`);
      if (memory.failRemovals > 0) {
        memory.failRemovals -= 1;
        throw new Error("Removal failed");
      }
      delete memory.state[key];
    },
  };
  return memory;
}

function createLocks() {
  let tail = Promise.resolve();
  const names = [];
  return {
    names,
    request(name, action) {
      names.push(name);
      const result = tail.then(action);
      tail = result.catch(() => {});
      return result;
    },
  };
}

function createStore({ initial = {}, memory = createMemory(initial), locks, crypto = webcrypto } = {}) {
  const globals = {
    URL, crypto, TextEncoder, TextDecoder, atob, btoa,
    chrome: { storage: { local: memory.local } },
  };
  if (locks) globals.navigator = { locks };
  const context = vm.createContext(globals);
  vm.runInContext(commonSource, context, { filename: "common.js" });
  vm.runInContext(vaultSource, context, { filename: "vault.js" });
  return { api: context.ICBCAutofill, store: context.VaultStore, memory, context };
}

async function externalBackup(payload, passphrase = PASSPHRASE) {
  // Produce authenticated payloads independently, including structurally invalid ones.
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const metadata = {
    format: "icbc-autofill-backup", version: 1, kdf: "PBKDF2", hash: "SHA-256", iterations: 250000,
    cipher: "AES-GCM", salt: Buffer.from(salt).toString("base64"), iv: Buffer.from(iv).toString("base64"),
  };
  const material = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const encrypted = await webcrypto.subtle.encrypt({
    name: "AES-GCM", iv, tagLength: 128,
    additionalData: new TextEncoder().encode(JSON.stringify(metadata)),
  }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({ ...metadata, ciphertext: Buffer.from(encrypted).toString("base64") });
}

test("website URL normalization accepts HTTP(S) and rejects credentials, scripts, and malformed addresses", () => {
  const { api } = createStore();
  const cases = [
    [" example.test/login?lang=zh#/signin ", "https://example.test/login?lang=zh#/signin"],
    ["HTTPS://EXAMPLE.TEST:443/login", "https://example.test/login"],
    ["localhost:3000/login", "https://localhost:3000/login"],
    ["http://localhost:3000/login", "http://localhost:3000/login"],
    ["//example.test", "https://example.test/"],
  ];
  for (const [value, expected] of cases) assert.equal(api.normalizeSiteUrl(value), expected);
  for (const value of [
    null, "", "   ", "not a URL", "javascript:alert(1)", "data:text/html,hello", "file:///tmp/login",
    "ftp://example.test/login", "chrome://settings", "https://user:secret@example.test/login",
    "https://@example.test/login", "https://example.test\n.evil.test/login", "https://",
  ]) {
    assert.equal(api.normalizeSiteUrl(value), "", String(value));
    assert.equal(api.siteOrigin(value), null, String(value));
  }
  assert.equal(api.siteOrigin("https://EXAMPLE.TEST:443/path#part"), "https://example.test");
});

test("profiles preserve exact passwords and apply company rules only where required", () => {
  const { api } = createStore();
  const normalized = api.normalizeProfile({
    ...profile(), name: "   ", username: "  fictional-user  ", enterpriseId: " org ", extra: "discard",
  });
  assert.equal(normalized.name, "fictional-user");
  assert.equal(normalized.username, "fictional-user");
  assert.equal(normalized.enterpriseId, "org");
  assert.equal(normalized.password, PASSWORD);
  assert.equal(Object.hasOwn(normalized, "extra"), false);
  assert.equal(api.normalizeProfile({}).name, "默认账号");
  assert.equal(api.normalizeProfile({ name: "界".repeat(50) }).name.length, 40);
  assert.equal(api.validateProfile(profile()), null);
  assert.equal(api.validateProfile(profile("a", { enterpriseId: "X".repeat(128) })), null);
  assert.match(api.validateProfile(profile("a", { enterpriseId: "X".repeat(129) })), /128/);
  assert.equal(api.validateProfile(profile("a", { username: "u".repeat(300), password: "x".repeat(5000) })), null);
  assert.equal(api.validateProfile(profile("a", { password: " " })), null);
  assert.match(api.validateProfile(profile("a", { loginUrl: ICBC_URL })), /企业编号/);
  assert.equal(api.validateProfile(profile("a", { loginUrl: ICBC_URL, enterpriseId: "E1234567" })), null);
  assert.match(api.validateProfile(profile("a", { loginUrl: ICBC_URL, enterpriseId: "123456789" })), /8/);
  for (const changes of [{ loginUrl: "" }, { loginUrl: "javascript:1" }, { username: "" }, { password: "" }]) {
    assert.equal(typeof api.validateProfile(profile("a", changes)), "string");
  }
  assert.match(api.validateProfile(profile("a", { loginUrl: `${ICBC_ORIGIN}/login.html#/forgot` })), /登录页/);
});

test("custom selectors retain only known fields, trim spacing, and reject excessive or invalid values before saving", async () => {
  const { api, store, memory } = createStore();
  const selectors = { enterpriseId: " #company ", username: " input[type=email] ", password: " #password ", extra: "ignored" };
  assert.deepEqual(structuredClone(api.normalizeProfile({ selectors }).selectors), {
    enterpriseId: "#company", username: "input[type=email]", password: "#password",
  });
  assert.deepEqual(structuredClone(api.normalizeProfile({}).selectors), { enterpriseId: "", username: "", password: "" });
  for (const invalid of [{ username: "x".repeat(257) }, { password: 123 }, []]) {
    assert.match(api.validateProfile(profile("a", { selectors: invalid })), /选择器/);
    await assert.rejects(store.saveProfile(profile("a", { selectors: invalid })), /选择器/);
  }
  assert.deepEqual(memory.events, []);
  const result = await store.saveProfile({ loginUrl: `${SITE_A}/login`, username: "custom", password: PASSWORD, selectors });
  assert.equal(result.profiles[0].selectors.password, "#password");
  assert.equal(Object.hasOwn(result.profiles[0].selectors, "extra"), false);
});

test("page matching isolates origins, login paths, hash routes, and the strict ICBC login route", () => {
  const { api } = createStore();
  const saved = profile("a", { loginUrl: `${SITE_A}/login/?source=one#/signin?return=home` });
  assert.equal(api.isProfilePage(saved, `${SITE_A}/login?source=two#/signin/?return=other`), true);
  for (const url of [
    `${SITE_B}/login/#/signin`, `${SITE_A}.evil.test/login/#/signin`, `${SITE_A}:444/login/#/signin`,
    `${SITE_A}/reset/#/signin`, `${SITE_A}/login/#/forgot`, `${SITE_A}/login`,
    "http://accounts.example.test/login/#/signin",
  ]) assert.equal(api.isProfilePage(saved, url), false, url);
  assert.equal(api.isProfilePage(profile(), `${SITE_A}/login/?return=other#/signin`), true);
  const icbc = profile("bank", { loginUrl: ICBC_URL, enterpriseId: "E1234567" });
  assert.equal(api.isProfilePage(icbc, "https://toc.icbc.com.cn/login.html?lang=zh#/login/?return=home"), true);
  for (const url of [
    "https://toc.icbc.com.cn/login.html#/forgot", "https://toc.icbc.com.cn/login.html#/account",
    "https://toc.icbc.com.cn/other.html#/login", "https://toc.icbc.com.cn.evil.test/login.html#/login",
  ]) assert.equal(api.isProfilePage(icbc, url), false, url);
});

test("default lookup is per website and never falls back to the first or a different site", () => {
  const { api } = createStore();
  const one = profile("a");
  const two = profile("b", { loginUrl: `${SITE_B}/signin` });
  const normalized = api.normalizeVault(vault([one, two], { [SITE_A]: one.id, [SITE_B]: two.id }));
  assert.equal(api.getProfile(normalized, undefined, `${SITE_A}/login`).id, one.id);
  assert.equal(api.getProfile(normalized, undefined, `${SITE_B}/signin?next=home`).id, two.id);
  assert.equal(api.getProfile(normalized, two.id).id, two.id);
  assert.equal(api.getProfile(normalized, two.id, `${SITE_A}/login`), null);
  assert.equal(api.getProfile(normalized, undefined, `${SITE_A}/forgot`), null);
  assert.equal(api.getProfile(normalized, "missing"), null);
  const cleared = api.normalizeVault(vault([one, two], { [SITE_A]: "missing", [SITE_B]: one.id }));
  assert.equal(cleared.defaultProfiles[SITE_A], "");
  assert.equal(cleared.defaultProfiles[SITE_B], "");
  assert.equal(api.getProfile(cleared, undefined, `${SITE_A}/login`), null);
});

test("legacy credentials migrate once, including Unicode, whitespace, disabled state, and stable identity", async () => {
  const { api, store, memory } = createStore({ initial: { defaultProfile: legacy, unrelated: { keep: true } } });
  const migrated = await store.load();
  assert.equal(migrated.profiles[0].id, "legacy-default");
  assert.equal(migrated.profiles[0].loginUrl, ICBC_URL);
  assert.equal(migrated.profiles[0].password, PASSWORD);
  assert.equal(migrated.profiles[0].createdAt, 0);
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.defaultProfiles[ICBC_ORIGIN], "legacy-default");
  assert.equal(migrated.defaultProfileId, "legacy-default");
  assert.equal(api.getProfile(migrated).username, legacy.username);
  assert.equal(Object.hasOwn(memory.state, "defaultProfile"), false);
  assert.deepEqual(memory.events, ["get", "set", "remove:defaultProfile"]);
  assert.deepEqual(memory.state.unrelated, { keep: true });
  await store.load();
  assert.equal(memory.events.filter((event) => event === "set").length, 1);
});

test("incomplete legacy profiles remain recoverable but cannot be filled", async () => {
  const { api, store } = createStore({ initial: { defaultProfile: { enterpriseId: "", password: PASSWORD, enabled: true } } });
  const migrated = await store.load();
  assert.equal(migrated.profiles.length, 1);
  assert.equal(migrated.profiles[0].password, PASSWORD);
  assert.equal(migrated.profiles[0].username, "");
  assert.equal(typeof api.validateProfile(api.getProfile(migrated)), "string");
});

test("an earlier v2 ICBC vault upgrades URLs and per-site defaults without changing credentials", async () => {
  const old = profile("saved-bank", { enterpriseId: "E1234567" });
  delete old.loginUrl;
  const { store, memory } = createStore({ initial: { accountVault: {
    version: 2, profiles: [old], defaultProfileId: old.id, enabled: false,
  } } });
  const upgraded = await store.load();
  assert.equal(upgraded.profiles[0].loginUrl, ICBC_URL);
  assert.equal(upgraded.profiles[0].password, PASSWORD);
  assert.equal(upgraded.profiles[0].createdAt, old.createdAt);
  assert.equal(upgraded.defaultProfiles[ICBC_ORIGIN], old.id);
  assert.equal(upgraded.enabled, false);
  assert.deepEqual(memory.state.accountVault, structuredClone(upgraded));
  assert.deepEqual(memory.events, ["get", "set"]);
});

test("a failed migration write preserves the only legacy copy and later retries can succeed", async () => {
  const { store, memory } = createStore({ initial: { defaultProfile: legacy } });
  memory.failWrites = 1;
  await assert.rejects(store.load(), /保存失败/);
  assert.deepEqual(memory.state, { defaultProfile: legacy });
  assert.deepEqual(memory.events, ["get", "set"]);
  const retried = await store.load();
  assert.equal(retried.profiles[0].password, PASSWORD);
  assert.equal(Object.hasOwn(memory.state, "defaultProfile"), false);
});

test("explicit clearing reports legacy cleanup failure without rolling back or resurrecting credentials", async () => {
  const { api, store, memory } = createStore({ initial: { defaultProfile: legacy, unrelated: "keep" } });
  memory.failRemovals = 2;
  await store.load();
  assert.ok(memory.state.defaultProfile);
  await assert.rejects(store.clear(), (error) => {
    assert.equal(error.code, "legacy-cleanup-failed");
    assert.equal(error.message, "账号已移除，但旧版信息尚未清除，请重新打开插件重试。");
    assert.deepEqual(structuredClone(error.committedVault), memory.state.accountVault);
    return true;
  });
  const cleared = memory.state.accountVault;
  assert.equal(cleared.profiles.length, 0);
  assert.equal(cleared.enabled, false);
  assert.deepEqual(structuredClone(cleared.defaultProfiles), {});
  assert.ok(memory.state.defaultProfile, "fixture keeps the obsolete key to exercise precedence");
  assert.equal(api.vaultFromStorage(memory.state).profiles.length, 0);
  assert.equal((await store.clear()).profiles.length, 0, "explicit clearing can safely retry the unfinished cleanup");
  assert.equal(memory.state.unrelated, "keep");
  assert.equal(Object.hasOwn(memory.state, "defaultProfile"), false);
});

test("explicit account removal reports leftover legacy data and preserves the committed deletion and other accounts", async () => {
  const old = profile("legacy-default", {
    loginUrl: ICBC_URL, enterpriseId: legacy.enterpriseId, username: legacy.username,
  });
  const remaining = profile("remaining");
  const current = vault([old, remaining], { [ICBC_ORIGIN]: old.id, [SITE_A]: remaining.id });
  const { api, store, memory } = createStore({ initial: { accountVault: current, defaultProfile: legacy } });
  memory.failRemovals = 1;
  await assert.rejects(store.removeProfile(old.id), (error) => {
    assert.equal(error.code, "legacy-cleanup-failed");
    assert.equal(error.message.includes(PASSWORD), false);
    assert.deepEqual(structuredClone(error.committedVault), memory.state.accountVault);
    assert.deepEqual(structuredClone(error.committedVault.profiles), [remaining]);
    return true;
  });
  assert.deepEqual(memory.events, ["get", "set", "remove:defaultProfile"]);
  assert.deepEqual(memory.state.accountVault.profiles, [remaining]);
  assert.equal(memory.state.accountVault.defaultProfiles[ICBC_ORIGIN], "");
  assert.equal(memory.state.accountVault.defaultProfiles[SITE_A], remaining.id);
  assert.equal(memory.state.defaultProfile.password, PASSWORD, "the returned error must acknowledge the remaining old copy");
  assert.equal(api.getProfile(api.vaultFromStorage(memory.state)), null);
  assert.deepEqual(structuredClone((await store.load()).profiles), [remaining]);
  assert.equal(Object.hasOwn(memory.state, "defaultProfile"), false, "reopening retries obsolete-key cleanup");
});

test("destructive operations never remove the only legacy copy before a successful v2 commit", async () => {
  for (const action of [(store) => store.clear(), (store) => store.removeProfile("legacy-default")]) {
    const { store, memory } = createStore({ initial: { defaultProfile: legacy } });
    memory.failWrites = 1;
    await assert.rejects(action(store), /保存失败/);
    assert.deepEqual(memory.state, { defaultProfile: legacy });
    assert.deepEqual(memory.events, ["get", "set"]);
  }
});

test("successful explicit deletion commits v2 before removing the legacy key", async () => {
  for (const action of [(store) => store.clear(), (store) => store.removeProfile("legacy-default")]) {
    const { store, memory } = createStore({ initial: { defaultProfile: legacy, unrelated: "keep" } });
    const result = await action(store);
    assert.equal(result.profiles.length, 0);
    assert.deepEqual(memory.events, ["get", "set", "remove:defaultProfile"]);
    assert.equal(Object.hasOwn(memory.state, "defaultProfile"), false);
    assert.equal(memory.state.unrelated, "keep");
  }
});

test("malformed or unknown current data never falls back to legacy or writes an empty replacement", async () => {
  const invalidValues = [
    null, {}, { ...vault(), version: 99 }, { ...vault(), profiles: {} },
    { ...vault(), defaultProfiles: [] }, { ...vault(), defaultProfiles: new Date(0) },
    { ...vault(), defaultProfiles: { [SITE_A]: 42 } }, { ...vault(), defaultProfileId: 42 },
    vault([profile("a", { loginUrl: "javascript:alert(1)" })]),
    vault([profile("a", { password: 123 })]),
    vault([profile("a"), profile("a", { username: "different" })]),
  ];
  for (const value of invalidValues) {
    const initial = { accountVault: value, defaultProfile: legacy };
    const { store, memory } = createStore({ initial });
    await assert.rejects(store.load(), /数据/);
    await assert.rejects(store.clear(), /数据/);
    assert.deepEqual(memory.state, initial);
    assert.equal(memory.events.includes("set"), false);
    assert.equal(memory.events.some((event) => event.startsWith("remove")), false);
  }
});

test("saving a site's first account honors an explicit or omitted false default preference", async () => {
  const { store, api } = createStore();
  let result = await store.saveProfile({ loginUrl: `${SITE_A}/login`, username: "first", password: PASSWORD }, { makeDefault: false });
  assert.equal(result.defaultProfiles[SITE_A], undefined);
  assert.equal(api.getProfile(result, undefined, `${SITE_A}/login`), null);
  result = await store.saveProfile({ loginUrl: `${SITE_B}/login`, username: "first", password: PASSWORD });
  assert.equal(result.defaultProfiles[SITE_B], undefined);
  const first = result.profiles[0];
  result = await store.saveProfile(first, { makeDefault: true });
  assert.equal(result.defaultProfiles[SITE_A], first.id);
  result = await store.saveProfile({ ...first, name: "renamed" }, { makeDefault: false });
  assert.equal(result.defaultProfiles[SITE_A], first.id, "false alone preserves the existing preference");
  await store.setDefault("", SITE_A);
  result = await store.saveProfile(first, { makeDefault: false });
  assert.equal(result.defaultProfiles[SITE_A], "");
});

test("local read/write errors do not expose internal details or alter existing records", async () => {
  const original = vault([profile()], { [SITE_A]: "alpha" });
  const { store, memory } = createStore({ initial: { accountVault: original } });
  memory.failReads = 1;
  await assert.rejects(store.load(), { message: "无法读取本地账号，请稍后重试。" });
  memory.failWrites = 1;
  await assert.rejects(store.setEnabled(false), { message: "保存失败，请稍后重试。" });
  assert.deepEqual(memory.state.accountVault, original);
});

test("saving and deleting accounts maintain independent defaults for every website", async () => {
  const { store, api } = createStore();
  let result = await store.saveProfile({ loginUrl: `${SITE_A}/login`, username: "same-user", password: PASSWORD }, { makeDefault: true });
  const first = result.profiles[0];
  assert.equal(first.name, "same-user");
  assert.equal(result.defaultProfiles[SITE_A], first.id);
  assert.ok(Number.isSafeInteger(first.createdAt) && first.createdAt > 0);
  result = await store.saveProfile({ loginUrl: `${SITE_B}/login`, username: "same-user", password: PASSWORD }, { makeDefault: true });
  const otherSite = result.profiles.find((entry) => entry.loginUrl.startsWith(SITE_B));
  assert.equal(result.defaultProfiles[SITE_A], first.id);
  assert.equal(result.defaultProfiles[SITE_B], otherSite.id);
  result = await store.saveProfile({ loginUrl: `${SITE_A}/login`, username: "second", password: PASSWORD });
  const second = result.profiles.find((entry) => entry.username === "second");
  assert.equal(result.defaultProfiles[SITE_A], first.id);
  result = await store.setDefault(second.id);
  assert.equal(result.defaultProfiles[SITE_A], second.id);
  result = await store.saveProfile({ ...second, name: "", username: "renamed" });
  assert.equal(result.profiles.find((entry) => entry.id === second.id).name, "renamed");
  assert.equal(result.profiles.find((entry) => entry.id === second.id).createdAt, second.createdAt);
  result = await store.removeProfile(second.id);
  assert.equal(result.defaultProfiles[SITE_A], "");
  assert.equal(result.defaultProfiles[SITE_B], otherSite.id);
  assert.equal(api.getProfile(result, undefined, `${SITE_A}/login`), null);
  result = await store.saveProfile({ loginUrl: `${SITE_A}/login`, username: "third", password: PASSWORD });
  assert.equal(result.defaultProfiles[SITE_A], "", "adding another record must not undo an explicit missing default");
});

test("moving an account between websites clears its old default and requires opting into a new one", async () => {
  const alpha = profile("a");
  const beta = profile("b", { loginUrl: `${SITE_B}/login` });
  const { store } = createStore({ initial: { accountVault: vault([alpha, beta], { [SITE_A]: alpha.id, [SITE_B]: beta.id }) } });
  let result = await store.saveProfile({ ...alpha, loginUrl: `${SITE_C}/login` });
  assert.equal(result.defaultProfiles[SITE_A], "");
  assert.equal(result.defaultProfiles[SITE_B], beta.id);
  assert.equal(result.defaultProfiles[SITE_C], undefined);
  result = await store.setDefault(alpha.id);
  assert.equal(result.defaultProfiles[SITE_C], alpha.id);
  result = await store.saveProfile({ ...alpha, loginUrl: `${SITE_B}/login` }, { makeDefault: true });
  assert.equal(result.defaultProfiles[SITE_C], "");
  assert.equal(result.defaultProfiles[SITE_B], alpha.id);
  result = await store.setDefault("", SITE_B);
  assert.equal(result.defaultProfiles[SITE_B], "");
});

test("wrong IDs, duplicate website identities, and invalid default changes never overwrite saved accounts", async () => {
  const original = vault([profile()], { [SITE_A]: "alpha" });
  const { store, memory } = createStore({ initial: { accountVault: original } });
  const same = { loginUrl: `${SITE_A}/alternate-login`, username: "demo-alpha", password: "different-password" };
  await assert.rejects(store.saveProfile(same), /已存在/);
  await assert.rejects(store.saveProfile({ ...same, id: "missing" }), /不存在/);
  await assert.rejects(store.removeProfile("missing"), /不存在/);
  await assert.rejects(store.setDefault("missing"), /不存在/);
  await assert.rejects(store.setDefault(""), /网站/);
  await assert.rejects(store.setDefault("alpha", SITE_B), /网站/);
  await assert.rejects(store.setEnabled("false"), /开关/);
  assert.deepEqual(memory.state.accountVault, original);
  assert.equal(memory.events.includes("set"), false);
});

test("queued writes read the latest state and recover after a failed operation", async () => {
  const { store } = createStore();
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.saveProfile({
    loginUrl: `${SITE_A}/login`, username: `parallel-${index}`, password: PASSWORD,
  })));
  assert.equal((await store.load()).profiles.length, 12);
  const result = await Promise.allSettled([
    store.removeProfile("missing"),
    store.saveProfile({ loginUrl: `${SITE_B}/login`, username: "after-error", password: PASSWORD }),
  ]);
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "fulfilled");
  assert.equal((await store.load()).profiles.length, 13);
});

test("Web Locks serialize read-modify-write transactions across independent extension contexts", async () => {
  const memory = createMemory();
  const locks = createLocks();
  const left = createStore({ memory, locks }).store;
  const right = createStore({ memory, locks }).store;
  await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? left : right).saveProfile({
    loginUrl: `${SITE_A}/login`, username: `window-${index}`, password: PASSWORD,
  })));
  assert.equal((await left.load()).profiles.length, 10);
  assert.ok(locks.names.length >= 11);
  assert.ok(locks.names.every((name) => name === "icbc-vault-write"));
});

test("encrypted backups round-trip accounts, metadata, Unicode, and per-site defaults with fresh randomness", async () => {
  const original = vault([
    profile("a", {
      username: "backup-only-fictional-account",
      selectors: { enterpriseId: "#company", username: "input[type=email]", password: "#pass" },
    }),
    profile("b", { loginUrl: `${SITE_B}/signin#/login` }),
  ], { [SITE_A]: "a", [SITE_B]: "b" }, false);
  const source = createStore({ initial: { accountVault: original } }).store;
  const first = await source.exportBackup(PASSPHRASE);
  const second = await source.exportBackup(PASSPHRASE);
  const envelope = JSON.parse(first);
  assert.equal(envelope.format, "icbc-autofill-backup");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.iterations, 250000);
  assert.equal(envelope.cipher, "AES-GCM");
  assert.equal(Buffer.from(envelope.salt, "base64").length, 16);
  assert.equal(Buffer.from(envelope.iv, "base64").length, 12);
  assert.notEqual(envelope.salt, JSON.parse(second).salt);
  assert.notEqual(envelope.iv, JSON.parse(second).iv);
  assert.notEqual(envelope.ciphertext, JSON.parse(second).ciphertext);
  assert.equal(first.includes(PASSWORD), false);
  assert.equal(first.includes("backup-only-fictional-account"), false);
  const restored = await createStore().store.importBackup(first, PASSPHRASE);
  assert.equal(restored.imported, 2);
  assert.equal(restored.skipped, 0);
  assert.deepEqual(structuredClone(restored.vault.profiles), original.profiles);
  assert.deepEqual(structuredClone(restored.vault.defaultProfiles), original.defaultProfiles);
  assert.equal(restored.vault.enabled, true, "import keeps the current device's automatic-fill preference");
});

test("backup handling supports large valid ciphertext and enforces the shared 8 MB file limit", async () => {
  const { api, store } = createStore({ initial: { accountVault: vault([
    profile("large", { password: "x".repeat(1024 * 1024) }),
  ], { [SITE_A]: "large" }) } });
  assert.equal(api.MAX_BACKUP_BYTES, 8 * 1024 * 1024);
  assert.equal(store.MAX_BACKUP_BYTES, api.MAX_BACKUP_BYTES);
  const backup = await store.exportBackup(PASSPHRASE);
  assert.ok(Buffer.byteLength(backup, "utf8") < api.MAX_BACKUP_BYTES);
  const restored = await createStore().store.importBackup(backup, PASSPHRASE);
  assert.equal(restored.vault.profiles[0].password, "x".repeat(1024 * 1024));
  const oversized = createStore({ initial: { accountVault: vault([
    profile("large", { password: "x".repeat(api.MAX_BACKUP_BYTES) }),
  ]) } }).store;
  await assert.rejects(oversized.exportBackup(PASSPHRASE), /过大/);
});

test("wrong, trimmed, or short passphrases and authenticated-data tampering never touch local storage", async () => {
  const backup = await createStore({ initial: { accountVault: vault([profile()], { [SITE_A]: "alpha" }) } }).store.exportBackup(PASSPHRASE);
  const { store, memory } = createStore({ initial: { unrelated: "preserved" } });
  await assert.rejects(store.importBackup(backup, "wrong passphrase"), /口令不正确/);
  await assert.rejects(store.importBackup(backup, PASSPHRASE.trim()), /口令不正确/);
  await assert.rejects(store.importBackup(backup, "1234567"), /至少.*8/);
  await assert.rejects(store.exportBackup("1234567"), /至少.*8/);
  for (const key of ["ciphertext", "salt", "iv"]) {
    const envelope = JSON.parse(backup);
    const bytes = Buffer.from(envelope[key], "base64");
    bytes[0] ^= 1;
    envelope[key] = bytes.toString("base64");
    await assert.rejects(store.importBackup(JSON.stringify(envelope), PASSPHRASE), /口令不正确/);
  }
  assert.deepEqual(memory.events, []);
  assert.deepEqual(memory.state, { unrelated: "preserved" });
});

test("backup envelope version, fields, binary lengths, encoding, and total size are checked before reading storage", async () => {
  const baseline = JSON.parse(await externalBackup(vault()));
  const invalid = [
    "null", "not JSON", JSON.stringify({ ...baseline, version: 2 }),
    JSON.stringify({ ...baseline, iterations: 999999999 }), JSON.stringify({ ...baseline, unknown: true }),
    JSON.stringify({ ...baseline, salt: "invalid base64" }), JSON.stringify({ ...baseline, iv: "AAAA" }),
    JSON.stringify({ ...baseline, ciphertext: "AAAA" }), "x".repeat(8 * 1024 * 1024 + 1),
  ];
  const { store, memory } = createStore();
  for (const text of invalid) await assert.rejects(store.importBackup(text, PASSPHRASE), /备份/);
  assert.deepEqual(memory.events, []);
});

test("even correctly encrypted backups require a fully valid payload before changing local state", async () => {
  const payloads = [
    { ...vault(), version: 99 },
    { ...vault(), unknown: "field" },
    vault([profile("a", { loginUrl: "javascript:1" })]),
    vault([profile("a", { password: [] })]),
    vault([profile("a"), profile("a", { username: "different" })]),
    vault([profile("a", { extra: "field" })]),
    vault([profile("a", { selectors: { enterpriseId: "", username: "", password: "x".repeat(257) } })]),
    vault([profile("a", { selectors: { enterpriseId: "", username: "", password: "", extra: "field" } })]),
  ];
  const { store, memory } = createStore({ initial: { accountVault: vault([profile("original")]) } });
  const before = structuredClone(memory.state);
  for (const payload of payloads) {
    const encrypted = await externalBackup(payload);
    await assert.rejects(store.importBackup(encrypted, PASSPHRASE), /备份/);
  }
  assert.deepEqual(memory.events, []);
  assert.deepEqual(memory.state, before);
});

test("backup merging deduplicates within sites, never replaces passwords, and remaps colliding IDs for new-site defaults", async () => {
  const current = vault([
    profile("local-alpha", { username: "alpha", password: "KEEP-CURRENT" }),
    profile("collision", { username: "beta" }),
  ], { [SITE_A]: "collision" }, false);
  const incoming = vault([
    profile("backup-alpha", { username: "alpha", password: "OLD-BACKUP" }),
    profile("new-a", { username: "gamma" }),
    profile("collision", { loginUrl: `${SITE_B}/login`, username: "alpha" }),
    profile("c", { loginUrl: `${SITE_C}/login`, username: "alpha" }),
  ], { [SITE_A]: "new-a", [SITE_B]: "collision", [SITE_C]: "" });
  const backup = await externalBackup(incoming);
  const { store } = createStore({ initial: { accountVault: current } });
  const merged = await store.importBackup(backup, PASSPHRASE);
  assert.equal(merged.imported, 3);
  assert.equal(merged.skipped, 1);
  assert.equal(merged.vault.profiles.length, 5);
  assert.equal(merged.vault.profiles.find((entry) => entry.id === "local-alpha").password, "KEEP-CURRENT");
  assert.equal(merged.vault.defaultProfiles[SITE_A], "collision");
  const newSite = merged.vault.profiles.find((entry) => entry.loginUrl.startsWith(SITE_B));
  assert.notEqual(newSite.id, "collision");
  assert.equal(merged.vault.defaultProfiles[SITE_B], newSite.id);
  assert.equal(merged.vault.defaultProfiles[SITE_C], "");
  assert.equal(merged.vault.enabled, false);
  const again = await store.importBackup(backup, PASSPHRASE);
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 4);
  assert.deepEqual(structuredClone(again.vault), structuredClone(merged.vault));
});

test("an explicitly missing site default survives backup merging into that existing site", async () => {
  const current = vault([profile("a")], { [SITE_A]: "" });
  const backup = await externalBackup(vault([profile("b")], { [SITE_A]: "b" }));
  const { store } = createStore({ initial: { accountVault: current } });
  const result = await store.importBackup(backup, PASSPHRASE);
  assert.equal(result.vault.profiles.length, 2);
  assert.equal(result.vault.defaultProfiles[SITE_A], "");
});

test("a backup import write failure leaves all current accounts untouched", async () => {
  const current = vault([profile("a")], { [SITE_A]: "a" });
  const backup = await externalBackup(vault([profile("b")], { [SITE_A]: "b" }));
  const { store, memory } = createStore({ initial: { accountVault: current } });
  memory.failWrites = 1;
  await assert.rejects(store.importBackup(backup, PASSPHRASE), /保存失败/);
  assert.deepEqual(memory.state.accountVault, current);
});

test("generated passwords honor supported bounds, required character classes, and the symbols option", () => {
  const { store, context } = createStore();
  vm.runInContext("Math.random = () => { throw new Error('Insecure randomness used'); };", context);
  const generated = new Set();
  for (const options of [{}, { length: 16, symbols: false }, { length: 64, symbols: true }, { length: 20, symbols: false }]) {
    const value = store.generatePassword(options);
    assert.equal(value.length, options.length || 20);
    assert.match(value, /[a-z]/);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[0-9]/);
    if (options.symbols === false) assert.match(value, /^[A-Za-z0-9]+$/);
    else assert.match(value, /[^A-Za-z0-9]/);
    generated.add(value);
  }
  assert.equal(generated.size, 4);
  for (const length of [0, 15, 65, 16.5, "20"]) assert.throws(() => store.generatePassword({ length }), /16–64/);
  assert.throws(() => store.generatePassword({ symbols: "yes" }), /选项/);
});

test("password generation rejection-samples random integers before shuffling", () => {
  let calls = 0;
  const crypto = {
    getRandomValues(value) {
      calls += 1;
      value.fill(calls === 1 ? 0xffffffff : 0);
      return value;
    },
  };
  const value = createStore({ crypto }).store.generatePassword({ length: 16, symbols: false });
  assert.equal(value.length, 16);
  assert.match(value, /[A-Z]/);
  assert.match(value, /[a-z]/);
  assert.match(value, /[0-9]/);
  assert.equal(calls, 32, "the out-of-range first sample is discarded before 16 selections and 15 shuffles");
});
