(() => {
  "use strict";

  const { normalizeSiteUrl, siteOrigin, isProfilePage, validateProfile, MAX_BACKUP_BYTES } = globalThis.ICBCAutofill;
  const store = globalThis.VaultStore;
  const access = globalThis.SiteAccess;
  const $ = (id) => document.getElementById(id);
  const home = $("home-view");
  const editor = $("editor-view");
  const toolsView = $("tools-view");
  const accountList = $("account-list");
  const search = $("account-search");
  const enabled = $("enabled");
  const menu = $("account-menu");
  const dialog = $("confirmation-dialog");
  const status = $("app-status");
  const inputs = {
    name: $("profile-name"),
    loginUrl: $("login-url"),
    enterpriseId: $("enterprise-id"),
    username: $("username"),
    password: $("password"),
  };
  const selectorInputs = {
    enterpriseId: $("selector-enterprise"),
    username: $("selector-username"),
    password: $("selector-password"),
  };
  const cards = new Map();
  let vault = { version: 2, profiles: [], defaultProfiles: {}, defaultProfileId: "", enabled: true };
  let ready = false;
  let busy = false;
  let screen = "home";
  let scope = "all";
  let selectedId = "";
  let editingId = "";
  let editorBaseline = "";
  let currentTab = null;
  let currentPermission = null;
  let tabReadFailed = false;
  let menuProfileId = "";
  let menuTrigger = null;
  let confirmation = null;
  let generatedPassword = "";

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function profileById(id) {
    return vault.profiles.find((profile) => profile.id === id);
  }

  function profileTitle(profile) {
    return profile?.name || profile?.username || "未命名账号";
  }

  function hostname(url) {
    try { return new URL(url).host; }
    catch { return ""; }
  }

  function currentOrigin() {
    return siteOrigin(currentTab?.url);
  }

  function defaultForOrigin(origin) {
    return origin ? profileById(vault.defaultProfiles?.[origin]) : undefined;
  }

  function isDefault(profile) {
    return defaultForOrigin(siteOrigin(profile.loginUrl))?.id === profile.id;
  }

  function selectedMatchesPage() {
    const profile = profileById(selectedId);
    return typeof currentTab?.id === "number" && Boolean(profile && isProfilePage(profile, currentTab.url));
  }

  function showStatus(message, kind = "neutral") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function updateControls() {
    const blocked = !ready || busy;
    document.querySelectorAll("button, input, select").forEach((control) => { control.disabled = blocked; });
    $("editor-fields").disabled = blocked;
    $("fill-button").disabled = blocked || !selectedMatchesPage() || currentPermission !== true;
    $("export-backup").disabled = blocked || vault.profiles.length === 0;
    $("clear-button").disabled = blocked || vault.profiles.length === 0;
    $("confirm-clear").disabled = blocked || vault.profiles.length === 0;
    $("copy-generated").disabled = blocked || !generatedPassword;
    $("filter-current").disabled = blocked || !currentOrigin();
    search.disabled = blocked || vault.profiles.length === 0;
    menu.querySelectorAll("[data-inactive]").forEach((control) => { control.disabled = true; });
    $("app-shell").setAttribute("aria-busy", String(busy));
    $("open-login").setAttribute("aria-disabled", String(busy));
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  function renderHeader() {
    $("view-title").textContent = screen === "home" ? "凭据管家" : screen === "tools" ? "工具" : editingId ? "编辑账号" : "添加账号";
    const subtitle = screen === "tools" ? "生成密码 · 管理本地备份" : screen === "editor" ? "保存后在对应网站使用" : currentOrigin() ? hostname(currentTab.url) : "多站点账号管理";
    $("view-subtitle").textContent = subtitle;
    $("view-subtitle").title = subtitle;
    $("view-subtitle").classList.toggle("domain", screen === "home" && Boolean(currentOrigin()));
  }

  function renderSite() {
    const profile = profileById(selectedId);
    const matches = selectedMatchesPage();
    const open = $("open-login");
    const grant = $("grant-site-button");
    open.hidden = true;
    grant.hidden = true;
    let state = "unmatched";
    let label = tabReadFailed ? "暂无法识别当前页面" : "选择账号并打开对应登录页";
    if (profile && matches) {
      if (currentPermission === true) { state = "ready"; label = "当前页面可填写"; }
      else if (currentPermission === null) { state = "loading"; label = "正在检查网站权限…"; }
      else { state = "permission"; label = "尚未允许此网站自动填写"; grant.hidden = false; }
    } else if (profile) {
      label = "请打开所选账号的登录页";
      open.href = profile.loginUrl;
      open.hidden = false;
    } else if (currentOrigin()) {
      label = "为当前网站选择或添加账号";
    }
    $("site-context").dataset.state = state;
    $("site-label").textContent = label;
    $("site-label").title = label;
    updateControls();
  }

  function renderAutofill() {
    enabled.checked = vault.enabled;
    const origin = currentOrigin() || siteOrigin(profileById(selectedId)?.loginUrl);
    const profile = defaultForOrigin(origin);
    const hint = $("autofill-hint");
    hint.dataset.state = profile ? "configured" : "needs-default";
    hint.textContent = !profile
      ? origin ? "请为此网站选择默认账号以自动填写" : "请选择默认账号以自动填写"
      : vault.enabled ? `此网站默认：${profileTitle(profile)}` : `自动填写已关闭 · 默认：${profileTitle(profile)}`;
    hint.title = hint.textContent;
  }

  function updateSelection() {
    for (const [id, card] of cards) {
      card.root.classList.toggle("is-selected", id === selectedId);
      card.select.setAttribute("aria-pressed", String(id === selectedId));
    }
    const selected = profileById(selectedId);
    $("fill-button").title = selected ? `填写「${profileTitle(selected)}」` : "请先选择账号";
    renderSite();
    renderAutofill();
  }

  function selectProfile(id) {
    if (!ready || busy || !profileById(id)) return;
    selectedId = id;
    updateSelection();
    showStatus(`已选：${profileTitle(profileById(id))}`);
  }

  function createAccountCard(profile) {
    const root = element("article", "account-card");
    root.dataset.profileId = profile.id;
    const select = element("button", "account-select");
    select.type = "button";
    select.setAttribute("aria-label", `选择账号：${profileTitle(profile)}`);
    const heading = element("span", "account-heading");
    const name = element("span", "account-name", profileTitle(profile));
    name.title = profileTitle(profile);
    heading.append(name);
    if (isDefault(profile)) heading.append(element("span", "default-badge", "默认"));
    const domain = element("span", "account-site", hostname(profile.loginUrl));
    domain.title = profile.loginUrl;
    const values = element("span", `account-values${profile.enterpriseId ? " has-corp" : ""}`);
    const fields = profile.enterpriseId ? [["企业编号", profile.enterpriseId], ["账号", profile.username]] : [["账号", profile.username]];
    for (const [label, value] of fields) {
      const field = element("span", "account-field");
      const text = element("span", "account-field-value", value);
      text.title = value;
      field.append(element("span", "account-field-label", label), text);
      values.append(field);
    }
    select.append(heading, domain, values);
    select.addEventListener("click", () => selectProfile(profile.id));
    const more = element("button", "icon-button account-more");
    more.type = "button";
    more.setAttribute("aria-label", `更多操作：${profileTitle(profile)}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", "account-menu");
    more.setAttribute("aria-expanded", "false");
    more.append(icon("more"));
    more.addEventListener("click", () => openMenu(profile.id, more));
    root.append(select, more);
    cards.set(profile.id, { root, select, more });
    return root;
  }

  function renderEmpty(hasQuery) {
    const wrapper = element("div", "empty-state");
    const mark = element("div", "empty-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.append(icon(hasQuery ? "search" : "key"));
    const title = element("p", "empty-title", hasQuery ? "没有找到账号" : vault.profiles.length ? "此网站还没有账号" : "添加第一组账号");
    const description = element("p", "empty-description", hasQuery ? "试试名称、网站、企业编号或账号。" : "保存登录信息，下次打开登录页就能自动填写。");
    const action = element("button", "quiet-button", hasQuery ? "清空搜索" : "添加账号");
    action.type = "button";
    action.addEventListener("click", () => {
      if (busy || !ready) return;
      if (hasQuery) { search.value = ""; renderAccounts(); search.focus(); }
      else openEditor();
    });
    wrapper.append(mark, title, description, action);
    accountList.append(wrapper);
  }

  function renderAccounts({ animate = false } = {}) {
    closeMenu();
    cards.clear();
    accountList.replaceChildren();
    accountList.classList.remove("is-staggered");
    const query = search.value.trim().toLocaleLowerCase();
    const scoped = vault.profiles.filter((profile) => scope === "all" || siteOrigin(profile.loginUrl) === currentOrigin());
    const visible = scoped.filter((profile) => !query || [profile.name, profile.loginUrl, profile.enterpriseId, profile.username]
      .some((value) => (value || "").toLocaleLowerCase().includes(query)));
    $("account-count").textContent = query ? `${visible.length}/${scoped.length}` : String(scoped.length);
    $("filter-current").setAttribute("aria-pressed", String(scope === "current"));
    $("filter-all").setAttribute("aria-pressed", String(scope === "all"));
    if (visible.length) {
      visible.forEach((profile) => accountList.append(createAccountCard(profile)));
      // Entrance animation only when the list itself changed, so typing in search stays flicker-free.
      if (animate) accountList.classList.add("is-staggered");
    } else renderEmpty(Boolean(query));
    if (!visible.some((profile) => profile.id === selectedId)) {
      // A filtered-out account must never remain the hidden target of the fill button.
      const preferred = defaultForOrigin(currentOrigin());
      selectedId = query ? "" : visible.find((profile) => profile.id === preferred?.id)?.id || visible[0]?.id || "";
    }
    updateSelection();
  }

  function applyVault(next, preferredId = selectedId) {
    vault = next;
    selectedId = profileById(preferredId)?.id || defaultForOrigin(currentOrigin())?.id || "";
    renderAccounts({ animate: true });
    updateControls();
  }

  function setScreen(next) {
    closeMenu();
    screen = next;
    home.hidden = next !== "home";
    editor.hidden = next !== "editor";
    toolsView.hidden = next !== "tools";
    $("brand-mark").hidden = next !== "home";
    $("back-button").hidden = next === "home";
    $("tools-button").hidden = next !== "home";
    renderHeader();
    updateControls();
  }

  function readEditor(raw = false) {
    const values = {};
    for (const [key, input] of Object.entries(inputs)) values[key] = raw || key === "password" ? input.value : input.value.trim();
    values.selectors = {};
    for (const [key, input] of Object.entries(selectorInputs)) values.selectors[key] = raw ? input.value : input.value.trim();
    values.makeDefault = $("make-default").checked;
    return values;
  }

  function editorHasChanges() {
    return JSON.stringify(readEditor(true)) !== editorBaseline;
  }

  function resetReveal(input, button, label) {
    input.type = "password";
    button.textContent = "显示";
    button.setAttribute("aria-label", `显示${label}`);
    button.setAttribute("aria-pressed", "false");
  }

  function clearFieldError(input) {
    input.removeAttribute("aria-invalid");
    const error = $(`${input.id}-error`);
    if (error) { error.textContent = ""; error.hidden = true; }
  }

  function updateEnterpriseRequirement() {
    const icbc = siteOrigin(inputs.loginUrl.value) === "https://toc.icbc.com.cn";
    inputs.enterpriseId.required = icbc;
    $("enterprise-optional").hidden = icbc;
    if (icbc) inputs.enterpriseId.maxLength = 8;
    else inputs.enterpriseId.removeAttribute("maxlength");
    inputs.enterpriseId.placeholder = icbc ? "请输入企业编号" : "网站需要时填写";
  }

  function clearEditor() {
    editor.reset();
    editingId = "";
    editorBaseline = "";
    Object.values(inputs).forEach(clearFieldError);
    Object.values(selectorInputs).forEach(clearFieldError);
    $("selector-options").open = false;
    resetReveal(inputs.password, $("toggle-password"), "密码");
  }

  function openEditor(id = "") {
    if (!ready || busy) return;
    const profile = profileById(id);
    if (id && !profile) return;
    clearEditor();
    editingId = id;
    for (const [key, input] of Object.entries(inputs)) input.value = profile?.[key] || "";
    for (const [key, input] of Object.entries(selectorInputs)) input.value = profile?.selectors?.[key] || "";
    if (!profile) inputs.loginUrl.value = normalizeSiteUrl(currentTab?.url) || "";
    $("make-default").checked = profile ? isDefault(profile) : !defaultForOrigin(siteOrigin(inputs.loginUrl.value));
    updateEnterpriseRequirement();
    editorBaseline = JSON.stringify(readEditor(true));
    setScreen("editor");
    showStatus(profile ? "修改后点击保存账号。" : "保存时仅申请此网站的填写权限。");
    inputs.name.focus();
  }

  function askConfirmation({ title, description, action = "确认", danger = true }) {
    if (confirmation) return Promise.resolve(false);
    $("confirmation-title").textContent = title;
    $("confirmation-description").textContent = description;
    $("dialog-confirm").textContent = action;
    $("dialog-confirm").className = `button ${danger ? "button-danger" : "button-primary"}`;
    return new Promise((resolve) => {
      confirmation = resolve;
      dialog.showModal();
      $("dialog-cancel").focus();
    });
  }

  function resolveConfirmation(accepted) {
    if (!confirmation || busy) return;
    const resolve = confirmation;
    confirmation = null;
    dialog.close();
    resolve(accepted);
  }

  async function goBack() {
    if (!ready || busy) return;
    if (screen === "editor" && editorHasChanges()) {
      const leave = await askConfirmation({ title: "放弃未保存的修改？", description: "离开后，本次填写的修改不会保存。", action: "放弃修改" });
      if (!leave) return;
    }
    const from = screen;
    clearEditor();
    $("backup-passphrase").value = "";
    $("backup-passphrase").removeAttribute("aria-invalid");
    resetReveal($("backup-passphrase"), $("toggle-passphrase"), "备份口令");
    hideClearConfirmation();
    setScreen("home");
    showStatus("信息仅保存在当前浏览器。");
    (from === "tools" ? $("tools-button") : $("add-button")).focus();
  }

  function showValidationError(message) {
    Object.values(inputs).forEach(clearFieldError);
    Object.values(selectorInputs).forEach(clearFieldError);
    const selectorError = /选择器|字段匹配/.test(message);
    const field = selectorError ? /企业|组织/.test(message) ? selectorInputs.enterpriseId : message.includes("密码") ? selectorInputs.password : selectorInputs.username : message.includes("名称") ? inputs.name : /地址|网址|URL|网站|登录页/.test(message) ? inputs.loginUrl : /企业|组织/.test(message) ? inputs.enterpriseId : message.includes("账号") ? inputs.username : message.includes("密码") ? inputs.password : null;
    if (selectorError) $("selector-options").open = true;
    if (field) {
      field.setAttribute("aria-invalid", "true");
      const error = $(`${field.id}-error`);
      error.textContent = message;
      error.hidden = false;
      field.focus();
    }
    showStatus(message, "error");
  }

  function closeMenu(restoreFocus = false) {
    const trigger = menuTrigger;
    menu.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    menuTrigger = null;
    menuProfileId = "";
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }

  function addMenuItem(text, symbol, action, options = {}) {
    const item = element("button", `menu-item${options.danger ? " is-danger" : ""}`);
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.append(icon(symbol), element("span", "", text));
    if (options.inactive) { item.dataset.inactive = "true"; item.disabled = true; }
    item.addEventListener("click", action);
    menu.append(item);
  }

  function openMenu(id, trigger) {
    if (!ready || busy) return;
    if (menuProfileId === id && !menu.hidden) { closeMenu(true); return; }
    closeMenu();
    const profile = profileById(id);
    if (!profile) return;
    menuProfileId = id;
    menuTrigger = trigger;
    menu.replaceChildren();
    addMenuItem("打开登录页", "open", () => { closeMenu(); void openLoginPage(profile.loginUrl); });
    addMenuItem("编辑账号", "edit", () => openEditor(id));
    addMenuItem(isDefault(profile) ? "已是网站默认" : "设为网站默认", "star", () => makeDefault(id), { inactive: isDefault(profile) });
    const separator = element("div", "menu-separator");
    separator.setAttribute("role", "separator");
    menu.append(separator);
    const copyFields = profile.enterpriseId ? [["enterpriseId", "企业编号"], ["username", "账号"], ["password", "密码"]] : [["username", "账号"], ["password", "密码"]];
    for (const [field, label] of copyFields) addMenuItem(`复制${label}`, "copy", () => {
      const current = profileById(id);
      if (current) copyText(current[field], label);
      closeMenu(true);
    });
    addMenuItem("删除账号", "trash", () => deleteProfile(id), { danger: true });
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const anchor = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - height - 8))}px`;
    menu.querySelector("button:not(:disabled)")?.focus();
  }

  function copyText(value, label) {
    if (!ready || busy) return;
    // Keep the clipboard request inside the click's user activation, before any await.
    try {
      const pending = navigator.clipboard.writeText(value);
      pending.then(() => showStatus(`已复制${label}。`, "success"), () => showStatus("复制失败，请重试。", "error"));
    } catch { showStatus("复制失败，请重试。", "error"); }
  }

  async function openLoginPage(url) {
    if (busy || !normalizeSiteUrl(url)) return;
    try { await chrome.tabs.create({ url }); }
    catch { showStatus("无法打开登录页，请重试。", "error"); }
  }

  async function makeDefault(id) {
    if (!ready || busy || !profileById(id)) return;
    closeMenu();
    setBusy(true);
    try { applyVault(await store.setDefault(id), id); showStatus("已设为此网站的默认账号。", "success"); }
    catch { showStatus("设置默认账号失败，请重试。", "error"); }
    finally { setBusy(false); }
  }

  async function deleteProfile(id) {
    if (!ready || busy) return;
    const profile = profileById(id);
    if (!profile) return;
    closeMenu();
    const approved = await askConfirmation({ title: `删除「${profileTitle(profile)}」？`, description: isDefault(profile) ? "此网站需重新选择默认账号，其他账号保留。" : "只删除本机保存的这组账号。", action: "删除账号" });
    if (!approved) return;
    setBusy(true);
    try {
      applyVault(await store.removeProfile(id));
      await access.sync().catch(() => {});
      showStatus("账号已删除。", "success");
    } catch (error) {
      if (error?.code === "legacy-cleanup-failed") {
        applyVault(error.committedVault);
        await access.sync().catch(() => {});
        showStatus(error.message, "error");
      } else showStatus("删除失败，请重试。", "error");
    }
    finally { setBusy(false); }
    (cards.get(selectedId)?.select || $("add-button")).focus();
  }

  function toggleReveal(input, button, label) {
    if (!ready || busy) return;
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "隐藏" : "显示";
    button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}${label}`);
    button.setAttribute("aria-pressed", String(visible));
  }

  function showFillResult(result) {
    if (result?.ok && ["filled", "already-filled"].includes(result.status)) {
      showStatus(result.status === "filled" ? "已填写所选账号的登录信息。" : "当前页面已填好所选账号。", "success");
      return;
    }
    const messages = {
      "wrong-page": "请打开此账号保存的登录页后再试。",
      "missing-fields": "未识别到登录表单，可在编辑账号的高级设置中指定字段。",
      unconfigured: "账号信息已变化，请重新打开插件选择账号。",
      "storage-error": "无法读取本地账号，请重试。",
      "user-edited": "页面刚有新的输入，填写已停止。请确认后重试。",
      conflict: "页面内容刚有变化，请确认后再点击填写。",
      "permission-required": "请先允许此网站自动填写。",
      "invalid-selectors": "字段选择器无效，请检查账号的高级设置。",
    };
    showStatus(messages[result?.status] || "暂时无法填写，请刷新登录页后重试。", "error");
  }

  function validPassphrase() {
    const input = $("backup-passphrase");
    if (input.value.length >= 8) { input.removeAttribute("aria-invalid"); return true; }
    input.setAttribute("aria-invalid", "true");
    input.focus();
    showStatus("备份口令至少需要 8 个字符。", "error");
    return false;
  }

  function hideClearConfirmation() {
    $("clear-confirmation").hidden = true;
    $("clear-button").hidden = false;
  }

  $("add-button").addEventListener("click", () => openEditor());
  $("back-button").addEventListener("click", goBack);
  $("tools-button").addEventListener("click", () => {
    if (!ready || busy) return;
    setScreen("tools");
    showStatus("按需生成密码，或管理账号备份。");
    $("generator-section").querySelector("summary").focus();
  });
  for (const mode of ["current", "all"]) $(mode === "current" ? "filter-current" : "filter-all").addEventListener("click", () => {
    if (!ready || busy || (mode === "current" && !currentOrigin())) return;
    scope = mode;
    renderAccounts({ animate: true });
    showStatus(mode === "current" ? "显示当前网站的账号。" : "显示所有已保存的账号。");
  });
  search.addEventListener("input", () => {
    if (!ready || busy) return;
    renderAccounts();
    if (!selectedId && vault.profiles.length) showStatus("请选择搜索结果中的账号。");
  });
  for (const [key, input] of Object.entries(inputs)) input.addEventListener("input", () => {
    clearFieldError(input);
    if (key === "loginUrl") updateEnterpriseRequirement();
    showStatus(editorHasChanges() ? "修改尚未保存。" : "修改后点击保存账号。");
  });
  for (const input of Object.values(selectorInputs)) input.addEventListener("input", () => {
    clearFieldError(input);
    showStatus(editorHasChanges() ? "修改尚未保存。" : "修改后点击保存账号。");
  });
  $("make-default").addEventListener("change", () => showStatus(editorHasChanges() ? "修改尚未保存。" : "修改后点击保存账号。"));
  $("toggle-password").addEventListener("click", () => toggleReveal(inputs.password, $("toggle-password"), "密码"));
  $("toggle-passphrase").addEventListener("click", () => toggleReveal($("backup-passphrase"), $("toggle-passphrase"), "备份口令"));
  $("backup-passphrase").addEventListener("input", () => $("backup-passphrase").removeAttribute("aria-invalid"));

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ready || busy) return;
    const values = readEditor();
    const data = { name: values.name, loginUrl: values.loginUrl, enterpriseId: values.enterpriseId, username: values.username, password: values.password, selectors: values.selectors };
    if (editingId) data.id = editingId;
    const error = data.name.length > 40 ? "名称最多为 40 个字符。" : validateProfile(data);
    if (error) { showValidationError(error); return; }
    // Request this one origin while the save click's user activation is still present.
    const permissionRequest = access.requestForUrl(data.loginUrl);
    const knownIds = new Set(vault.profiles.map((profile) => profile.id));
    Object.values(inputs).forEach(clearFieldError);
    setBusy(true);
    $("save-button").textContent = "正在保存…";
    showStatus("正在保存账号…");
    try {
      if (!await permissionRequest) { showStatus("需要允许此网站后才能自动填写，内容已保留。", "error"); return; }
      let next = await store.saveProfile(data, { makeDefault: values.makeDefault });
      const origin = siteOrigin(data.loginUrl);
      let defaultUpdated = true;
      if (editingId && !values.makeDefault && next.defaultProfiles?.[origin] === editingId) {
        try { next = await store.setDefault("", origin); }
        catch { defaultUpdated = false; }
      }
      const savedId = editingId || next.profiles.find((profile) => !knownIds.has(profile.id))?.id;
      const synced = await access.sync().then(() => true, () => false);
      if (origin === currentOrigin()) currentPermission = true;
      if (scope === "current" && origin !== currentOrigin()) scope = "all";
      search.value = "";
      applyVault(next, savedId);
      clearEditor();
      setScreen("home");
      showStatus(!defaultUpdated ? "账号已保存，取消默认失败，请重新编辑后重试。" : synced ? "账号已保存。" : "账号已保存，自动填写配置请重新打开插件后重试。", defaultUpdated && synced ? "success" : "error");
    } catch (error) {
      const actionable = ["该网站下的账号已存在，请编辑已有账号。", "最多保存 500 个账号。", "账号已不存在，请刷新列表后重试。"];
      showStatus(actionable.includes(error?.message) ? error.message : "保存失败，填写内容已保留，请重试。", "error");
    }
    finally { $("save-button").textContent = "保存账号"; setBusy(false); }
    if (screen === "home") cards.get(selectedId)?.select.focus();
  });

  enabled.addEventListener("change", async () => {
    if (!ready || busy) return;
    const nextEnabled = enabled.checked;
    setBusy(true);
    try { applyVault(await store.setEnabled(nextEnabled)); showStatus(nextEnabled ? "自动填写已开启，请为各网站设置默认账号。" : "自动填写已关闭。", "success"); }
    catch { renderAutofill(); showStatus("修改失败，请重试。", "error"); }
    finally { setBusy(false); }
  });

  $("grant-site-button").addEventListener("click", async () => {
    const profile = profileById(selectedId);
    if (!ready || busy || !profile || !selectedMatchesPage()) return;
    const permissionRequest = access.ensureForUrl(profile.loginUrl);
    setBusy(true);
    try {
      currentPermission = await permissionRequest;
      renderSite();
      showStatus(currentPermission ? "已允许此网站，可以填写当前页面。" : "未授予网站权限，账号信息已保留。", currentPermission ? "success" : "error");
    } catch { currentPermission = false; renderSite(); showStatus("授权失败，请重试。", "error"); }
    finally { setBusy(false); }
  });

  $("fill-button").addEventListener("click", async () => {
    const profile = profileById(selectedId);
    if (!ready || busy || !profile) return;
    const profileId = profile.id;
    closeMenu();
    setBusy(true);
    $("fill-label").textContent = "正在填写…";
    showStatus("正在填写所选账号…");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tab || null;
      tabReadFailed = false;
      renderHeader();
      if (!selectedMatchesPage()) { renderSite(); showStatus("请先打开此账号保存的登录页。", "error"); return; }
      currentPermission = await access.canAccessUrl(tab.url);
      renderSite();
      if (!currentPermission) { showStatus("请先允许此网站自动填写。", "error"); return; }
      showFillResult(await access.fill(tab.id, profileId));
    } catch { showStatus("暂时无法填写，请重新打开插件后重试。", "error"); }
    finally { $("fill-label").textContent = "填写当前页面"; setBusy(false); }
  });
  $("open-login").addEventListener("click", (event) => {
    event.preventDefault();
    const profile = profileById(selectedId);
    if (profile) void openLoginPage(profile.loginUrl);
  });

  $("generate-button").addEventListener("click", () => {
    if (!ready || busy) return;
    try {
      generatedPassword = store.generatePassword({ length: Number($("password-length").value), symbols: $("include-symbols").checked });
      $("generated-password").value = generatedPassword;
      updateControls();
      showStatus("密码已生成，可按需复制。", "success");
    } catch { showStatus("生成失败，请重试。", "error"); }
  });
  $("copy-generated").addEventListener("click", () => { if (generatedPassword) copyText(generatedPassword, "密码"); });

  $("export-backup").addEventListener("click", async () => {
    if (!ready || busy || !vault.profiles.length || !validPassphrase()) return;
    const passphrase = $("backup-passphrase").value;
    setBusy(true);
    showStatus("正在生成加密备份…");
    try {
      const text = await store.exportBackup(passphrase);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const download = document.createElement("a");
      download.href = url;
      download.download = `credential-butler-backup-${date}.json`;
      download.hidden = true;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $("backup-passphrase").value = "";
      resetReveal($("backup-passphrase"), $("toggle-passphrase"), "备份口令");
      showStatus("已开始下载加密备份。", "success");
    } catch { showStatus("导出失败，请重试。", "error"); }
    finally { setBusy(false); }
  });
  $("import-backup").addEventListener("click", () => {
    if (!ready || busy || !validPassphrase()) return;
    $("backup-file").value = "";
    $("backup-file").click();
  });
  $("backup-file").addEventListener("change", async () => {
    const file = $("backup-file").files?.[0];
    if (!file || !ready || busy || !validPassphrase()) return;
    if (file.size > MAX_BACKUP_BYTES) { showStatus(`备份文件不能超过 ${MAX_BACKUP_BYTES / 1024 / 1024} MB。`, "error"); $("backup-file").value = ""; return; }
    const passphrase = $("backup-passphrase").value;
    setBusy(true);
    showStatus("正在解密并合并账号…");
    try {
      const result = await store.importBackup(await file.text(), passphrase);
      const synced = await access.sync().then(() => true, () => false);
      applyVault(result.vault);
      $("backup-passphrase").value = "";
      resetReveal($("backup-passphrase"), $("toggle-passphrase"), "备份口令");
      showStatus(`已导入 ${result.imported} 个账号，跳过 ${result.skipped} 个已有账号。${synced ? "" : "自动填写配置请稍后重试。"}`, synced ? "success" : "error");
    } catch { showStatus("导入失败，请检查备份口令和文件。", "error"); }
    finally { $("backup-file").value = ""; setBusy(false); }
  });

  $("clear-button").addEventListener("click", () => {
    if (!ready || busy || !vault.profiles.length) return;
    $("clear-button").hidden = true;
    $("clear-confirmation").hidden = false;
    $("cancel-clear").focus();
    $("clear-confirmation").scrollIntoView({ block: "nearest" });
  });
  $("cancel-clear").addEventListener("click", () => { hideClearConfirmation(); $("clear-button").focus(); });
  $("confirm-clear").addEventListener("click", async () => {
    if (!ready || busy || !vault.profiles.length) return;
    setBusy(true);
    showStatus("正在清空账号…");
    try {
      search.value = "";
      applyVault(await store.clear());
      await access.sync().catch(() => {});
      hideClearConfirmation();
      $("backup-passphrase").value = "";
      showStatus("账号已清空，自动填写已关闭。", "success");
    } catch (error) {
      if (error?.code === "legacy-cleanup-failed") {
        applyVault(error.committedVault);
        await access.sync().catch(() => {});
        hideClearConfirmation();
        showStatus(error.message, "error");
      } else showStatus("清空失败，请重试。", "error");
    }
    finally { setBusy(false); }
  });

  $("dialog-cancel").addEventListener("click", () => resolveConfirmation(false));
  $("dialog-confirm").addEventListener("click", () => resolveConfirmation(true));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); resolveConfirmation(false); });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !menuTrigger?.contains(event.target)) closeMenu();
  });
  accountList.addEventListener("scroll", () => { if (!menu.hidden) closeMenu(); }, { passive: true });
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    const index = items.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Tab") closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || dialog.open) return;
    if (!menu.hidden) { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (!$("clear-confirmation").hidden && !busy) { event.preventDefault(); event.stopPropagation(); hideClearConfirmation(); $("clear-button").focus(); return; }
    if (screen !== "home" && !busy) { event.preventDefault(); event.stopPropagation(); void goBack(); }
  });

  async function initialize() {
    updateControls();
    const [saved, tab] = await Promise.allSettled([store.load(), chrome.tabs.query({ active: true, currentWindow: true })]);
    currentTab = tab.status === "fulfilled" ? tab.value[0] || null : null;
    tabReadFailed = tab.status === "rejected";
    scope = currentOrigin() ? "current" : "all";
    if (currentOrigin()) {
      try { currentPermission = await access.canAccessUrl(currentTab.url); }
      catch { currentPermission = false; }
    }
    if (saved.status === "fulfilled") {
      ready = true;
      applyVault(saved.value);
      showStatus(vault.profiles.length ? "选择账号即可填写对应登录页。" : "添加账号，开始使用自动填写。");
      // Repair persistent registrations after an extension update or permission change.
      void access.sync().catch(() => {
        if (screen === "home" && !busy) showStatus("自动填写配置未完成，请重新打开插件后重试。", "error");
      });
    } else showStatus("无法读取本地账号，请关闭插件后重试。", "error");
    renderHeader();
    renderSite();
  }

  async function refreshTabContext() {
    if (busy || !ready) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const urlChanged = currentTab?.url !== tab.url;
      const tabIdChanged = currentTab?.id !== tab.id;
      if (!urlChanged && !tabIdChanged && !tabReadFailed) return;

      currentTab = tab;
      tabReadFailed = false;
      if (currentOrigin()) {
        try { currentPermission = await access.canAccessUrl(currentTab.url); }
        catch { currentPermission = false; }
      } else {
        currentPermission = false;
      }

      renderHeader();
      renderSite();
      if (screen === "home") {
        renderAccounts();
      }
    } catch {
      // Tab query failed
    }
  }

  if (typeof chrome !== "undefined" && chrome.tabs) {
    chrome.tabs.onActivated?.addListener(() => {
      void refreshTabContext();
    });
    chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
      if (changeInfo.url || changeInfo.status === "complete") {
        void refreshTabContext();
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName === "local" && changes.accountVault && !busy && ready) {
        void store.load().then((nextVault) => {
          applyVault(nextVault);
          renderSite();
          if (screen === "home") renderAccounts();
        }).catch(() => {});
      }
    });
  }

  void initialize();
})();
