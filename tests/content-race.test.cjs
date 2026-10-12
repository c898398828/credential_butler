"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionDirectory = path.join(__dirname, "..", "extension");
const commonSource = fs.readFileSync(path.join(extensionDirectory, "common.js"), "utf8");
const contentSource = fs.readFileSync(path.join(extensionDirectory, "content.js"), "utf8");
const runtimeId = "test-extension-id";
const loginUrl = "https://toc.icbc.com.cn/login.html#/login";
const profile = Object.freeze({
  enterpriseId: "E1234567", username: "saved-demo-user", password: "fictional-password", enabled: true,
});
const turn = () => new Promise((resolve) => setImmediate(resolve));

function account(id, url, values = {}) {
  return {
    id, name: id, loginUrl: url, enterpriseId: "", username: `${id}-demo-user`,
    password: `fictional-${id}-password`, selectors: {}, createdAt: 0, updatedAt: 0, ...values,
  };
}

function vault(profiles, defaultProfiles = {}, enabled = true) {
  return { version: 2, profiles, defaultProfiles, enabled };
}

function genericInputs(overrides = {}) {
  return [
    { key: "username", id: "username", autocomplete: "username", ...overrides.username },
    { key: "password", id: "password", type: "password", autocomplete: "current-password", ...overrides.password },
  ];
}

