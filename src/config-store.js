import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_BOX_WORK_ROOT = '/mmc/myt_recover_work';
export const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data-runtime');
export const DEFAULT_CONFIG_PATH = process.env.CONFIG_PATH || path.join(DEFAULT_DATA_DIR, 'config.json');
export const DEFAULT_JOBS_DIR = process.env.JOBS_DIR || path.join(DEFAULT_DATA_DIR, 'jobs');
export const DEFAULT_UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DEFAULT_DATA_DIR, 'uploads');
export const DEFAULT_SECRETS_DIR = process.env.SECRETS_DIR || path.join(DEFAULT_DATA_DIR, 'secrets');
export const DEFAULT_SSH_SECRETS_DIR = path.join(DEFAULT_SECRETS_DIR, 'ssh');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureParent(file) {
  ensureDir(path.dirname(file));
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureParent(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function createDefaultConfig() {
  return {
    version: 2,
    boxBase: '',
    sdkDir: '',
    ssh: {
      enabled: false,
      connections: [],
      activeConnectionId: '',
    },
    targets: {},
    recover: {
      boxWorkRoot: DEFAULT_BOX_WORK_ROOT,
      slot: '',
      targetName: '',
      baseline: '',
      baselineOptions: [],
      userId: '',
      mbp: '',
      proxyMappingFile: '',
      detectedUsers: [],
    },
  };
}

export function loadAppConfig(configPath = DEFAULT_CONFIG_PATH) {
  const cfg = readJson(configPath, null);
  if (!cfg || typeof cfg !== 'object') {
    return createDefaultConfig();
  }
  return mergeConfig(createDefaultConfig(), cfg);
}

export function saveAppConfig(config, configPath = DEFAULT_CONFIG_PATH) {
  const merged = mergeConfig(createDefaultConfig(), config || {});
  writeJson(configPath, merged);
  return merged;
}

export function mergeConfig(base, incoming) {
  const out = { ...base, ...(incoming || {}) };
  out.ssh = { ...(base.ssh || {}), ...((incoming || {}).ssh || {}) };
  out.recover = { ...(base.recover || {}), ...((incoming || {}).recover || {}) };
  out.targets = { ...(base.targets || {}), ...((incoming || {}).targets || {}) };
  if (!Array.isArray(out.ssh.connections)) out.ssh.connections = [];
  if (!Array.isArray(out.recover.baselineOptions)) out.recover.baselineOptions = [];
  if (!Array.isArray(out.recover.detectedUsers)) out.recover.detectedUsers = [];
  return out;
}

export function generateConnectionId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export function maskPath(p = '') {
  const s = String(p || '').trim();
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return s;
  return `.../${parts.slice(-2).join('/')}`;
}

export function resolveSshKeyPath(connectionId, sshSecretsDir = DEFAULT_SSH_SECRETS_DIR) {
  const safeId = String(connectionId || '').trim();
  return path.join(sshSecretsDir, safeId, 'private_key');
}

export function normalizeConnection(input = {}) {
  return {
    id: String(input.id || '').trim(),
    name: String(input.name || '').trim(),
    sshHost: String(input.sshHost || input.host || '').trim(),
    sshPort: Number(input.sshPort || input.port || 22) || 22,
    sshUser: String(input.sshUser || input.user || 'root').trim() || 'root',
    managementPort: Number(input.managementPort || 0) || 0,
    boxBase: String(input.boxBase || '').trim(),
    boxWorkRoot: String(input.boxWorkRoot || '').trim(),
    privateKey: String(input.privateKey || '').replace(/\r\n/g, '\n').trim(),
    privateKeyPath: String(input.privateKeyPath || '').trim(),
    privateKeyFingerprint: String(input.privateKeyFingerprint || '').trim(),
    hasPrivateKey: Boolean(input.hasPrivateKey || input.privateKeyPath || input.privateKey),
    updatedAt: String(input.updatedAt || '').trim(),
  };
}

export function sanitizeConnection(connection = {}) {
  const c = normalizeConnection(connection);
  return {
    ...c,
    privateKey: c.privateKey ? '[stored]' : '',
    privateKeyPath: c.privateKeyPath ? maskPath(c.privateKeyPath) : '',
    hasPrivateKey: Boolean(c.privateKeyPath || c.hasPrivateKey || c.privateKey),
  };
}

export function listConnections(config = {}) {
  return (Array.isArray(config?.ssh?.connections) ? config.ssh.connections : []).map(sanitizeConnection);
}

export function upsertConnection(config = {}, input = {}) {
  const next = mergeConfig(createDefaultConfig(), config || {});
  const list = Array.isArray(next.ssh.connections) ? next.ssh.connections.slice() : [];
  const id = String(input.id || '').trim() || generateConnectionId();
  const row = normalizeConnection({ ...input, id, updatedAt: new Date().toISOString() });
  const idx = list.findIndex((x) => String(x.id || '') === id);
  if (idx >= 0) list[idx] = { ...(list[idx] || {}), ...row };
  else list.push(row);
  next.ssh.connections = list;
  if (!next.ssh.activeConnectionId) next.ssh.activeConnectionId = id;
  return { config: next, connection: row };
}

export function getConnectionById(config = {}, connectionId = '') {
  const id = String(connectionId || '').trim();
  const list = Array.isArray(config?.ssh?.connections) ? config.ssh.connections : [];
  return list.find((x) => String(x.id || '') === id) || null;
}

export function getActiveConnection(config = {}) {
  const activeId = String(config?.ssh?.activeConnectionId || '').trim();
  return getConnectionById(config, activeId);
}

export function deleteConnection(config = {}, connectionId = '') {
  const id = String(connectionId || '').trim();
  const next = mergeConfig(createDefaultConfig(), config || {});
  const list = Array.isArray(next.ssh.connections) ? next.ssh.connections.slice() : [];
  const hit = list.find((x) => String(x.id || '') === id) || null;
  next.ssh.connections = list.filter((x) => String(x.id || '') !== id);
  if (String(next.ssh.activeConnectionId || '') === id) {
    next.ssh.activeConnectionId = next.ssh.connections[0]?.id || '';
  }
  return { config: next, deleted: hit };
}

export function writePrivateKey({ connectionId, privateKey, sshSecretsDir = DEFAULT_SSH_SECRETS_DIR }) {
  const content = String(privateKey || '').replace(/\r\n/g, '\n').trim();
  if (!content.includes('BEGIN') || !content.includes('PRIVATE KEY')) {
    throw new Error('私钥内容格式看起来不对');
  }
  const target = resolveSshKeyPath(connectionId, sshSecretsDir);
  ensureParent(target);
  fs.writeFileSync(target, `${content}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  const fingerprint = crypto.createHash('sha256').update(content).digest('base64');
  return {
    path: target,
    fingerprint: `SHA256:${fingerprint}`,
  };
}

export function ensureConnectionPrivateKeyFile(config = {}, connectionId = '', { sshSecretsDir = DEFAULT_SSH_SECRETS_DIR } = {}) {
  const next = mergeConfig(createDefaultConfig(), config || {});
  const pickedId = String(connectionId || next?.ssh?.activeConnectionId || '').trim();

  // 关键：显式指定了 connectionId 时，要让本次运行使用该连接作为 activeConnection
  if (pickedId) next.ssh.activeConnectionId = pickedId;

  const connection = getConnectionById(next, pickedId) || getActiveConnection(next);
  if (!connection) return { ok: false, error: '未找到盒子配置' };

  const existingPath = String(connection.privateKeyPath || '').trim();
  if (existingPath && fs.existsSync(existingPath)) {
    return { ok: true, config: applyActiveConnection(next), connection, keyPath: existingPath, created: false };
  }

  const privateKey = String(connection.privateKey || '').replace(/\r\n/g, '\n').trim();
  if (!privateKey) {
    return { ok: false, error: `盒子 ${connection.name || connection.id || ''} 未保存私钥内容，无法重建私钥文件`, connection };
  }

  const result = writePrivateKey({ connectionId: connection.id, privateKey, sshSecretsDir });
  const { config: updatedConfig, connection: updatedConnection } = upsertConnection(next, {
    ...connection,
    id: connection.id,
    privateKey,
    privateKeyPath: result.path,
    privateKeyFingerprint: result.fingerprint,
    hasPrivateKey: true,
  });
  // 本次重建/写入后也强制使用当前 connection 作为 activeConnection
  updatedConfig.ssh.activeConnectionId = connection.id;
  return {
    ok: true,
    config: applyActiveConnection(updatedConfig),
    connection: updatedConnection,
    keyPath: result.path,
    fingerprint: result.fingerprint,
    created: true,
  };
}

export function applyActiveConnection(config = {}) {
  const next = mergeConfig(createDefaultConfig(), config || {});
  const active = getActiveConnection(next);
  if (!active) return next;
  if (active.boxBase) next.boxBase = active.boxBase;
  next.ssh.enabled = true;
  next.ssh.host = active.sshHost;
  next.ssh.port = active.sshPort;
  next.ssh.user = active.sshUser;
  next.ssh.key = active.privateKeyPath;
  if (active.boxWorkRoot) next.recover.boxWorkRoot = active.boxWorkRoot;
  return next;
}
