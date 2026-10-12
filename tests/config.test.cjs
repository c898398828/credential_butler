"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const commonSource = fs.readFileSync(path.join(__dirname, "..", "extension", "common.js"), "utf8");
const loginUrl = "https://toc.icbc.com.cn/login.html#/login";
// Only fictional credentials belong in tests. Whitespace and asterisks are intentional.
const profile = Object.freeze({
  enterpriseId: "E1234567",
  username: "demo-user",
  password: "  Demo*密码🙂\t ",
  enabled: true,
});

function loadCommon() {
  const context = vm.createContext({ URL });
  vm.runInContext(commonSource, context, { filename: "common.js" });
  return context.ICBCAutofill;
}

test("URL scope permits only the exact HTTPS login document and login route", () => {
  const { isLoginUrl } = loadCommon();
  const allowed = [
    loginUrl,
    "https://toc.icbc.com.cn/login.html",
    "https://toc.icbc.com.cn/login.html?lang=zh#/login/",
    "https://toc.icbc.com.cn:443/login.html#/login?return=home",
  ];
  const denied = [
    "http://toc.icbc.com.cn/login.html#/login",
    "https://toc.icbc.com.cn:444/login.html#/login",
    "https://toc.icbc.com.cn.evil.example/login.html#/login",
    "https://evil-toc.icbc.com.cn/login.html#/login",
    "https://toc.icbc.com.cn@evil.example/login.html#/login",
    "https://user:password@toc.icbc.com.cn/login.html#/login",
    "https://toc.icbc.com.cn/login.html.extra#/login",
    "https://toc.icbc.com.cn/login.html/child#/login",
    "https://toc.icbc.com.cn/other.html#/login",
    "https://toc.icbc.com.cn/login.html#/account",
    "https://toc.icbc.com.cn/login.html#/login/child",
    "https://toc.icbc.com.cn/login.html#/login-extra",
    "https://toc.icbc.com.cn/login.html#login",
    "javascript:alert(1)",
    "/login.html#/login",
    "not a URL",
    null,
    undefined,
  ];
  for (const url of allowed) assert.equal(isLoginUrl(url), true, String(url));
  for (const url of denied) assert.equal(isLoginUrl(url), false, String(url));
});

test("settings normalize account spacing while preserving the exact password", () => {
  const { normalizeSettings } = loadCommon();
  assert.deepEqual(structuredClone(normalizeSettings({
    ...profile,
    enterpriseId: `  ${profile.enterpriseId}  `,
    username: `\t${profile.username}\n`,
    unexpectedField: "not saved",
  })), profile);
  assert.deepEqual(structuredClone(normalizeSettings(null)), {
    enterpriseId: "", username: "", password: "", enabled: true,
  });
  assert.deepEqual(structuredClone(normalizeSettings({
    enterpriseId: 12345678, username: {}, password: 12345, enabled: false,
  })), {
    enterpriseId: "", username: "", password: "", enabled: false,
  });
});

test("validation requires all three string fields and the site's eight-character company limit", () => {
  const { validateSettings } = loadCommon();
  assert.equal(validateSettings(profile), null);
  assert.equal(validateSettings({ ...profile, password: " " }), null);
  assert.equal(validateSettings({ ...profile, enterpriseId: "  A1234567  " }), null);
  const invalid = [
    null,
    {},
    { ...profile, enterpriseId: "   " },
    { ...profile, enterpriseId: "123456789" },
    { ...profile, enterpriseId: 12345678 },
    { ...profile, username: "\t " },
    { ...profile, username: [] },
    { ...profile, password: "" },
    { ...profile, password: 12345678 },
  ];
  for (const value of invalid) {
    assert.equal(typeof validateSettings(value), "string", "invalid settings need a user-facing error");
    assert.ok(validateSettings(value).length > 0);
  }
});