// This fixture models only DOM inputs, trusted edit events, and asynchronous
// storage/render boundaries. It implements the small CSS subset used by these tests;
// real browser selectors and the ICBC masking component are verified in Chromium.
function createPage({ url = loginUrl, storedProfile = profile, storedVault, storedData, inputDefinitions, iframe = false } = {}) {
  const listeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  const reads = [];
  const writes = [];
  const events = [];
  let nextTimerId = 0;
  let messageListener;
  let storageChangeListener;
  let mutationListener;
  let fakeDocument;

  const icbcInputs = [
    { key: "enterpriseId", selector: 'input[placeholder="请输入企业编号"]', placeholder: "请输入企业编号" },
    { key: "username", selector: 'input[placeholder="请输入用户名"]', placeholder: "请输入用户名" },
    { key: "password", selector: '.ComPasswordInput input[placeholder="请输入登录密码"]', placeholder: "请输入登录密码" },
  ];
  const definitions = inputDefinitions || icbcInputs;
  const forms = new Map();

  function formFor(name) {
    if (name === null) return null;
    if (!forms.has(name)) forms.set(name, {});
    return forms.get(name);
  }

  function dispatch(type, target, isTrusted) {
    for (const listener of listeners.get(type) || []) listener({ type, target, isTrusted });
  }

  class Input {
    constructor(definition) {
      this.key = definition.key;
      this.selector = definition.selector || `#${definition.id || definition.key}`;
      this.currentValue = definition.value || "";
      this.type = definition.type || "text";
      this.disabled = Boolean(definition.disabled);
      this.readOnly = Boolean(definition.readOnly);
      this.hidden = Boolean(definition.hidden);
      this.id = definition.id || "";
      this.name = definition.name || "";
      this.placeholder = definition.placeholder || "";
      this.autocomplete = definition.autocomplete || "";
      this.ariaLabel = definition.ariaLabel || "";
      this.labels = (definition.labels || []).map((textContent) => ({ textContent }));
      this.form = formFor(definition.form === undefined ? "login" : definition.form);
    }
    get value() { return this.currentValue; }
    set value(value) { this.currentValue = value; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    getAttribute(name) { return name === "aria-label" ? this.ariaLabel : this[name] ?? null; }
    getRootNode() { return fakeDocument; }
    matches(selector) {
      return selector.split(",").some((part) => {
        const selected = part.trim();
        if (selected === "*" || selected === "input" || selected === this.selector) return true;
        if (selected.startsWith("#")) return selected.slice(1) === this.id;
        const attribute = /^input\[([\w-]+)="([^"]*)"\]$/.exec(selected);
        return Boolean(attribute && this.getAttribute(attribute[1]) === attribute[2]);
      });
    }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    dispatchEvent(event) {
      if (event.type === "input") writes.push({ key: this.key, value: this.value });
      events.push({ type: event.type, key: this.key, value: this.value });
      dispatch(event.type, this, event.isTrusted);
      return true;
    }
  }

  const fields = Object.fromEntries(definitions.map((definition) => [definition.key, new Input(definition)]));
  const fakeWindow = {
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
  };
  fakeWindow.top = iframe ? {} : fakeWindow;
  const pageLocation = { href: url };
  fakeDocument = {
    querySelectorAll(selector) {
      if (selector === "input[") throw new SyntaxError("The selector is invalid");
      return Object.values(fields).filter((field) => field.matches(selector));
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
  };
  const context = vm.createContext({
    URL, Event, HTMLInputElement: Input,
    window: fakeWindow,
    location: pageLocation,
    getComputedStyle: () => ({ visibility: "visible" }),
    MutationObserver: class {
      constructor(listener) { mutationListener = listener; }
      observe() {}
    },
    setTimeout(callback, delay = 0) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    document: fakeDocument,
    chrome: {
      runtime: {
        id: runtimeId,
        onMessage: { addListener(listener) { messageListener = listener; } },
      },
      storage: {
        local: {
          get(key) { return new Promise((resolve, reject) => reads.push({ key, resolve, reject })); },
        },
        onChanged: { addListener(listener) { storageChangeListener = listener; } },
      },
    },
  });
  vm.runInContext(commonSource, context, { filename: "common.js" });
  vm.runInContext(contentSource, context, { filename: "content.js" });
  const initialStorage = storedData || (storedVault === undefined
    ? { [context.ICBCAutofill.LEGACY_STORAGE_KEY]: storedProfile }
    : { [context.ICBCAutofill.STORAGE_KEY]: storedVault });

  async function runTimer(predicate) {
    const entry = Array.from(timers.entries()).find(([, timer]) => predicate(timer.delay));
    assert.ok(entry, "the expected browser task must have been scheduled");
    const [id, timer] = entry;
    timers.delete(id);
    timer.callback();
    await turn();
  }

  return {
    fields, reads, writes, events,
    userEdit(key, value) {
      dispatch("beforeinput", fields[key], true);
      fields[key].value = value;
      dispatch("input", fields[key], true);
    },
    manualFill(profileId, senderId = runtimeId) {
      if (!messageListener) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const pending = messageListener(
          { type: context.ICBCAutofill.MESSAGE.FILL_NOW, profileId },
          { id: senderId },
          (response) => resolve(structuredClone(response)),
        );
        if (!pending) resolve(undefined);
      });
    },
    async startAutomatic() {
      if (Array.from(timers.values()).some((timer) => timer.delay > 0)) await runTimer((delay) => delay > 0);
    },
    answerSettings(index = 0, data = initialStorage) {
      assert.ok(reads[index], "wait until the page has requested local settings");
      reads[index].resolve(structuredClone(data));
    },
    rejectSettings(error, index = 0) {
      assert.ok(reads[index], "wait until the page has requested local settings");
      reads[index].reject(error);
    },
    changeSettings(changes, area = "local") {
      storageChangeListener(structuredClone(changes), area);
    },
    navigate(nextUrl, eventType) {
      pageLocation.href = nextUrl;
      for (const listener of windowListeners.get(eventType) || []) listener();
    },
    mutate() { mutationListener([]); },
    replaceField(key, changes = {}) {
      const definition = definitions.find((entry) => entry.key === key);
      assert.ok(definition, "replace an existing fixture field");
      fields[key] = new Input({ ...definition, ...changes });
    },
    async finishRenders() {
      await turn();
      for (let count = 0; Array.from(timers.values()).some((timer) => timer.delay === 0); count += 1) {
        assert.ok(count < 10, "render tasks must settle");
        await runTimer((delay) => delay === 0);
      }
    },
    values: () => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])),
  };
}

test("manual fill can replace edits made before the user requested it", async () => {
  const page = createPage();
  page.userEdit("enterpriseId", "OLD12345");
  page.userEdit("username", "previous-account");
  page.userEdit("password", "previous-password");
  const result = page.manualFill();
  await turn();
  assert.equal(page.reads.length, 1);
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(await result, { ok: true, status: "filled" });
  assert.deepEqual(page.values(), {
    enterpriseId: profile.enterpriseId, username: profile.username, password: profile.password,
  });
});

