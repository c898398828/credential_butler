(() => {
  "use strict";

  if (window.top !== window || globalThis.__loginAssistantInitialized) return;
  globalThis.__loginAssistantInitialized = true;
  const {
    STORAGE_KEY, LEGACY_STORAGE_KEY, MESSAGE, isLoginUrl,
    vaultFromStorage, getProfile, validateProfile, isProfilePage, siteOrigin,
  } = ICBCAutofill;
  const ICBC_SELECTORS = {
    enterpriseId: 'input[placeholder="请输入企业编号"]',
    username: 'input[placeholder="请输入用户名"]',
    password: '.ComPasswordInput input[placeholder="请输入登录密码"]',
  };
  const FIELD_KEYS = Object.keys(ICBC_SELECTORS);
  const OTP = /one[-_ ]?time|\botp\b|\btotp\b|captcha|verification|verify.?code|sms.?code|验证码|动态码|短信码/i;
  const NEW_PASSWORD = /new.?pass|confirm|repeat.?pass|retype|reenter|再次|确认|新密码/i;
  const COMPANY = /tenant|enterprise|company|corp|organi[sz]ation|account[_-]?id|租户|企业|公司|组织|机构/i;
  const USERNAME = /username|user[_-]?name|user[_-]?id|login|account|email|e-mail|手机号|手机号码|邮箱|用户名|账号|账户/i;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  let edited = new WeakSet();
  let filled = new WeakSet();
  let revision = 0;
  let editRevision = 0;
  let timer;
  let queue = Promise.resolve();
  let knownRoutes = null;

  function eligiblePage() {
    try {
      const url = new URL(location.href);
      return Boolean(siteOrigin(url.href))
        && (url.hostname !== "toc.icbc.com.cn" || isLoginUrl(url.href));
    } catch {
      return false;
    }
  }

  function queryAll(selector) {
    const scopes = [document];
    const result = [];
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index];
      result.push(...scope.querySelectorAll(selector));
      for (const element of scope.querySelectorAll("*")) {
        if (element.shadowRoot) scopes.push(element.shadowRoot);
      }
    }
    return result;
  }

  function visible(input) {
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly) return false;
    if (!["text", "password", "email", "tel", "number", "url", "search"].includes(input.type)) return false;
    const style = getComputedStyle(input);
    return input.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  function visibleInput(selector) {
    return queryAll(selector).find(visible) || null;
  }

  function semantics(input) {
    return [input.id, input.name, input.placeholder, input.autocomplete,
      input.getAttribute("aria-label"), ...Array.from(input.labels || [], (label) => label.textContent)]
      .filter(Boolean).join(" ").slice(0, 1000);
  }

  function findFields(profile) {
    const custom = profile.selectors || {};
    const fields = Object.fromEntries(FIELD_KEYS.map((key) => [key, custom[key] ? visibleInput(custom[key]) : null]));
    if (FIELD_KEYS.some((key) => custom[key] && !fields[key])) return null;
    if (isLoginUrl(location.href)) {
      for (const key of FIELD_KEYS) fields[key] ||= visibleInput(ICBC_SELECTORS[key]);
      return FIELD_KEYS.every((key) => fields[key]) ? fields : null;
    }

    const inputs = queryAll("input").filter(visible);
    if (!fields.password) {
      const passwords = inputs.filter((input) => !OTP.test(semantics(input)) && !NEW_PASSWORD.test(semantics(input))
        && (input.type === "password" || /current-password|password|passwd|\bpwd\b|密码/i.test(semantics(input))));
      const current = passwords.filter((input) => input.autocomplete?.split(/\s+/).includes("current-password"));
      fields.password = current.length === 1 ? current[0] : passwords.length === 1 ? passwords[0] : null;
    }
    if (!fields.password || OTP.test(semantics(fields.password)) || NEW_PASSWORD.test(semantics(fields.password))) return null;
    const password = fields.password;
    const sameForm = (input) => password.form ? input.form === password.form : input.getRootNode() === password.getRootNode();
    const scope = inputs.filter(sameForm);
    // Do not treat a registration/change-password form as a login form.
    if (scope.some((input) => input !== password && input.type === "password" && NEW_PASSWORD.test(semantics(input)))) return null;
    const texts = scope.filter((input) => input !== password && input.type !== "password" && input.type !== "search"
      && !OTP.test(semantics(input)) && !/\bsearch\b|搜索/i.test(semantics(input)));
    const beforePassword = texts.filter((input) => inputs.indexOf(input) < inputs.indexOf(password));
    if (!fields.enterpriseId && profile.enterpriseId) {
      const companies = texts.filter((input) => COMPANY.test(semantics(input)) && input.autocomplete !== "username");
      fields.enterpriseId = companies.length === 1 ? companies[0] : beforePassword.length === 2 ? beforePassword[0] : null;
    }
    if (!fields.username) {
      const candidates = texts.filter((input) => input !== fields.enterpriseId);
      const scored = candidates.map((input) => ({ input, score:
        (input.autocomplete?.split(/\s+/).includes("username") ? 200 : 0)
        + (input.type === "email" ? 80 : 0) + (USERNAME.test(semantics(input)) ? 70 : 0)
        + (inputs.indexOf(input) < inputs.indexOf(password) ? 20 : 0),
      })).sort((a, b) => b.score - a.score || inputs.indexOf(b.input) - inputs.indexOf(a.input));
      fields.username = scored[0]?.input || null;
    }
    if (!fields.username || (profile.enterpriseId && !fields.enterpriseId)) return null;
    if (!sameForm(fields.username) || (fields.enterpriseId && !sameForm(fields.enterpriseId))) return null;
    const present = Object.values(fields).filter(Boolean);
    return new Set(present).size === present.length ? fields : null;
  }

  function sameFields(fields, profile) {
    const current = findFields(profile);
    return current && FIELD_KEYS.every((key) => current[key] === fields[key]);
  }

  function wasEdited(fields) {
    return Object.values(fields).some((input) => edited.has(input));
  }

  function writeInput(input, value, dispatchChange = true) {
    valueSetter.call(input, value);
    // The site's password component uses selectionStart to reconstruct its real value.
    if (input.type === "text" || input.type === "password") {
      input.setSelectionRange(value.length, value.length);
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (dispatchChange) input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const nextRender = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function fill(manual, requestedEditRevision, profileId) {
    if (!eligiblePage()) return { ok: false, status: "wrong-page" };
    if (knownRoutes && !knownRoutes.some((profile) => isProfilePage(profile, location.href))) return { ok: false, status: "wrong-page" };
    if (editRevision !== requestedEditRevision) return { ok: false, status: "user-edited" };

    const startRevision = revision;
    let settings;
    let vault;
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
      vault = vaultFromStorage(stored);
      knownRoutes = vault.profiles.map((profile) => ({ loginUrl: profile.loginUrl }));
      settings = getProfile(vault, manual ? profileId : undefined, location.href);
    } catch {
      return { ok: false, status: "storage-error" };
    }
    if (!settings || validateProfile(settings)) return { ok: false, status: "unconfigured" };
    if (!vault.enabled && !manual) return { ok: false, status: "disabled" };
    let fields;
    try {
      fields = findFields(settings);
    } catch {
      return { ok: false, status: "invalid-selectors" };
    }
    if (!fields) return { ok: false, status: "missing-fields" };
    if (!manual && filled.has(fields.password)) return { ok: true, status: "already-filled" };
    if (!manual && wasEdited(fields)) return { ok: false, status: "user-edited" };

    function stillCurrent() {
      return revision === startRevision && isProfilePage(settings, location.href) && sameFields(fields, settings)
        && editRevision === requestedEditRevision && (manual || !wasEdited(fields));
    }

    function identityMatches() {
      return (!fields.enterpriseId || fields.enterpriseId.value === settings.enterpriseId) && fields.username.value === settings.username;
    }

    if (!stillCurrent()) return { ok: false, status: "user-edited" };
    if (!manual) {
      // A remembered company alone can be replaced by the chosen default. Never mix
      // a saved password into a different account or overwrite an existing password.
      const username = fields.username.value;
      const company = fields.enterpriseId?.value;
      if (fields.password.value || (username && username !== settings.username)
        || (username && company && company !== settings.enterpriseId)) {
        return { ok: false, status: "conflict" };
      }
    }

    try {
      if (fields.enterpriseId) writeInput(fields.enterpriseId, settings.enterpriseId);
      writeInput(fields.username, settings.username);
      await nextRender();
      if (!stillCurrent()) return { ok: false, status: "user-edited" };
      if (!identityMatches()) return { ok: false, status: "conflict" };

      // Reset the old real value as well as the displayed asterisks before replacing
      // a masked password. Do not send a synchronous change event for this component.
      const dispatchPasswordChange = !isLoginUrl(location.href);
      writeInput(fields.password, "", dispatchPasswordChange);
      await nextRender();
      if (!stillCurrent()) return { ok: false, status: "user-edited" };
      if (!identityMatches()) return { ok: false, status: "conflict" };
      writeInput(fields.password, settings.password, dispatchPasswordChange);
      filled.add(fields.password);
      await nextRender();
      if (!stillCurrent()) return { ok: false, status: "user-edited" };
      return { ok: true, status: "filled" };
    } catch {
      return { ok: false, status: "missing-fields" };
    }
  }

  function enqueue(manual, profileId) {
    const requestedEditRevision = editRevision;
    const result = queue.then(() => fill(manual, requestedEditRevision, profileId));
    queue = result.catch(() => {});
    return result;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { enqueue(false).catch(() => {}); }, 100);
  }

  // Only real user/browser input counts as an edit; our synthetic input must still
  // reach Vue while leaving the automatic-fill guard intact.
  function trackEdit(event) {
    const input = event.composedPath?.().find((node) => node instanceof HTMLInputElement) || event.target;
    if (event.isTrusted && input instanceof HTMLInputElement) {
      edited.add(input);
      editRevision += 1;
    }
  }
  document.addEventListener("beforeinput", trackEdit, true);
  document.addEventListener("input", trackEdit, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === MESSAGE.FILL_NOW) {
      enqueue(true, message.profileId).then(sendResponse, () => sendResponse({ ok: false, status: "storage-error" }));
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (Object.hasOwn(changes, STORAGE_KEY) || Object.hasOwn(changes, LEGACY_STORAGE_KEY))) {
      revision += 1;
      knownRoutes = null;
      filled = new WeakSet();
      schedule();
    }
  });

  const observer = new MutationObserver(schedule);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "disabled", "readonly"],
  });
  window.addEventListener("hashchange", () => {
    revision += 1;
    edited = new WeakSet();
    filled = new WeakSet();
    schedule();
  });
  window.addEventListener("pageshow", schedule);
  schedule();
})();
