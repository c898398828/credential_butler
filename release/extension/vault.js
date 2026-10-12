(() => {
  "use strict";

  const {
    STORAGE_KEY, LEGACY_STORAGE_KEY, LIMITS, MAX_BACKUP_BYTES,
    normalizeProfile, validateProfile, normalizeVault, vaultFromStorage, siteOrigin,
  } = globalThis.ICBCAutofill;
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const BACKUP_FORMAT = "icbc-autofill-backup";
  const BACKUP_ITERATIONS = 250000;
  // Reserve space for the JSON header and base64 expansion within the 8 MiB file limit.
  const MAX_PLAINTEXT_BYTES = Math.floor((MAX_BACKUP_BYTES - 1024) * 3 / 4) - 16;
  const BACKUP_ERROR = "备份格式不正确或文件已损坏。";
  const DECRYPT_ERROR = "口令不正确，或备份文件已损坏。";
  let pendingWrite = Promise.resolve();

  function withWriteLock(operation) {
    if (globalThis.navigator?.locks?.request) {
      return globalThis.navigator.locks.request("icbc-vault-write", operation);
    }
    // Chrome uses an origin-wide Web Lock. This fallback also serializes test/older runtimes.
    const result = pendingWrite.then(operation);
    pendingWrite = result.catch(() => {});
    return result;
  }

  async function readStored() {
    let stored;
    try {
      stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    } catch {
      throw new Error("无法读取本地账号，请稍后重试。");
    }
    const vault = vaultFromStorage(stored);
    const hasVault = owns(stored, STORAGE_KEY);
    const raw = stored[STORAGE_KEY];
    return {
      vault,
      hasVault,
      needsUpgrade: hasVault && (!owns(raw, "defaultProfiles") || !owns(raw, "defaultProfileId")
        || raw.profiles.some((profile) => !owns(profile, "loginUrl") || !owns(profile, "selectors"))),
      hasLegacy: owns(stored, LEGACY_STORAGE_KEY),
    };
  }

  async function removeLegacy() {
    try {
      await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
      return true;
    } catch {
      // A committed v2 value is authoritative, even if obsolete-key cleanup must wait.
      return false;
    }
  }

  async function persist(vault, hasLegacy, { requireLegacyRemoval = false } = {}) {
    const normalized = normalizeVault(vault);
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    } catch {
      throw new Error("保存失败，请稍后重试。");
    }
    // Never delete the only credential copy before the new one has been committed.
    if (hasLegacy) {
      const removed = await removeLegacy();
      if (!removed && requireLegacyRemoval) {
        const error = new Error("账号已移除，但旧版信息尚未清除，请重新打开插件重试。");
        error.code = "legacy-cleanup-failed";
        // The deletion is already committed. Let the UI show that state without implying full cleanup.
        error.committedVault = normalized;
        throw error;
      }
    }
    return normalized;
  }

  function load() {
    return withWriteLock(async () => {
      const { vault, hasVault, hasLegacy, needsUpgrade } = await readStored();
      if ((!hasVault && hasLegacy) || needsUpgrade) return persist(vault, hasLegacy);
      if (hasVault && hasLegacy) await removeLegacy();
      return vault;
    });
  }

  function update(mutator, options) {
    return withWriteLock(async () => {
      const { vault, hasLegacy } = await readStored();
      mutator(vault);
      return persist(vault, hasLegacy, options);
    });
  }

  function secureCrypto() {
    if (!globalThis.crypto?.getRandomValues) {
      throw new Error("当前浏览器不支持安全随机数，请更新 Chrome。");
    }
    return globalThis.crypto;
  }

  function newId(existingIds) {
    const crypto = secureCrypto();
    if (typeof crypto.randomUUID !== "function") {
      throw new Error("当前浏览器不支持安全随机数，请更新 Chrome。");
    }
    let id;
    do { id = crypto.randomUUID(); } while (existingIds.has(id));
    return id;
  }

  function requireProfile(vault, id) {
    const profile = vault.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error("账号已不存在，请刷新列表后重试。");
    return profile;
  }

  async function saveProfile(data, { makeDefault = false } = {}) {
    const validation = validateProfile(data);
    if (validation) throw new Error(validation);
    const profile = normalizeProfile(data);
    if (data?.id !== undefined && typeof data.id !== "string") throw new Error("账号编号无效。");
    const isNew = !profile.id;
    return update((vault) => {
      const existing = isNew ? null : requireProfile(vault, profile.id);
      const origin = siteOrigin(profile.loginUrl);
      const previousOrigin = existing ? siteOrigin(existing.loginUrl) : null;
      if (vault.profiles.some((entry) => entry.id !== existing?.id
        && siteOrigin(entry.loginUrl) === origin
        && entry.enterpriseId === profile.enterpriseId && entry.username === profile.username)) {
        throw new Error("该网站下的账号已存在，请编辑已有账号。");
      }
      if (isNew && vault.profiles.length >= LIMITS.profiles) {
        throw new Error(`最多保存 ${LIMITS.profiles} 个账号。`);
      }
      const now = Date.now();
      const saved = {
        ...profile,
        id: existing?.id || newId(new Set(vault.profiles.map((entry) => entry.id))),
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      };
      if (existing) vault.profiles[vault.profiles.indexOf(existing)] = saved;
      else vault.profiles.push(saved);
      if (existing && previousOrigin !== origin && vault.defaultProfiles[previousOrigin] === saved.id) {
        vault.defaultProfiles[previousOrigin] = "";
      }
      if (makeDefault === true) vault.defaultProfiles[origin] = saved.id;
    });
  }

  function removeProfile(id) {
    return update((vault) => {
      const profile = requireProfile(vault, id);
      vault.profiles.splice(vault.profiles.indexOf(profile), 1);
      for (const origin of Object.keys(vault.defaultProfiles)) {
        if (vault.defaultProfiles[origin] === id) vault.defaultProfiles[origin] = "";
      }
    }, { requireLegacyRemoval: true });
  }

  function setDefault(id, origin) {
    return update((vault) => {
      if (id === "") {
        if (!origin || siteOrigin(origin) !== origin) throw new Error("请选择需要清除默认账号的网站。");
        vault.defaultProfiles[origin] = "";
        return;
      }
      const profile = requireProfile(vault, id);
      const profileOrigin = siteOrigin(profile.loginUrl);
      if (origin !== undefined && siteOrigin(origin) !== profileOrigin) throw new Error("该账号不属于所选网站。");
      vault.defaultProfiles[profileOrigin] = id;
    });
  }

  async function setEnabled(value) {
    if (typeof value !== "boolean") throw new Error("自动填写开关无效。");
    return update((vault) => { vault.enabled = value; });
  }

  function clear() {
    return update((vault) => {
      vault.profiles = [];
      vault.defaultProfiles = {};
      vault.defaultProfileId = "";
      vault.enabled = false;
    }, { requireLegacyRemoval: true });
  }

  function checkPassphrase(passphrase) {
    if (typeof passphrase !== "string" || passphrase.length < 8) {
      throw new Error("备份口令至少需要 8 个字符。");
    }
    if (passphrase.length > 4096) throw new Error("备份口令过长。");
  }

  function toBase64(bytes) {
    // Avoid passing megabytes through a function's argument stack.
    const chunks = [];
    for (let index = 0; index < bytes.length; index += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
    }
    return btoa(chunks.join(""));
  }

  function fromBase64(value, maxBytes) {
    if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error(BACKUP_ERROR);
    }
    let binary;
    try { binary = atob(value); } catch { throw new Error(BACKUP_ERROR); }
    if (binary.length > maxBytes || btoa(binary) !== value) throw new Error(BACKUP_ERROR);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function header(salt, iv) {
    return {
      format: BACKUP_FORMAT,
      version: 1,
      kdf: "PBKDF2",
      hash: "SHA-256",
      iterations: BACKUP_ITERATIONS,
      cipher: "AES-GCM",
      salt,
      iv,
    };
  }

  async function deriveKey(passphrase, salt) {
    const crypto = secureCrypto();
    if (!crypto.subtle) throw new Error("当前浏览器不支持加密备份，请更新 Chrome。");
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: BACKUP_ITERATIONS, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
  }

  function exactFields(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every((key) => owns(value, key));
  }

  function validateBackupVault(value) {
    const hasCurrentFields = exactFields(value, ["version", "profiles", "defaultProfiles", "defaultProfileId", "enabled"]);
    const hasLegacyFields = exactFields(value, ["version", "profiles", "defaultProfileId", "enabled"]);
    if ((!hasCurrentFields && !hasLegacyFields)
      || !Array.isArray(value.profiles) || value.profiles.length > LIMITS.profiles) {
      throw new Error(BACKUP_ERROR);
    }
    for (const profile of value.profiles) {
      if (profile === null || typeof profile !== "object" || Array.isArray(profile)) throw new Error(BACKUP_ERROR);
      const fields = ["id", "name", "enterpriseId", "username", "password", "createdAt", "updatedAt"];
      if (owns(profile, "loginUrl")) fields.push("loginUrl");
      if (owns(profile, "selectors")) fields.push("selectors");
      if (!exactFields(profile, fields)
        || typeof profile.name !== "string" || profile.name.length > LIMITS.name
        || typeof profile.enterpriseId !== "string"
        || typeof profile.username !== "string"
        || typeof profile.password !== "string"
        || (owns(profile, "selectors") && !exactFields(profile.selectors, ["enterpriseId", "username", "password"]))
        || !["createdAt", "updatedAt"].every((key) => Number.isSafeInteger(profile[key])
          && profile[key] >= 0 && profile[key] <= 8640000000000000)) {
        throw new Error(BACKUP_ERROR);
      }
    }
    try { return normalizeVault(value); } catch { throw new Error(BACKUP_ERROR); }
  }

  async function exportBackup(passphrase) {
    checkPassphrase(passphrase);
    const vault = validateBackupVault(await load());
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(vault));
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("账号数据过大，无法导出备份。");
    const crypto = secureCrypto();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const metadata = header(toBase64(salt), toBase64(iv));
    const key = await deriveKey(passphrase, salt);
    const encrypted = await crypto.subtle.encrypt({
      name: "AES-GCM", iv, tagLength: 128,
      additionalData: encoder.encode(JSON.stringify(metadata)),
    }, key, plaintext);
    const result = JSON.stringify({ ...metadata, ciphertext: toBase64(new Uint8Array(encrypted)) }, null, 2);
    if (encoder.encode(result).byteLength > MAX_BACKUP_BYTES) throw new Error("备份文件不能超过 8 MB。");
    return result;
  }

  async function decodeBackup(text, passphrase) {
    checkPassphrase(passphrase);
    if (typeof text !== "string" || !text.length || text.length > MAX_BACKUP_BYTES
      || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
      throw new Error(BACKUP_ERROR);
    }
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error(BACKUP_ERROR); }
    if (!exactFields(envelope, ["format", "version", "kdf", "hash", "iterations", "cipher", "salt", "iv", "ciphertext"])
      || envelope.format !== BACKUP_FORMAT || envelope.kdf !== "PBKDF2" || envelope.hash !== "SHA-256"
      || envelope.cipher !== "AES-GCM" || envelope.iterations !== BACKUP_ITERATIONS) {
      throw new Error(BACKUP_ERROR);
    }
    if (envelope.version !== 1) throw new Error("暂不支持这个备份版本。");
    const salt = fromBase64(envelope.salt, 16);
    const iv = fromBase64(envelope.iv, 12);
    const encrypted = fromBase64(envelope.ciphertext, MAX_PLAINTEXT_BYTES + 16);
    if (salt.length !== 16 || iv.length !== 12 || encrypted.length < 16) throw new Error(BACKUP_ERROR);
    const metadata = header(envelope.salt, envelope.iv);
    const key = await deriveKey(passphrase, salt);
    let decrypted;
    try {
      decrypted = await secureCrypto().subtle.decrypt({
        name: "AES-GCM", iv, tagLength: 128,
        additionalData: new TextEncoder().encode(JSON.stringify(metadata)),
      }, key, encrypted);
    } catch {
      throw new Error(DECRYPT_ERROR);
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted));
    } catch {
      throw new Error(BACKUP_ERROR);
    }
    return validateBackupVault(payload);
  }

  async function importBackup(text, passphrase) {
    // Decrypt and validate the entire incoming document before accessing or changing local storage.
    const incoming = await decodeBackup(text, passphrase);
    let imported = 0;
    let skipped = 0;
    const vault = await update((current) => {
      const existingOrigins = new Set(current.profiles.map((profile) => siteOrigin(profile.loginUrl)));
      const accounts = new Map(current.profiles.map((profile) => [
        JSON.stringify([siteOrigin(profile.loginUrl), profile.enterpriseId, profile.username]), profile.id,
      ]));
      const ids = new Set(current.profiles.map((profile) => profile.id));
      const importedIds = new Map();
      for (const profile of incoming.profiles) {
        const account = JSON.stringify([siteOrigin(profile.loginUrl), profile.enterpriseId, profile.username]);
        if (accounts.has(account)) {
          skipped += 1;
          importedIds.set(profile.id, accounts.get(account));
          continue;
        }
        const id = ids.has(profile.id) ? newId(ids) : profile.id;
        current.profiles.push({ ...profile, id });
        accounts.set(account, id);
        ids.add(id);
        importedIds.set(profile.id, id);
        imported += 1;
      }
      if (current.profiles.length > LIMITS.profiles) throw new Error(`最多保存 ${LIMITS.profiles} 个账号。`);
      for (const [origin, id] of Object.entries(incoming.defaultProfiles)) {
        if (!existingOrigins.has(origin)) current.defaultProfiles[origin] = importedIds.get(id) || "";
      }
      // Existing defaults and the local automatic-fill switch are intentional user preferences.
    });
    return { vault, imported, skipped };
  }

  function randomIndex(size) {
    const limit = Math.floor(4294967296 / size) * size;
    const value = new Uint32Array(1);
    do { secureCrypto().getRandomValues(value); } while (value[0] >= limit);
    return value[0] % size;
  }

  function generatePassword({ length = 20, symbols = true } = {}) {
    if (!Number.isInteger(length) || length < 16 || length > 64) throw new Error("密码长度应为 16–64 位。");
    if (typeof symbols !== "boolean") throw new Error("特殊符号选项无效。");
    const groups = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789"];
    if (symbols) groups.push("!@#$%^&*()-_=+[]{}:,.?");
    const alphabet = groups.join("");
    const password = groups.map((group) => group[randomIndex(group.length)]);
    while (password.length < length) password.push(alphabet[randomIndex(alphabet.length)]);
    for (let index = password.length - 1; index > 0; index -= 1) {
      const other = randomIndex(index + 1);
      [password[index], password[other]] = [password[other], password[index]];
    }
    return password.join("");
  }

  globalThis.VaultStore = Object.freeze({
    MAX_BACKUP_BYTES,
    load, saveProfile, removeProfile, setDefault, setEnabled, clear,
    exportBackup, importBackup, generatePassword,
  });
})();