test("manual fill preserves new trusted edits made while waiting for settings", async () => {
  const page = createPage();
  page.fields.enterpriseId.value = "OLD12345";
  page.fields.password.value = "existing-password";
  const result = page.manualFill();
  await turn();
  assert.equal(page.reads.length, 1);
  page.userEdit("username", "just-typed-by-user");
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(await result, { ok: false, status: "user-edited" });
  assert.deepEqual(page.values(), {
    enterpriseId: "OLD12345", username: "just-typed-by-user", password: "existing-password",
  });
  assert.deepEqual(page.writes, [], "the canceled operation must not write any saved field");
});

test("automatic fill preserves new trusted edits made while waiting for settings", async () => {
  const page = createPage();
  await page.startAutomatic();
  assert.equal(page.reads.length, 1);
  page.userEdit("username", "typed-during-autofill");
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(page.values(), {
    enterpriseId: "", username: "typed-during-autofill", password: "",
  });
  assert.deepEqual(page.writes, [], "a new user edit must cancel the pending automatic write");
});

test("manual fill also preserves a new edit made before its queued work starts", async () => {
  const page = createPage();
  const result = page.manualFill();
  page.userEdit("username", "edited-after-click");
  await page.finishRenders();
  assert.deepEqual(await result, { ok: false, status: "user-edited" });
  assert.equal(page.fields.username.value, "edited-after-click");
  assert.equal(page.fields.password.value, "");
  assert.deepEqual(page.writes, []);
});

test("a trusted edit between account rendering and password filling stops the manual operation", async () => {
  const page = createPage();
  page.fields.password.value = "existing-password";
  const result = page.manualFill();
  await turn();
  page.answerSettings();
  await turn();
  assert.equal(page.fields.username.value, profile.username);
  page.userEdit("username", "newly-selected-account");
  await page.finishRenders();
  assert.deepEqual(await result, { ok: false, status: "user-edited" });
  assert.equal(page.fields.username.value, "newly-selected-account");
  assert.equal(page.fields.password.value, "existing-password");
  assert.equal(page.writes.some((write) => write.key === "password"), false);
});

test("a page-side account change during rendering cannot receive the saved password", async () => {
  const page = createPage();
  page.fields.password.value = "existing-password";
  const result = page.manualFill();
  await turn();
  page.answerSettings();
  await turn();
  assert.equal(page.fields.username.value, profile.username);
  // A programmatic update does not produce a trusted edit event.
  page.fields.username.value = "account-changed-by-page";
  await page.finishRenders();
  assert.deepEqual(await result, { ok: false, status: "conflict" });
  assert.equal(page.fields.username.value, "account-changed-by-page");
  assert.equal(page.fields.password.value, "existing-password");
  assert.equal(page.writes.some((write) => write.key === "password"), false);
});

test("non-target URLs return before reading any extension credentials", async (t) => {
  for (const url of [
    "https://toc.icbc.com.cn/other.html#/login",
    "https://toc.icbc.com.cn/login.html#/account",
    "http://toc.icbc.com.cn/login.html#/login",
    "chrome://settings/",
    "data:text/html,<input>",
  ]) {
    await t.test(url, async () => {
      const page = createPage({ url });
      const result = page.manualFill();
      await page.startAutomatic();
      await page.finishRenders();
      const response = await result;
      assert.ok(response === undefined || (!response.ok && response.status === "wrong-page"));
      assert.equal(page.reads.length, 0);
      assert.deepEqual(page.writes, []);
    });
  }
});

test("a login iframe cannot start reading credentials", async () => {
  const page = createPage({ iframe: true });
  await page.manualFill();
  await page.startAutomatic();
  await page.finishRenders();
  assert.equal(page.reads.length, 0);
  assert.deepEqual(page.writes, []);
});

test("disabled automatic filling leaves fields empty while explicit manual filling remains available", async () => {
  const page = createPage({ storedProfile: { ...profile, enabled: false } });
  await page.startAutomatic();
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(page.values(), { enterpriseId: "", username: "", password: "" });
  assert.deepEqual(page.writes, []);

  const result = page.manualFill();
  await turn();
  page.answerSettings(1);
  await page.finishRenders();
  assert.deepEqual(await result, { ok: true, status: "filled" });
  assert.deepEqual(page.values(), {
    enterpriseId: profile.enterpriseId, username: profile.username, password: profile.password,
  });
});

