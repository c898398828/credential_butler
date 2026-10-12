(() => {
  "use strict";

  const { siteOrigin, isProfilePage, getProfile, MESSAGE } = ICBCAutofill;
  const PREFIX = "login-assistant-site-";
  const ICBC_ORIGIN = "https://toc.icbc.com.cn";
  let syncQueue = Promise.resolve();

  function patternFor(url) {
    const origin = siteOrigin(url);
    if (!origin) throw new Error("请输入有效的 http 或 https 登录页地址。");
    const site = new URL(origin);
    // Chrome treats an omitted port as a wildcard, including default HTTP(S) ports.
    const port = site.port || (site.protocol === "https:" ? "443" : "80");
    return `${site.protocol}//${site.hostname}:${port}/*`;
  }

  function requestForUrl(url) {
    // Keep the permissions request in the original click's user activation.
    return chrome.permissions.request({ origins: [patternFor(url)] });
  }

  async function canAccessUrl(url) {
    if (!siteOrigin(url)) return false;
    return chrome.permissions.contains({ origins: [patternFor(url)] });
  }

  function scriptId(origin) {
    return PREFIX + btoa(origin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  async function inject(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["common.js", "content.js"],
    });
  }

  async function synchronize() {
    const vault = await VaultStore.load();
    const origins = [...new Set(vault.profiles.map((profile) => siteOrigin(profile.loginUrl)).filter(Boolean))];
    const permitted = [];
    for (const origin of origins) {
      if (await canAccessUrl(origin)) permitted.push(origin);
    }
    const definitions = permitted.filter((origin) => origin !== ICBC_ORIGIN).map((origin) => ({
      id: scriptId(origin),
      matches: [patternFor(origin)],
      js: ["common.js", "content.js"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
      world: "ISOLATED",
    }));
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const desiredIds = new Set(definitions.map((script) => script.id));
    const oldIds = registered.filter((script) => script.id.startsWith(PREFIX) && !desiredIds.has(script.id)).map((script) => script.id);
    if (oldIds.length) await chrome.scripting.unregisterContentScripts({ ids: oldIds });

    const existingIds = new Set(registered.map((script) => script.id));
    const additions = definitions.filter((script) => !existingIds.has(script.id));
    const updates = definitions.filter((script) => existingIds.has(script.id));
    if (additions.length) await chrome.scripting.registerContentScripts(additions);
    if (updates.length) await chrome.scripting.updateContentScripts(updates);

    // A newly granted site may already be open. Activate only its matching current
    // login page; subsequent navigations are covered by persistent registration.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (Number.isInteger(tab?.id) && permitted.includes(siteOrigin(tab.url))
      && vault.profiles.some((profile) => isProfilePage(profile, tab.url))) {
      await inject(tab.id).catch(() => {});
    }
  }

  function sync() {
    const result = syncQueue.then(synchronize);
    syncQueue = result.catch(() => {});
    return result;
  }

  async function ensureForUrl(url) {
    const granted = await requestForUrl(url);
    if (granted) await sync();
    return granted;
  }

  async function fill(tabId, profileId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const vault = await VaultStore.load();
      if (!getProfile(vault, profileId, tab.url)) return { ok: false, status: "wrong-page" };
      if (!await canAccessUrl(tab.url)) return { ok: false, status: "permission-required" };
      const message = { type: MESSAGE.FILL_NOW, profileId };
      try {
        const response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
        return response || { ok: false, status: "storage-error" };
      } catch (error) {
        // An already-open page may predate installation or permission registration.
        if (!/Receiving end does not exist/i.test(error?.message || "")) {
          return { ok: false, status: "storage-error" };
        }
      }
      await inject(tabId);
      return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      return { ok: false, status: "storage-error" };
    }
  }

  globalThis.SiteAccess = Object.freeze({ requestForUrl, canAccessUrl, sync, ensureForUrl, fill });
})();
