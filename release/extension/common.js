(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enterpriseId: "",
    username: "",
    password: "",
    enabled: true,
  });

  const STORAGE_KEY = "accountVault";
  const LEGACY_STORAGE_KEY = "defaultProfile";
  const LOGIN_URL = "https://toc.icbc.com.cn/login.html#/login";
  const ICBC_ORIGIN = "https://toc.icbc.com.cn";
  const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
  const LIMITS = Object.freeze({
    profiles: 500,
    name: 40,
  });
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function isRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  function dataError(message = "本地账号数据不完整或已损坏，未修改已保存的信息。") {
    return new Error(message);
  }

  function timestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : 0;
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enterpriseId: typeof source.enterpriseId === "string" ? source.enterpriseId.trim() : "",
      username: typeof source.username === "string" ? source.username.trim() : "",
      // Passwords are opaque; never trim, log, or interpolate them into markup.
      password: typeof source.password === "string" ? source.password : "",
      enabled: source.enabled !== false,
    };
  }

  function validateSettings(value) {
    const settings = normalizeSettings(value);
    if (!settings.enterpriseId) return "请输入企业编号。";
    if (settings.enterpriseId.length > 8) return "企业编号最多为 8 位。";
    if (!settings.username) return "请输入账号。";
    if (!settings.password) return "请输入密码。";
    return null;
  }

  function normalizeProfile(value) {
    const source = isRecord(value) ? value : {};
    const settings = normalizeSettings(source);
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const createdAt = timestamp(source.createdAt);
    const selectors = isRecord(source.selectors) ? source.selectors : {};
    return {
      id: typeof source.id === "string" ? source.id.trim() : "",
      name: (name || settings.username || "默认账号").slice(0, LIMITS.name),
      loginUrl: normalizeSiteUrl(source.loginUrl),
      enterpriseId: settings.enterpriseId,
      username: settings.username,
      password: settings.password,
      selectors: Object.fromEntries(["enterpriseId", "username", "password"].map((key) => [
        key, typeof selectors[key] === "string" ? selectors[key].trim().slice(0, 256) : "",
      ])),
      createdAt,
      updatedAt: source.updatedAt === undefined ? createdAt : timestamp(source.updatedAt),
    };
  }

  function validateProfile(value) {
    if (value?.selectors !== undefined && (!isRecord(value.selectors)
      || ["enterpriseId", "username", "password"].some((key) => owns(value.selectors, key)
        && typeof value.selectors[key] !== "string"))) return "自定义选择器格式不正确。";
    if (["enterpriseId", "username", "password"].some((key) => typeof value?.selectors?.[key] === "string"
      && value.selectors[key].trim().length > 256)) return "每个自定义选择器最多为 256 个字符。";
    const profile = normalizeProfile(value);
    if (!profile.loginUrl) return "请输入有效的登录网址（http 或 https）。";
    if (siteOrigin(profile.loginUrl) === ICBC_ORIGIN && !isLoginUrl(profile.loginUrl)) {
      return "财资云请使用账号登录页地址。";
    }
    if (isLoginUrl(profile.loginUrl)) {
      const error = validateSettings(profile);
      if (error) return error;
    }
    if (profile.enterpriseId.length > 128) return "企业编号最多为 128 个字符。";
    if (!profile.username) return "请输入账号。";
    if (!profile.password) return "请输入密码。";
    return null;
  }

  function emptyVault(enabled = true) {
    return { version: 2, profiles: [], defaultProfiles: {}, defaultProfileId: "", enabled };
  }

  function normalizeVault(value) {
    if (!isRecord(value)) throw dataError();
    if (value.version !== 2) throw dataError("本地账号数据版本不受支持，请先更新插件。");
    if (!Array.isArray(value.profiles) || value.profiles.length > LIMITS.profiles
      || typeof value.enabled !== "boolean"
      || (owns(value, "defaultProfileId") && typeof value.defaultProfileId !== "string")
      || (owns(value, "defaultProfiles") ? !isRecord(value.defaultProfiles) : typeof value.defaultProfileId !== "string")) {
      throw dataError();
    }

    const ids = new Set();
    const accounts = new Set();
    const profiles = value.profiles.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 128
        || !["enterpriseId", "username", "password"].every((key) => typeof entry[key] === "string")
        || (entry.name !== undefined && typeof entry.name !== "string")
        || (owns(entry, "loginUrl") && (typeof entry.loginUrl !== "string" || !normalizeSiteUrl(entry.loginUrl)))
        || (owns(entry, "selectors") && (!isRecord(entry.selectors)
          || ["enterpriseId", "username", "password"].some((key) => owns(entry.selectors, key)
            && (typeof entry.selectors[key] !== "string" || entry.selectors[key].trim().length > 256))))
        || ["createdAt", "updatedAt"].some((key) => entry[key] !== undefined
          && (!Number.isSafeInteger(entry[key]) || entry[key] < 0 || entry[key] > 8640000000000000))) {
        throw dataError();
      }
      // Incomplete legacy records remain editable; filling separately validates all credentials.
      const profile = normalizeProfile({ ...entry, loginUrl: owns(entry, "loginUrl") ? entry.loginUrl : LOGIN_URL });
      const account = JSON.stringify([siteOrigin(profile.loginUrl), profile.enterpriseId, profile.username]);
      if (ids.has(profile.id) || accounts.has(account)) throw dataError();
      ids.add(profile.id);
      accounts.add(account);
      return profile;
    });
    const defaults = owns(value, "defaultProfiles")
      ? value.defaultProfiles
      : { [ICBC_ORIGIN]: value.defaultProfileId };
    const defaultProfiles = {};
    for (const [origin, id] of Object.entries(defaults)) {
      if (siteOrigin(origin) !== origin || typeof id !== "string") throw dataError();
      const profile = profiles.find((entry) => entry.id === id);
      // A removed or moved account leaves no default; it must never select a different identity.
      defaultProfiles[origin] = profile && siteOrigin(profile.loginUrl) === origin ? profile.id : "";
    }
    return {
      version: 2,
      profiles,
      defaultProfiles,
      defaultProfileId: defaultProfiles[ICBC_ORIGIN] || "",
      enabled: value.enabled,
    };
  }

  function vaultFromStorage(stored) {
    const source = stored === undefined ? {} : stored;
    if (!isRecord(source)) throw dataError();
    // Presence, not truthiness, decides precedence: clearing v2 must never resurrect v1.
    if (owns(source, STORAGE_KEY)) return normalizeVault(source[STORAGE_KEY]);
    if (!owns(source, LEGACY_STORAGE_KEY)) return emptyVault();

    const legacy = source[LEGACY_STORAGE_KEY];
    if (!isRecord(legacy)
      || ["enterpriseId", "username", "password"].some((key) => owns(legacy, key) && typeof legacy[key] !== "string")
      || (owns(legacy, "enabled") && typeof legacy.enabled !== "boolean")) {
      throw dataError();
    }
    const profile = normalizeProfile({ ...legacy, id: "legacy-default", loginUrl: LOGIN_URL, createdAt: 0, updatedAt: 0 });
    return {
      version: 2,
      profiles: [profile],
      defaultProfiles: { [ICBC_ORIGIN]: profile.id },
      defaultProfileId: profile.id,
      enabled: legacy.enabled !== false,
    };
  }

  function getProfile(vault, id, url) {
    const pageUrl = url === undefined ? LOGIN_URL : url;
    const selectedId = id === undefined ? vault?.defaultProfiles?.[siteOrigin(pageUrl)] : id;
    const profile = vault?.profiles?.find((entry) => entry.id === selectedId) || null;
    if (id !== undefined && url === undefined) return profile;
    return profile && isProfilePage(profile, pageUrl) ? profile : null;
  }

  function normalizeSiteUrl(value) {
    if (typeof value !== "string") return "";
    let candidate = value.trim();
    if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)
      || /^(?:javascript|data|file|blob|about|chrome|chrome-extension):/i.test(candidate)) return "";
    if (candidate.startsWith("//")) candidate = `https:${candidate}`;
    else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
      // A hostname with a port (including localhost) is also valid without a scheme.
      if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^[^/?#\s:]+:\d+(?:[/?#]|$)/.test(candidate)) return "";
      candidate = `https://${candidate}`;
    }
    try {
      const url = new URL(candidate);
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password
        || /^https?:\/\/[^/?#]*@/i.test(candidate)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function siteOrigin(value) {
    const normalized = normalizeSiteUrl(value);
    return normalized ? new URL(normalized).origin : null;
  }

  function isProfilePage(profile, value) {
    const savedUrl = normalizeSiteUrl(profile?.loginUrl);
    const pageUrl = normalizeSiteUrl(value);
    if (!savedUrl || !pageUrl) return false;
    const saved = new URL(savedUrl);
    const page = new URL(pageUrl);
    if (saved.origin !== page.origin) return false;
    if (saved.origin === ICBC_ORIGIN) return isLoginUrl(savedUrl) && isLoginUrl(pageUrl);
    const path = (value) => value.replace(/\/+$/, "") || "/";
    if (path(saved.pathname) !== path(page.pathname)) return false;
    const hashPath = (value) => path(value.replace(/^#/, "").split("?")[0]);
    return !saved.hash || hashPath(saved.hash) === hashPath(page.hash);
  }

  function isLoginUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://toc.icbc.com.cn"
        && url.pathname === "/login.html"
        && !url.username && !url.password
        && (url.hash === "" || /^#\/login\/?(?:\?.*)?$/.test(url.hash));
    } catch {
      return false;
    }
  }

  globalThis.ICBCAutofill = Object.freeze({
    LOGIN_URL,
    LOGIN_MATCH: "https://toc.icbc.com.cn/login.html*",
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    ICBC_ORIGIN,
    MAX_BACKUP_BYTES,
    LIMITS,
    DEFAULT_SETTINGS,
    MESSAGE: Object.freeze({
      FILL_NOW: "icbc:fill-now",
    }),
    normalizeSettings,
    validateSettings,
    normalizeProfile,
    validateProfile,
    normalizeVault,
    vaultFromStorage,
    getProfile,
    normalizeSiteUrl,
    siteOrigin,
    isProfilePage,
    isLoginUrl,
  });
})();