test("a storage read error returns a generic failure without changing any field", async () => {
  const page = createPage();
  page.fields.password.value = "existing-password";
  const result = page.manualFill();
  await turn();
  page.rejectSettings(new Error(`Internal detail: ${profile.password}`));
  await page.finishRenders();
  assert.deepEqual(await result, { ok: false, status: "storage-error" });
  assert.deepEqual(page.values(), { enterpriseId: "", username: "", password: "existing-password" });
  assert.deepEqual(page.writes, []);
});

test("a local profile change cancels an in-flight fill using the old settings", async () => {
  const page = createPage();
  const result = page.manualFill();
  await turn();
  page.changeSettings({ defaultProfile: { oldValue: profile, newValue: { ...profile, username: "changed-profile" } } });
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(await result, { ok: false, status: "user-edited" });
  assert.deepEqual(page.writes, []);
});

test("unrelated storage changes do not cancel an authorized fill", async () => {
  const page = createPage();
  const result = page.manualFill();
  await turn();
  page.changeSettings({ unrelatedKey: { newValue: "unrelated" } });
  page.changeSettings({ defaultProfile: { newValue: profile } }, "sync");
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(await result, { ok: true, status: "filled" });
  assert.equal(page.fields.password.value, profile.password);
});

async function completeManual(page, profileId, readIndex = 0) {
  const pending = page.manualFill(profileId);
  await turn();
  page.answerSettings(readIndex);
  await page.finishRenders();
  return pending;
}

async function completeAutomatic(page, readIndex = 0) {
  await page.startAutomatic();
  page.answerSettings(readIndex);
  await page.finishRenders();
}

test("v1 stored accounts continue to fill, preserving literal password characters", async () => {
  const legacy = { ...profile, password: "  literal*password*&空格  " };
  const page = createPage({ storedProfile: legacy });
  assert.deepEqual(await completeManual(page), { ok: true, status: "filled" });
  assert.deepEqual(Array.from(page.reads[0].key).sort(), ["accountVault", "defaultProfile"]);
  assert.equal(page.fields.password.value, legacy.password);
  assert.equal(page.fields.password.selectionStart, legacy.password.length);
  assert.deepEqual(page.events.filter((event) => event.key === "password").map((event) => event.type), ["input", "input"]);
});

test("automatic filling chooses the exact origin's default account", async (t) => {
  const alpha = account("alpha", "https://alpha.example/login");
  const beta = account("beta", "https://beta.example/signin");
  const betaDefault = account("beta-default", beta.loginUrl);
  const storedVault = vault([alpha, beta, betaDefault], {
    "https://alpha.example": alpha.id,
    "https://beta.example": betaDefault.id,
  });
  for (const selected of [alpha, betaDefault]) {
    await t.test(selected.id, async () => {
      const page = createPage({ url: selected.loginUrl, storedVault, inputDefinitions: genericInputs() });
      await completeAutomatic(page);
      assert.deepEqual(page.values(), { username: selected.username, password: selected.password });
    });
  }
});

test("a site with accounts but no default stays empty until an explicit account is selected", async () => {
  const first = account("first", "https://portal.example/login");
  const second = account("second", first.loginUrl);
  const page = createPage({ url: first.loginUrl, storedVault: vault([first, second]), inputDefinitions: genericInputs() });
  await completeAutomatic(page);
  assert.deepEqual(page.values(), { username: "", password: "" });
  assert.deepEqual(page.writes, [], "there is no implicit first-account default");
  assert.deepEqual(await completeManual(page, second.id, 1), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { username: second.username, password: second.password });
});

test("explicit selection fills a different account without changing the site's default", async () => {
  const primary = account("primary", "https://portal.example/login");
  const alternate = account("alternate", primary.loginUrl);
  const page = createPage({
    url: primary.loginUrl,
    storedVault: vault([primary, alternate], { "https://portal.example": primary.id }),
    inputDefinitions: genericInputs(),
  });
  assert.deepEqual(await completeManual(page, alternate.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { username: alternate.username, password: alternate.password });
  assert.deepEqual(await completeManual(page, undefined, 1), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { username: primary.username, password: primary.password });
});

test("an unknown or removed explicit account never falls back to the site's default", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl,
    storedVault: vault([selected], { "https://portal.example": selected.id }),
    inputDefinitions: genericInputs(),
  });
  assert.deepEqual(await completeManual(page, "removed-account"), { ok: false, status: "unconfigured" });
  assert.deepEqual(page.writes, []);
});

test("saved accounts cannot fill a different origin, port, login path or hash route", async (t) => {
  const selected = account("primary", "https://portal.example/login#/signin");
  for (const url of [
    "https://portal.example.evil.example/login#/signin",
    "https://other.example/login#/signin",
    "http://portal.example/login#/signin",
    "https://portal.example:8443/login#/signin",
    "https://portal.example/account#/signin",
    "https://portal.example/login#/register",
  ]) {
    await t.test(url, async () => {
      const page = createPage({
        url, storedVault: vault([selected], { "https://portal.example": selected.id }), inputDefinitions: genericInputs(),
      });
      assert.deepEqual(await completeManual(page, selected.id), { ok: false, status: "unconfigured" });
      assert.deepEqual(page.writes, []);
      // The first read identifies known sites. An unrelated page does not keep
      // rereading the saved account data on every subsequent DOM mutation.
      page.mutate();
      await page.startAutomatic();
      await page.finishRenders();
      assert.equal(page.reads.length, 1);
      assert.deepEqual(page.writes, []);
    });
  }
});

test("a legacy ICBC account is never filled into a lookalike hostname", async () => {
  const page = createPage({ url: "https://toc.icbc.com.cn.evil.example/login.html#/login" });
  assert.deepEqual(await completeManual(page), { ok: false, status: "unconfigured" });
  assert.deepEqual(page.writes, []);
});

test("query parameters and trailing slashes do not break an otherwise exact login match", async () => {
  const selected = account("primary", "https://portal.example/login/#/signin?next=old");
  const page = createPage({
    url: "https://portal.example/login?session=different#/signin/?next=new",
    storedVault: vault([selected], { "https://portal.example": selected.id }),
    inputDefinitions: genericInputs(),
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { username: selected.username, password: selected.password });
});

test("a generic email and password form needs no enterprise field", async () => {
  const selected = account("email", "https://mail.example/login", { username: "demo@example.test", password: "  *literal* password  " });
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: genericInputs({ username: { id: "email", type: "email", autocomplete: "" } }),
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { username: selected.username, password: selected.password });
  assert.deepEqual(page.events.filter((event) => event.key === "password").map((event) => event.type), ["input", "change", "input", "change"]);
});

test("a generic enterprise login fills three identity fields and leaves the OTP untouched", async () => {
  const selected = account("company", "https://work.example/login", { enterpriseId: "enterprise-demo-123456789" });
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: [
      { key: "enterpriseId", id: "tenant", labels: ["组织编号"] },
      ...genericInputs(),
      { key: "otp", id: "verificationCode", autocomplete: "one-time-code", value: "user-otp-placeholder" },
    ],
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), {
    enterpriseId: selected.enterpriseId, username: selected.username, password: selected.password, otp: "user-otp-placeholder",
  });
  assert.equal(page.writes.some((write) => write.key === "otp"), false);
});

test("an OTP field preceding the password cannot become the fallback username", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: [
      { key: "username", id: "opaqueUserField" },
      { key: "otp", id: "otp", autocomplete: "one-time-code" },
      { key: "password", type: "password" },
    ],
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { username: selected.username, otp: "", password: selected.password });
});

test("hidden, disabled and read-only password inputs do not displace the visible login fields", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: [
      { key: "hiddenPassword", type: "password", hidden: true },
      { key: "disabledPassword", type: "password", disabled: true },
      { key: "readOnlyPassword", type: "password", readOnly: true },
      ...genericInputs(),
    ],
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.equal(page.fields.password.value, selected.password);
  assert.deepEqual(page.writes.map((write) => write.key), ["username", "password", "password"]);
});

test("registration, change-password and password-style OTP forms are not filled", async (t) => {
  const selected = account("primary", "https://portal.example/login");
  const cases = [
    { name: "new-password autocomplete", inputs: genericInputs({ password: { autocomplete: "new-password" } }) },
    { name: "confirmation password", inputs: [
      ...genericInputs(), { key: "confirmPassword", type: "password", name: "confirm_password" },
    ] },
    { name: "change current password", inputs: [
      ...genericInputs(), { key: "newPassword", type: "password", autocomplete: "new-password" },
    ] },
    { name: "OTP masked as password", inputs: genericInputs({ password: { id: "otp", autocomplete: "one-time-code" } }) },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const page = createPage({ url: selected.loginUrl, storedVault: vault([selected]), inputDefinitions: scenario.inputs });
      assert.deepEqual(await completeManual(page, selected.id), { ok: false, status: "missing-fields" });
      assert.deepEqual(page.writes, []);
    });
  }
});

test("a separate registration form does not stop the current-password login form", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: [
      { key: "registrationUser", autocomplete: "username", form: "register" },
      { key: "registrationPassword", type: "password", autocomplete: "new-password", form: "register" },
      ...genericInputs(),
    ],
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { registrationUser: "", registrationPassword: "", username: selected.username, password: selected.password });
});

test("username and password must belong to the same form", async (t) => {
  for (const custom of [false, true]) {
    await t.test(custom ? "custom selectors" : "automatic field detection", async () => {
      const selected = account("primary", "https://portal.example/login", {
        selectors: custom ? { username: "#username", password: "#password" } : {},
      });
      const page = createPage({
        url: selected.loginUrl, storedVault: vault([selected]),
        inputDefinitions: genericInputs({ username: { form: "different-form" } }),
      });
      assert.deepEqual(await completeManual(page, selected.id), { ok: false, status: "missing-fields" });
      assert.deepEqual(page.writes, []);
    });
  }
});

test("explicit selectors can identify an otherwise opaque three-field login", async () => {
  const selected = account("custom", "https://portal.example/login", {
    enterpriseId: "company-123",
    selectors: { enterpriseId: "#a", username: "#b", password: "#c" },
  });
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: [
      { key: "enterpriseId", id: "a" }, { key: "username", id: "b" }, { key: "password", id: "c", type: "text" },
    ],
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: true, status: "filled" });
  assert.deepEqual(page.values(), { enterpriseId: selected.enterpriseId, username: selected.username, password: selected.password });
});

test("invalid, absent or overlapping custom fields leave all inputs untouched", async (t) => {
  const scenarios = [
    { name: "invalid selector", selectors: { username: "input[" }, status: "invalid-selectors" },
    { name: "missing selector", selectors: { username: "#missing" }, status: "missing-fields" },
    { name: "same input for both fields", selectors: { username: "#password", password: "#password" }, status: "missing-fields" },
    { name: "OTP selected as password", selectors: { password: "#otp" }, status: "missing-fields" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const selected = account("custom", "https://portal.example/login", { selectors: scenario.selectors });
      const page = createPage({
        url: selected.loginUrl, storedVault: vault([selected]),
        inputDefinitions: [...genericInputs(), { key: "otp", id: "otp", autocomplete: "one-time-code" }],
      });
      assert.deepEqual(await completeManual(page, selected.id), { ok: false, status: scenario.status });
      assert.deepEqual(page.writes, []);
    });
  }
});

test("ambiguous password fields prevent automatic guessing", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected]),
    inputDefinitions: [
      ...genericInputs({ password: { autocomplete: "" } }),
      { key: "anotherPassword", type: "password" },
    ],
  });
  assert.deepEqual(await completeManual(page, selected.id), { ok: false, status: "missing-fields" });
  assert.deepEqual(page.writes, []);
});

test("automatic filling does not combine saved credentials with a pre-existing identity or password", async (t) => {
  const selected = account("primary", "https://portal.example/login");
  for (const values of [{ username: "other-user" }, { password: "existing-password" }]) {
    await t.test(Object.keys(values)[0], async () => {
      const inputDefinitions = genericInputs();
      for (const definition of inputDefinitions) definition.value = values[definition.key] || "";
      const page = createPage({
        url: selected.loginUrl, storedVault: vault([selected], { "https://portal.example": selected.id }), inputDefinitions,
      });
      await completeAutomatic(page);
      assert.deepEqual(page.values(), { username: values.username || "", password: values.password || "" });
      assert.deepEqual(page.writes, []);
    });
  }
});

test("a disabled v2 vault blocks automatic filling and still permits explicit selection", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl,
    storedVault: vault([selected], { "https://portal.example": selected.id }, false),
    inputDefinitions: genericInputs(),
  });
  await completeAutomatic(page);
  assert.deepEqual(page.writes, []);
  assert.deepEqual(await completeManual(page, selected.id, 1), { ok: true, status: "filled" });
  assert.equal(page.fields.password.value, selected.password);
});

test("an explicitly empty v2 vault never revives legacy stored credentials", async () => {
  const page = createPage({ storedData: { accountVault: vault([]), defaultProfile: profile } });
  assert.deepEqual(await completeManual(page), { ok: false, status: "unconfigured" });
  assert.deepEqual(page.writes, []);
});

test("a malformed v2 vault reports a generic failure instead of falling back to old credentials", async () => {
  const page = createPage({ storedData: { accountVault: { version: 99 }, defaultProfile: profile } });
  assert.deepEqual(await completeManual(page), { ok: false, status: "storage-error" });
  assert.deepEqual(page.writes, []);
});

test("a v2 vault change cancels an in-flight operation before credentials are written", async () => {
  const selected = account("primary", "https://portal.example/login");
  const storedVault = vault([selected], { "https://portal.example": selected.id });
  const page = createPage({ url: selected.loginUrl, storedVault, inputDefinitions: genericInputs() });
  const pending = page.manualFill(selected.id);
  await turn();
  page.changeSettings({ accountVault: { oldValue: storedVault, newValue: vault([]) } });
  page.answerSettings();
  await page.finishRenders();
  assert.deepEqual(await pending, { ok: false, status: "user-edited" });
  assert.deepEqual(page.writes, []);
});

test("replacing the password node during rendering cancels a pending fill", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({ url: selected.loginUrl, storedVault: vault([selected]), inputDefinitions: genericInputs() });
  const pending = page.manualFill(selected.id);
  await turn();
  page.answerSettings();
  await turn();
  assert.equal(page.fields.username.value, selected.username);
  page.replaceField("password");
  await page.finishRenders();
  assert.deepEqual(await pending, { ok: false, status: "user-edited" });
  assert.equal(page.fields.password.value, "");
  assert.equal(page.writes.some((write) => write.key === "password"), false);
});

test("a route change during rendering cannot receive the saved password", async () => {
  const selected = account("primary", "https://portal.example/login#/signin");
  const page = createPage({ url: selected.loginUrl, storedVault: vault([selected]), inputDefinitions: genericInputs() });
  const pending = page.manualFill(selected.id);
  await turn();
  page.answerSettings();
  await turn();
  assert.equal(page.fields.username.value, selected.username);
  page.navigate("https://portal.example/login#/register", "hashchange");
  await page.finishRenders();
  assert.deepEqual(await pending, { ok: false, status: "user-edited" });
  assert.equal(page.fields.password.value, "");
  assert.equal(page.writes.some((write) => write.key === "password"), false);
});

test("a page-side username change during generic form rendering cannot receive the saved password", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({ url: selected.loginUrl, storedVault: vault([selected]), inputDefinitions: genericInputs() });
  const pending = page.manualFill(selected.id);
  await turn();
  page.answerSettings();
  await turn();
  page.fields.username.value = "different-account-from-page";
  await page.finishRenders();
  assert.deepEqual(await pending, { ok: false, status: "conflict" });
  assert.equal(page.fields.password.value, "");
  assert.equal(page.writes.some((write) => write.key === "password"), false);
});

test("a second DOM observation does not refill inputs already completed automatically", async () => {
  const selected = account("primary", "https://portal.example/login");
  const page = createPage({
    url: selected.loginUrl, storedVault: vault([selected], { "https://portal.example": selected.id }), inputDefinitions: genericInputs(),
  });
  await completeAutomatic(page);
  const firstWrites = structuredClone(page.writes);
  page.mutate();
  await completeAutomatic(page, 1);
  assert.deepEqual(page.writes, firstWrites);
});

test("a message from another extension cannot request a credential read", async () => {
  const page = createPage();
  assert.equal(await page.manualFill(undefined, "another-extension-id"), undefined);
  await page.finishRenders();
  assert.equal(page.reads.length, 0);
  assert.deepEqual(page.writes, []);
});
