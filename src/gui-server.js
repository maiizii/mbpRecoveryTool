import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BASE_PORT = Number(process.env.PORT || 23321);
const DEFAULT_BOX_WORK_ROOT = '/mmc/myt_recover_work';
const DEFAULT_SSH_HOST = 'mylo.gote.top';
const DEFAULT_SSH_PORT = 23191;
const DEFAULT_SSH_USER = 'root';
const DEFAULT_SSH_KEY = '/root/.ssh/MYT1_ed25519';

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function requestText(target, { method = 'GET', timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(target);
    const lib = u.protocol === 'https:' ? require('node:https') : http;
    const req = lib.request(
      u,
      { method, timeout, headers: { accept: 'application/json,text/plain,*/*' } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: raw }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

async function requestJson(target, opts = {}) {
  const r = await requestText(target, opts);
  if (!r.ok) return r;
  try {
    return { ...r, json: JSON.parse(r.body) };
  } catch {
    return r;
  }
}

function hostPort(bindings, key) {
  return bindings?.[key]?.[0]?.HostPort || null;
}

function mapContainer(c) {
  const pb = c.portBindings || {};
  return {
    name: c.name,
    status: c.status,
    image: c.image,
    indexNum: c.indexNum,
    adb: hostPort(pb, '5555/tcp') || c.adbPort || null,
    api: hostPort(pb, '9082/tcp') || null,
    rpa: hostPort(pb, '9083/tcp') || null,
    push: hostPort(pb, '10000/tcp') || null,
    touch: hostPort(pb, '10001/udp') || null,
    ip: c.ip || null,
    rawPortBindings: pb,
  };
}

async function discoverInstances(base) {
  const target = new URL('/android', base).toString();
  const result = await requestJson(target);
  if (!result.ok || !result.json) return { ok: false, result };
  const rawList = result.json?.data?.list;
  const list = Array.isArray(rawList) ? rawList.map(mapContainer) : [];
  return { ok: true, list, result };
}

function resolveEndpointOverrides(config, targetName) {
  const targetCfg = config?.targets?.[targetName] || {};
  return {
    instanceApi: targetCfg.instanceApi || null,
    rpaHost: targetCfg.rpaHost || null,
    rpaPort: targetCfg.rpaPort || null,
    adbPort: targetCfg.adbPort || null,
  };
}


function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(type.includes('application/json') ? JSON.stringify(body, null, 2) : body);
}

function serveStatic(res, file) {
  if (!fs.existsSync(file)) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'application/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : 'text/plain; charset=utf-8';
  send(res, 200, fs.readFileSync(file, 'utf8'), type);
}

function parseTrailingJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}

  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('{')) continue;
    const candidate = lines.slice(i).join('\n').trim();
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...args], {
      cwd: ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());
    child.on('close', (code) => {
      const all = `${stdout}${stderr}`.trim();
      const parsed = parseTrailingJson(stdout) || parseTrailingJson(all);
      resolve({ ok: code === 0, code, stdout, stderr, parsed, raw: all });
    });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message, parsed: null, raw: err.message }));
  });
}

function openBrowser(url) {
  const p = process.platform;
  if (p === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (p === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function runCmd(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message }));
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBoxPath(p = '') {
  const s = String(p || '').trim().replace(/\\+/g, '/');
  if (!s) return '';
  if (s.startsWith('/mmc/')) return s;
  if (s.startsWith('mmc/')) return `/${s}`;
  return s;
}

function isBoxPath(p) {
  return normalizeBoxPath(p).startsWith('/mmc/');
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function pickSshRuntime(cfg = {}) {
  const ssh = cfg?.ssh || {};
  const enabled = ssh.enabled === true || process.env.MYT_BOX_SSH_ENABLED === '1';
  return {
    enabled,
    host: String(ssh.host || process.env.MYT_BOX_SSH_HOST || DEFAULT_SSH_HOST).trim(),
    port: Number(ssh.port || process.env.MYT_BOX_SSH_PORT || DEFAULT_SSH_PORT),
    user: String(ssh.user || process.env.MYT_BOX_SSH_USER || DEFAULT_SSH_USER).trim(),
    key: String(ssh.key || process.env.MYT_BOX_SSH_KEY || DEFAULT_SSH_KEY).trim(),
  };
}

async function runSshCmd(cfg = {}, command = '') {
  const ssh = pickSshRuntime(cfg);
  if (!ssh.enabled) {
    return { ok: false, skipped: true, error: 'ssh disabled' };
  }
  if (!ssh.host || !ssh.port || !ssh.user || !ssh.key || !command) {
    return { ok: false, error: 'missing ssh config/command' };
  }
  return runCmd('ssh', [
    '-i', ssh.key,
    '-p', String(ssh.port),
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    `${ssh.user}@${ssh.host}`,
    command,
  ]);
}

async function scpToBox(cfg = {}, localFile = '', remoteFile = '') {
  const ssh = pickSshRuntime(cfg);
  if (!ssh.enabled) {
    return { ok: false, skipped: true, error: 'ssh disabled' };
  }
  if (!localFile || !fs.existsSync(localFile)) {
    return { ok: false, error: 'local file not found' };
  }
  if (!ssh.host || !ssh.port || !ssh.user || !ssh.key || !remoteFile) {
    return { ok: false, error: 'missing ssh config/remoteFile' };
  }
  return runCmd('scp', [
    '-i', ssh.key,
    '-P', String(ssh.port),
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    localFile,
    `${ssh.user}@${ssh.host}:${remoteFile}`,
  ]);
}

async function scpFromBox(cfg = {}, remoteFile = '', localFile = '') {
  const ssh = pickSshRuntime(cfg);
  if (!ssh.enabled) {
    return { ok: false, skipped: true, error: 'ssh disabled' };
  }
  if (!remoteFile) {
    return { ok: false, error: 'missing remoteFile' };
  }
  if (!localFile) {
    return { ok: false, error: 'missing localFile' };
  }
  ensureDir(path.dirname(localFile));
  if (!ssh.host || !ssh.port || !ssh.user || !ssh.key) {
    return { ok: false, error: 'missing ssh config' };
  }
  return runCmd('scp', [
    '-i', ssh.key,
    '-P', String(ssh.port),
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    `${ssh.user}@${ssh.host}:${remoteFile}`,
    localFile,
  ]);
}

async function extractLocalMbp(localMbp = '', extractDir = '') {
  if (!localMbp || !fs.existsSync(localMbp)) {
    return { ok: false, error: 'local mbp not found' };
  }
  if (!extractDir) {
    return { ok: false, error: 'missing extractDir' };
  }
  ensureDir(extractDir);
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch {}
  ensureDir(extractDir);
  return runCmd('tar', ['-xzf', localMbp, '-C', extractDir]);
}

function shellQuote(s = '') {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

async function ensureBoxTaskDir(cfg = {}, taskDir = '') {
  if (!taskDir) return { ok: false, error: 'missing taskDir' };
  return runSshCmd(cfg, `mkdir -p ${shellQuote(taskDir)}`);
}

async function copyMbpToBoxIfNeeded({ cfg = {}, userId = '', localSource = '', preferredSource = '' }) {
  const workRoot = cfg?.recover?.boxWorkRoot || DEFAULT_BOX_WORK_ROOT;
  const taskDir = path.posix.join(workRoot, userId);
  const remoteFile = isBoxPath(preferredSource)
    ? preferredSource
    : path.posix.join(taskDir, path.basename(localSource || `${userId}.mbp`));

  const mkdirOut = await ensureBoxTaskDir(cfg, path.posix.dirname(remoteFile));
  if (!mkdirOut.ok) {
    return {
      ok: false,
      taskDir,
      remoteFile,
      step: 'mkdir',
      error: (mkdirOut.stderr || mkdirOut.stdout || mkdirOut.error || 'mkdir failed').trim(),
    };
  }

  const scpOut = await scpToBox(cfg, localSource, remoteFile);
  if (!scpOut.ok) {
    return {
      ok: false,
      taskDir,
      remoteFile,
      step: 'scp',
      error: (scpOut.stderr || scpOut.stdout || scpOut.error || 'scp failed').trim(),
    };
  }

  return {
    ok: true,
    taskDir,
    remoteFile,
    step: 'done',
    detail: `${localSource} -> ${remoteFile}`,
  };
}

function findCfgDir(extractRoot) {
  const devDir = path.join(extractRoot, 'dev');
  if (fs.existsSync(devDir)) {
    const hit = fs.readdirSync(devDir, { withFileTypes: true })
      .find((d) => d.isDirectory() && d.name.startsWith('.cfg-'));
    if (hit) return path.join(devDir, hit.name);
  }

  const queue = [extractRoot];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (names.has('cfg.json') || names.has('location.json') || names.has('baseCfg.json')) {
      return dir;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.' || entry.name === '..') continue;
      queue.push(path.join(dir, entry.name));
    }
  }
  return null;
}

function safeReadText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function htmlUnescape(s = '') {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

function decodeXml(s = '') {
  return htmlUnescape(s);
}

function pickJsonByNameFromXml(xmlText, keyName) {
  const rx = new RegExp(`<string\\s+name=["']${keyName}["']>([\\s\\S]*?)<\\/string>`, 'i');
  const m = String(xmlText || '').match(rx);
  if (!m) return null;
  const raw = htmlUnescape(m[1]);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractUserInfoFromAwemeUserXmlText(xmlText, file = '') {
  const xml = String(xmlText || '');
  if (!xml.trim()) return {};

  const out = { awemeUserXml: file || '' };

  const currentUid = xml.match(/<string\s+name=["']current_foreground_uid["']>([^<]+)<\/string>/i)?.[1]?.trim() || '';
  if (currentUid) out.uid = currentUid;

  const rawInfo = pickJsonByNameFromXml(xml, 'user_info_raw');
  const account = rawInfo?.data || {};
  if (!out.uid) out.uid = String(account.user_id_str || account.user_id || '').trim();
  out.username = String(account.username || '').trim();
  out.name = String(account.name || account.screen_name || '').trim();
  out.secUid = String(account.sec_user_id || '').trim();
  out.avatarUrl = String(account.avatar_url || '').trim();

  const significant = pickJsonByNameFromXml(xml, `${out.uid || currentUid}_significant_user_info`);
  if (significant) {
    if (!out.uid) out.uid = String(significant.uid || '').trim();
    if (!out.username) out.username = String(significant.unique_id || '').trim();
    out.nickname = String(significant.nickname || '').trim();
    if (!out.secUid) out.secUid = String(significant.sec_uid || '').trim();
  }

  const awemeInfo = pickJsonByNameFromXml(xml, `${out.uid || currentUid}_aweme_user_info`);
  if (awemeInfo) {
    if (!out.uid) out.uid = String(awemeInfo.uid || '').trim();
    if (!out.username) out.username = String(awemeInfo.unique_id || '').trim();
    if (!out.nickname) out.nickname = String(awemeInfo.nickname || '').trim();
    if (!out.secUid) out.secUid = String(awemeInfo.sec_uid || '').trim();
    if (!out.name) out.name = String(awemeInfo.screen_name || '').trim();
  }

  const accountInfo = pickJsonByNameFromXml(xml, `${out.uid || currentUid}_account_user_info`);
  if (accountInfo) {
    if (!out.name) out.name = String(accountInfo.name || '').trim();
    if (!out.secUid) out.secUid = String(accountInfo.sec_uid || '').trim();
  }

  return out;
}

function findAwemeUserXml(extractRoot) {
  const fixed = path.join(
    extractRoot,
    'data', 'data', 'com.zhiliaoapp.musically', 'shared_prefs', 'aweme_user.xml',
  );
  if (fs.existsSync(fixed)) return fixed;

  const queue = [extractRoot];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'aweme_user.xml') return full;
      if (entry.isDirectory() && entry.name !== '.' && entry.name !== '..') queue.push(full);
    }
  }
  return '';
}

function extractUserInfoFromAwemeUserXml(extractRoot) {
  const file = findAwemeUserXml(extractRoot);
  if (!file) return {};
  return extractUserInfoFromAwemeUserXmlText(safeReadText(file, ''), file);
}

function resolveLocalMbpSource(userId, cfg = {}, preferredSource = '') {
  const s = normalizeBoxPath(preferredSource || cfg?.recover?.mbp || '');
  if (s) return s;

  const uid = String(userId || '').trim();
  if (!uid) return '';

  const workspaceRoot = path.resolve(ROOT, '..', '..', '..');
  const ssh = pickSshRuntime(cfg);
  const allowBoxSource = ssh.enabled || cfg?.recover?.allowBoxSource === true || process.env.MYT_ALLOW_BOX_SOURCE === '1';

  const candidates = [
    path.join(ROOT, `${uid}.mbp`),
    path.join(ROOT, 'tmp', `${uid}.mbp`),
    path.join(ROOT, 'tmp', 'mbp_local', `${uid}.mbp`),
    path.join(ROOT, 'tmp', 'detect-user', uid, `${uid}.mbp`),
    path.join(workspaceRoot, 'archive', 'mbp', `${uid}.mbp`),
    path.join(workspaceRoot, 'tmp', 'mbp_local', `${uid}.mbp`),
  ];

  if (allowBoxSource) {
    candidates.unshift(
      path.posix.join('/mmc/myt_recover_work', uid, `${uid}.working.mbp`),
      path.posix.join('/mmc/myt_recover_work', uid, `${uid}.mbp`),
      path.posix.join('/mmc/mbp', `${uid}.mbp`),
    );
  }

  for (const file of candidates) {
    if (!file) continue;
    if (isBoxPath(file)) return file;
    try {
      if (fs.existsSync(file)) return file;
    } catch {}
  }
  return '';
}

function pickPreferredInstance(list = [], preferredTargetName = '', preferredSlot = '') {
  const direct = String(preferredTargetName || '').trim();
  if (direct) {
    const hit = list.find((x) => x.name === direct);
    if (hit) return hit;
  }

  const slot = Number(preferredSlot || 0);
  if (slot > 0) {
    const officialRunning = list.find((x) => Number(x.indexNum) === slot && /^\d+_\d+_T\d+$/i.test(String(x.name || '')) && String(x.status || '').toLowerCase() === 'running');
    if (officialRunning) return officialRunning;
    const anyRunning = list.find((x) => Number(x.indexNum) === slot && String(x.status || '').toLowerCase() === 'running');
    if (anyRunning) return anyRunning;
    const officialAny = list.find((x) => Number(x.indexNum) === slot && /^\d+_\d+_T\d+$/i.test(String(x.name || '')));
    if (officialAny) return officialAny;
    const anySlot = list.find((x) => Number(x.indexNum) === slot);
    if (anySlot) return anySlot;
  }

  const cfgTarget = String(process.env.MYT_TARGET_NAME || '').trim();
  if (cfgTarget) {
    const hit = list.find((x) => x.name === cfgTarget);
    if (hit) return hit;
  }

  const officialRunning = list.find((x) => /^\d+_\d+_T\d+$/i.test(String(x.name || '')) && String(x.status || '').toLowerCase() === 'running');
  if (officialRunning) return officialRunning;
  const anyRunning = list.find((x) => String(x.status || '').toLowerCase() === 'running');
  if (anyRunning) return anyRunning;
  return list[0] || null;
}

async function resolveDetectTargetName(cfg = {}, preferredTargetName = '', preferredSlot = '') {
  if (cfg?.boxBase) {
    const discovered = await discoverInstances(cfg.boxBase);
    if (discovered.ok && discovered.list.length) {
      const picked = pickPreferredInstance(discovered.list, preferredTargetName || cfg?.recover?.targetName || '', preferredSlot || cfg?.recover?.slot || '');
      if (picked?.name) return picked.name;
    }
  }

  const direct = String(preferredTargetName || cfg?.recover?.targetName || process.env.MYT_TARGET_NAME || '').trim();
  if (direct) return direct;
  const names = Object.keys(cfg?.targets || {});
  return names[0] || '';
}

async function resolveDetectRpa(cfg = {}, preferredTargetName = '', preferredSlot = '') {
  const targetName = await resolveDetectTargetName(cfg, preferredTargetName, preferredSlot);
  let host = String(process.env.MYT_RPA_HOST || '').trim();
  let port = Number(process.env.MYT_RPA_PORT || 0);
  let source = host && port ? 'env' : '';

  if (cfg?.boxBase) {
    const discovered = await discoverInstances(cfg.boxBase);
    if (discovered.ok) {
      const picked = pickPreferredInstance(discovered.list, targetName, preferredSlot || cfg?.recover?.slot || '');
      if (picked) {
        const baseUrl = new URL(cfg.boxBase);
        host = host || baseUrl.hostname;
        port = port || Number(picked.rpa || 0);
        if (host && port && !source) source = 'discoverInstances';
        console.log(`[RPA_DEBUG] resolveDetectRpa picked instance: name=${picked.name}, slot=${picked.indexNum}, status=${picked.status}, api=${picked.api}, rpa=${picked.rpa}, ip=${picked.ip || ''}`);
        return { targetName: picked.name || targetName, host, port, apiPort: Number(picked.api || 0), adbPort: Number(picked.adb || 0), slot: Number(picked.indexNum || 0), source };
      }
    }
  }

  if (!host || !port) {
    const targetCfg = cfg?.targets?.[targetName] || {};
    host = host || String(targetCfg.rpaHost || '').trim();
    port = port || Number(targetCfg.rpaPort || 0);
    if (host && port && !source) source = 'config.targets';
  }
  console.log(`[RPA_DEBUG] resolveDetectRpa: targetName=${targetName}, host=${host}, port=${port}, slot=${preferredSlot || cfg?.recover?.slot || ''}, source=${source}`);
  return { targetName, host, port, slot: Number(preferredSlot || cfg?.recover?.slot || 0), source };
}

function getPythonCommand() {
  const custom = String(process.env.MYT_PYTHON || process.env.PYTHON || '').trim();
  if (custom) return { bin: custom, prefixArgs: [] };
  if (process.platform === 'win32') return { bin: 'py', prefixArgs: ['-3'] };
  return { bin: 'python3', prefixArgs: [] };
}

async function probeTcp(host = '', port = 0, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let done = false;
    const finish = (ok, error = '') => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true, ''));
    socket.on('timeout', () => finish(false, `tcp timeout ${timeoutMs}ms`));
    socket.on('error', (err) => finish(false, err?.message || 'tcp error'));
  });
}

async function runBoxExecViaRpa(cfg = {}, preferredTargetName = '', command = '', preferredSlot = '') {
  const rpa = await resolveDetectRpa(cfg, preferredTargetName, preferredSlot);
  if (!rpa.host || !rpa.port || !command) {
    console.error(`[RPA_DEBUG] runBoxExecViaRpa: missing rpa host/port/command. rpa=${JSON.stringify(rpa)}`);
    return { ok: false, error: 'missing rpa host/port/command', rpa };
  }
  const tcp = await probeTcp(rpa.host, rpa.port, 3000);
  if (!tcp.ok) {
    console.error(`[RPA_DEBUG] runBoxExecViaRpa: tcp probe failed. host=${rpa.host} port=${rpa.port} err=${tcp.error}`);
    return { ok: false, error: `rpa tcp unreachable: ${tcp.error}`, rpa, command };
  }
  const bundledSdkDir = path.join(ROOT, 'sdk', 'demo_py_x64');
  const cfgSdkDir = String(cfg?.sdkDir || '').trim();
  const sdkDir = (cfgSdkDir && fs.existsSync(cfgSdkDir)) ? cfgSdkDir : bundledSdkDir;
  if (!sdkDir || !fs.existsSync(sdkDir)) {
    console.error(`[RPA_DEBUG] runBoxExecViaRpa: sdkDir missing. sdkDir=${sdkDir}`);
    return { ok: false, error: 'sdkDir missing', rpa };
  }
  const tempScript = path.join(sdkDir, '_openclaw_rpa_exec_tmp.py');
  const code = String.raw`
import faulthandler, traceback, sys
faulthandler.enable()
try:
    from common.mytRpc import MytRpc
    api = MytRpc()
    print('SDK_VERSION', api.get_sdk_version(), flush=True)
    ok = api.init(${JSON.stringify(rpa.host)}, ${Number(rpa.port)}, 60)
    print('INIT_OK', ok, flush=True)
    if ok:
        try:
            print('CONNECTED', api.check_connect_state(), flush=True)
        except Exception as e:
            print('CONNECTED_ERR', repr(e), flush=True)
    if not ok:
        raise SystemExit(2)
    out, ok2 = api.exec_cmd(${JSON.stringify(command)})
    print('EXEC_OK', ok2, flush=True)
    print(out if isinstance(out, str) else str(out), flush=True)
except BaseException:
    traceback.print_exc()
    sys.stdout.flush()
    sys.stderr.flush()
    raise
`;
  fs.writeFileSync(tempScript, code, 'utf8');
  const py = getPythonCommand();
  console.log(`[RPA_DEBUG] runBoxExecViaRpa: Executing command. targetName=${preferredTargetName}, host=${rpa.host}, port=${rpa.port}, sdkDir=${sdkDir}, python=${py.bin} ${py.prefixArgs.join(' ')}, command=${command.substring(0, 100)}...`);
  const out = await runCmd(py.bin, [...py.prefixArgs, '-u', tempScript], { cwd: sdkDir });
  try { fs.unlinkSync(tempScript); } catch {}
  console.log(`[RPA_DEBUG] runBoxExecViaRpa: Command finished. ok=${out.ok} code=${out.code} signal=${out.signal || ''}\n  stdout: ${out.stdout}\n  stderr: ${out.stderr}`);
  return {
    ok: out.ok && /INIT_OK\s+True/.test(out.stdout || '') && /EXEC_OK\s+True/.test(out.stdout || ''),
    stdout: out.stdout || '',
    stderr: out.stderr || '',
    code: out.code,
    signal: out.signal || '',
    rpa,
    command,
    error: out.ok ? '' : (`exit=${out.code}${out.signal ? ` signal=${out.signal}` : ''} ${(out.stderr || out.stdout || 'rpa exec failed').trim()}`).trim(),
    rpa: rpa,
  };
}

function stripRpaExecOutput(text = '') {
  return String(text || '')
    .replace(/^INIT_OK\s+True\s*$/gmi, '')
    .replace(/^EXEC_OK\s+True\s*$/gmi, '')
    .trim();
}

async function runBoxReadTextViaRpa(cfg = {}, preferredTargetName = '', file = '', mode = 'text', preferredSlot = '') {
  const boxFile = normalizeBoxPath(file);
  if (!boxFile) return { ok: false, error: 'missing box file path', file: boxFile };
  const cmd = mode === 'strings'
    ? `if test -f ${shellQuote(boxFile)}; then strings ${shellQuote(boxFile)} 2>/dev/null || cat ${shellQuote(boxFile)} 2>/dev/null; else exit 3; fi`
    : `if test -f ${shellQuote(boxFile)}; then cat ${shellQuote(boxFile)} 2>/dev/null; else exit 3; fi`;
  const out = await runBoxExecViaRpa(cfg, preferredTargetName, cmd, preferredSlot);
  return {
    ...out,
    file: boxFile,
    text: out.ok ? stripRpaExecOutput(out.stdout || '') : '',
  };
}

async function runBoxPrepareDetectBundle(cfg = {}, userId = '', preferredTargetName = '', preferredSlot = '') {
  const exactPath = path.posix.join('/mmc/mbp', `${userId}.mbp`);
  const searchRoots = ['/mmc/mbp', '/mmc/myt_recover_work', '/sdcard', '/data/local/tmp'];
  const cmd = [
    `if test -f ${shellQuote(exactPath)}; then echo ${shellQuote(exactPath)}; exit 0; fi`,
    ...searchRoots.map((root) => `if test -d ${shellQuote(root)}; then (find ${shellQuote(root)} -type f -name ${shellQuote(userId + '.mbp')} 2>/dev/null; find ${shellQuote(root)} -type f -name ${shellQuote('*' + userId + '*.mbp')} 2>/dev/null) | head -n 1; fi`),
  ].join('; ');
  const out = await runSshCmd(cfg, cmd);
  const found = String(out.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';

  if (!out.ok) {
    return {
      ok: false,
      sourceMissing: false,
      sourceMbp: exactPath,
      remoteExtractDir: '',
      remoteFiles: {},
      searchedRoots: searchRoots,
      ssh: pickSshRuntime(cfg),
      error: `SSH检查盒子MBP失败: ${(out.stderr || out.stdout || out.error || 'ssh failed').trim()}`,
    };
  }

  if (!found) {
    return {
      ok: false,
      sourceMissing: true,
      sourceMbp: exactPath,
      remoteExtractDir: '',
      remoteFiles: {},
      searchedRoots: searchRoots,
      ssh: pickSshRuntime(cfg),
      error: `盒子端未命中目标 MBP（已搜索: ${searchRoots.join(', ')})`,
    };
  }

  return {
    ok: true,
    sourceMbp: found,
    remoteFiles: {},
    remoteExtractDir: '',
    ssh: pickSshRuntime(cfg),
  };
}

function findAccountSettingBlk(extractRoot) {
  const fixed = path.join(
    extractRoot,
    'data', 'data', 'com.zhiliaoapp.musically', 'files', 'keva', 'repo',
    'com.bytedance.sdk.account_setting',
    'com.bytedance.sdk.account_setting.blk',
  );
  if (fs.existsSync(fixed)) return fixed;

  const queue = [extractRoot];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'com.bytedance.sdk.account_setting.blk') return full;
      if (entry.isDirectory() && entry.name !== '.' && entry.name !== '..') queue.push(full);
    }
  }
  return '';
}

function extractUserInfoFromAccountSettingBlkText(text, file = '') {
  const raw = String(text || '');
  if (!raw.trim()) return {};

  const pick = (re) => raw.match(re)?.[1]?.trim() || '';
  const pickNear = (token, re, span = 260) => {
    const idx = raw.indexOf(token);
    if (idx < 0) return '';
    const seg = raw.slice(Math.max(0, idx - span), Math.min(raw.length, idx + span));
    return seg.match(re)?.[1]?.trim() || '';
  };
  const out = { accountSettingBlk: file || '' };

  out.uid = pick(/"uid"\s*:\s*"?(\d{10,})/i) || pickNear('user_id', /(\d{10,})/);
  out.username = pick(/"unique_id"\s*:\s*"([^"\\]+)"/i)
    || pickNear('user_name', /user_name\s*([^\s"\\\x00-\x1f}{]+(?:[._-][^\s"\\\x00-\x1f}{]+)*)/i);
  out.nickname = pick(/"nickname"\s*:\s*"([^"\\]+)"/i)
    || pickNear('mNickname', /mNickname\"?[:=]?\"?([^"\\\x00-\x1f}{]{2,80})/i);
  out.name = pick(/"(?:name|screen_name)"\s*:\s*"([^"\\]+)"/i)
    || pickNear('screen_name', /screen_name\s*([^\s"\\\x00-\x1f}{][^\x00-\x1f}{]{1,80})/i)
    || pickNear('name', /name\s*([^\s"\\\x00-\x1f}{][^\x00-\x1f}{]{1,80})/i);
  out.secUid = pick(/"(?:sec_uid|sec_user_id)"\s*:\s*"([^"\\]+)"/i)
    || pick(/(MS4wLjAB[0-9A-Za-z_\-]+)/i);
  out.avatarUrl = pick(/"avatar_url"\s*:\s*"([^"\\]+)"/i).replace(/\\\//g, '/');
  if (!out.avatarUrl) {
    const m = raw.match(/https?:\\\/\\\/[^\s"']+tiktokcdn[^\s"']+/i) || raw.match(/https?:\/\/[^\s"']+tiktokcdn[^\s"']+/i);
    out.avatarUrl = (m?.[0] || '').replace(/\\\//g, '/');
  }
  out.googlePlatformUid = pick(/"platform"\s*:\s*"google"[\s\S]{0,400}?"platform_uid"\s*:\s*"([^"\\]+)"/i);
  out.googleLogin = /"platform"\s*:\s*"google"/i.test(raw);

  return out;
}

function extractUserInfoFromAccountSettingBlk(extractRoot) {
  const file = findAccountSettingBlk(extractRoot);
  if (!file) return {};
  return extractUserInfoFromAccountSettingBlkText(safeReadText(file, ''), file);
}

function extractCookieStoreInfo(extractDir = '') {
  const cookiePath = path.join(extractDir, 'data', 'data', 'com.zhiliaoapp.musically', 'shared_prefs', 'ttnetCookieStore.xml');
  if (!cookiePath || !fs.existsSync(cookiePath)) {
    return { cookiePath: '', loggedInUidList: '', storeCountryCode: '', storeIdc: '', targetIdc: '', cookieRaw: '', msToken: '', odinTt: '' };
  }
  const raw = fs.readFileSync(cookiePath, 'utf8');
  const pick = (name) => {
    const re = new RegExp(`<string name=["']${name}["']>([\\s\\S]*?)<\\/string>`, 'i');
    const m = raw.match(re);
    return m ? decodeXml(m[1] || '').trim() : '';
  };
  return {
    cookiePath,
    loggedInUidList: pick('logged_in_uid_list') || pick('latest_logged_in_uid_list'),
    storeCountryCode: pick('http://tiktokv.com/|store-country-code') || pick('http://tiktokv.us/|store-country-code') || pick('http://tiktok.com/|store-country-code') || pick('http://ttapis.com/|store-country-code') || '',
    storeIdc: pick('http://tiktokv.com/|store-idc') || pick('http://tiktokv.us/|store-idc') || pick('http://tiktok.com/|store-idc') || pick('http://ttapis.com/|store-idc') || '',
    targetIdc: pick('http://tiktokv.com/|tt-target-idc') || pick('http://tiktokv.us/|tt-target-idc') || pick('http://tiktok.com/|tt-target-idc') || pick('http://ttapis.com/|tt-target-idc') || '',
    msToken: pick('http://tiktok.com/|msToken') || pick('http://tiktokv.com/|msToken') || pick('http://tiktokv.us/|msToken') || '',
    odinTt: pick('http://tiktok.com/|odin_tt') || pick('http://tiktokv.com/|odin_tt') || pick('http://tiktokv.us/|odin_tt') || '',
    cookieRaw: raw,
  };
}

function mapDetectedFromLocalData({ userId, cfg = {}, sourceMbp = '', taskDir = '', workingMbp = '', extractDir = '', cfgDir = '', cfgJson = {}, location = {}, baseCfg = {}, deviceInfo = {}, gsms = [], pif = {}, telephone = {}, awemeUser = {}, accountSetting = {} }) {
  const gsmMap = Array.isArray(gsms)
    ? Object.assign({}, ...gsms.filter(x => x && typeof x === 'object'))
    : {};
  const propBuild = deviceInfo?.prop?.Build || {};
  const overlay = cfgJson?.overlay || {};
  const locData = location?.data || {};
  const locCell = locData?.cell || {};
  const cookieInfo = extractCookieStoreInfo(extractDir);

  return {
    userId,
    sourceMbp,
    recoverMbp: workingMbp || sourceMbp,
    extractRoot: extractDir,

    uid: accountSetting.uid || awemeUser.uid || userId,
    username: accountSetting.username || awemeUser.username || '',
    nickname: accountSetting.nickname || awemeUser.nickname || '',
    name: accountSetting.name || awemeUser.name || '',
    secUid: accountSetting.secUid || awemeUser.secUid || '',
    avatarUrl: accountSetting.avatarUrl || awemeUser.avatarUrl || '',
    awemeUserXml: awemeUser.awemeUserXml || path.join(extractDir, 'data', 'data', 'com.zhiliaoapp.musically', 'shared_prefs', 'aweme_user.xml'),
    accountSettingBlk: accountSetting.accountSettingBlk || '',
    googleLogin: Boolean(accountSetting.googleLogin),
    googlePlatformUid: accountSetting.googlePlatformUid || '',

    model: deviceInfo?.base?.deviceName || propBuild['Build.MODEL'] || cfgJson?.model || '',
    brand: propBuild['Build.BRAND'] || propBuild['Build.MANUFACTURER'] || cfgJson?.brand || '',
    manufacturer: propBuild['Build.MANUFACTURER'] || '',
    androidId: cfgJson?.androidId || overlay?.android_id || '',
    serialNumber: overlay?.SERIALNUMBER || overlay?.serial_number || '',
    wifiMac: overlay?.wifi_mac || '',
    bluetoothMac: overlay?.bluetooth_mac || '',
    gaid: overlay?.gaid || '',
    oaid: overlay?.oaid || '',
    vaid: overlay?.vaid || '',
    udid: overlay?.udid || '',
    securityPatch: cfgJson?.prop?.['ro.build.version.security_patch'] || propBuild['VERSION.SECURITY_PATCH'] || '',

    proxyIp: locData?.ipAddress || location?.ipAddress || baseCfg?.socks5ip || baseCfg?.s5IP || '',
    country: locData?.countryName || location?.countryName || '',
    countryCode: locData?.countryCode || location?.countryCode || cookieInfo.storeCountryCode || '',
    region: locData?.regionName || '',
    city: locData?.cityName || location?.city || '',
    timezone: locCell?.zoneid || locCell?.timezone || '',
    latitude: locData?.latitude || locCell?.telephony_lat || '',
    longitude: locData?.longitude || locCell?.telephony_lon || '',
    storeCountryCode: cookieInfo.storeCountryCode || '',
    storeIdc: cookieInfo.storeIdc || '',
    targetIdc: cookieInfo.targetIdc || '',
    cookieStoreXml: cookieInfo.cookiePath || '',
    loggedInUidList: cookieInfo.loggedInUidList || '',
    msToken: cookieInfo.msToken || '',
    odinTt: cookieInfo.odinTt || '',

    carrier: locCell?.opername || gsmMap['gsm.sim.operator.alpha'] || '',
    mcc: locCell?.telephony_mcc || gsmMap['gsm.sim.operator.numeric']?.slice(0, 3) || '',
    mnc: locCell?.telephony_mnc || gsmMap['gsm.sim.operator.numeric']?.slice(3) || '',
    imsi: location?.['sim.imsi'] || locCell?.imsi || telephone?.imsi || '',
    iccid: locCell?.iccid || telephone?.iccid || '',
    lineNumber: locCell?.linenumber || telephone?.lineNumber || telephone?.number || '',

    s5Ip: baseCfg?.s5IP || '',
    s5Port: baseCfg?.s5Port || '',
    s5Type: baseCfg?.s5Type || '',
    imei: baseCfg?.imei || gsmMap['gsm.sim.imei'] || '',

    gmsModel: pif?.MODEL || '',
    gmsBrand: pif?.BRAND || '',
    gmsFingerprint: pif?.FINGERPRINT || '',
    gmsSecurityPatch: pif?.SECURITY_PATCH || '',

    fieldSources: {
      account: 'files/keva/repo/com.bytedance.sdk.account_setting/com.bytedance.sdk.account_setting.blk',
      accountFallback: 'shared_prefs/aweme_user.xml',
      device: 'dev/.cfg-*/cfg.json + device_info.json',
      gms: 'dev/.cfg-*/pif.json',
      network: 'dev/.cfg-*/location.json',
      sim: 'dev/.cfg-*/gsms.json + telephone.json',
      s5: 'dev/.cfg-*/baseCfg.json',
      cookie: 'shared_prefs/ttnetCookieStore.xml',
    },

    taskDir,
    workingMbp,
    cfgDir,
  };
}

async function prepareLocalDetectArtifacts(userId, cfg = {}, preferredSource = '', preferredTargetName = '', preferredSlot = '') {
  const taskDir = path.join(ROOT, 'tmp', 'detect-user', userId);
  const extractDir = path.join(taskDir, 'extract');
  const localSourceMbp = path.join(taskDir, `${userId}.mbp`);
  ensureDir(taskDir);

  const prepared = await runBoxPrepareDetectBundle(cfg, userId, preferredTargetName, preferredSlot);
  if (!prepared.ok) {
    let errorMsg = prepared.error || '未知错误';
    if (prepared.sourceMissing) {
      const roots = Array.isArray(prepared.searchedRoots) && prepared.searchedRoots.length ? `（已搜索: ${prepared.searchedRoots.join(', ')})` : '';
      errorMsg = `找不到 MBP 文件${roots}`;
    } else if (String(prepared.error || '').includes('ssh disabled')) {
      errorMsg = '未启用 SSH，无法从盒子读取 MBP';
    } else {
      errorMsg = `盒子连接异常: ${prepared.error || 'SSH连接失败'}`;
    }
    return {
      ok: false,
      sourceMissing: Boolean(prepared.sourceMissing),
      sourceMbp: prepared.sourceMbp || path.posix.join('/mmc/mbp', `${userId}.mbp`),
      localSourceMbp: '',
      backupMbp: '',
      extractDir,
      remoteExtractDir: prepared.remoteExtractDir || '',
      remoteFiles: prepared.remoteFiles || {},
      ssh: prepared.ssh || pickSshRuntime(cfg),
      error: `准备检测环境失败: ${errorMsg}`,
    };
  }

  const copied = await scpFromBox(cfg, prepared.sourceMbp, localSourceMbp);
  if (!copied.ok) {
    return {
      ok: false,
      sourceMissing: false,
      sourceMbp: prepared.sourceMbp,
      localSourceMbp,
      backupMbp: localSourceMbp,
      extractDir,
      remoteExtractDir: '',
      remoteFiles: {},
      ssh: prepared.ssh || pickSshRuntime(cfg),
      error: `复制 MBP 到工作目录失败: ${(copied.stderr || copied.stdout || copied.error || 'scp failed').trim()}`,
    };
  }

  const extracted = await extractLocalMbp(localSourceMbp, extractDir);
  if (!extracted.ok) {
    return {
      ok: false,
      sourceMissing: false,
      sourceMbp: prepared.sourceMbp,
      localSourceMbp,
      backupMbp: localSourceMbp,
      extractDir,
      remoteExtractDir: '',
      remoteFiles: {},
      ssh: prepared.ssh || pickSshRuntime(cfg),
      error: `MBP 拆包失败，可能是版本/结构不兼容: ${(extracted.stderr || extracted.stdout || extracted.error || 'extract failed').trim()}`,
    };
  }

  return {
    ok: true,
    sourceMbp: prepared.sourceMbp,
    localSourceMbp,
    backupMbp: localSourceMbp,
    backupOk: true,
    backupError: '',
    extractDir,
    fetchMode: 'box-ssh-local-extract',
    remoteExtractDir: '',
    remoteFiles: {},
    ssh: prepared.ssh || pickSshRuntime(cfg),
  };
}

async function readDetectData(userId, cfg = {}, prepared = {}, preferredTargetName = '', preferredSlot = '') {
  const extractDir = prepared.extractDir || '';
  const cfgDir = findCfgDir(extractDir) || '';

  const files = {
    cfgJson: cfgDir ? path.join(cfgDir, 'cfg.json') : '',
    location: cfgDir ? path.join(cfgDir, 'location.json') : '',
    baseCfg: cfgDir ? path.join(cfgDir, 'baseCfg.json') : '',
    deviceInfo: cfgDir ? path.join(cfgDir, 'device_info.json') : '',
    gsms: cfgDir ? path.join(cfgDir, 'gsms.json') : '',
    pif: cfgDir ? path.join(cfgDir, 'pif.json') : '',
    telephone: cfgDir ? path.join(cfgDir, 'telephone.json') : '',
    awemeUserXml: path.join(extractDir, 'data', 'data', 'com.zhiliaoapp.musically', 'shared_prefs', 'aweme_user.xml'),
    accountSettingBlk: findAccountSettingBlk(extractDir) || '',
    cookieStoreXml: path.join(extractDir, 'data', 'data', 'com.zhiliaoapp.musically', 'shared_prefs', 'ttnetCookieStore.xml'),
  };

  const awemeUserText = files.awemeUserXml ? safeReadText(files.awemeUserXml, '') : '';
  const accountSettingText = files.accountSettingBlk ? safeReadText(files.accountSettingBlk, '') : '';
  const awemeUser = extractUserInfoFromAwemeUserXmlText(awemeUserText, files.awemeUserXml || '');
  const accountSetting = extractUserInfoFromAccountSettingBlkText(accountSettingText, files.accountSettingBlk || '');

  const detected = mapDetectedFromLocalData({
    userId,
    cfg,
    sourceMbp: prepared.sourceMbp,
    taskDir: path.dirname(prepared.localSourceMbp || extractDir),
    workingMbp: prepared.localSourceMbp || '',
    extractDir,
    cfgDir,
    cfgJson: safeReadJson(files.cfgJson, {}) || {},
    location: safeReadJson(files.location, {}) || {},
    baseCfg: safeReadJson(files.baseCfg, {}) || {},
    deviceInfo: safeReadJson(files.deviceInfo, {}) || {},
    gsms: safeReadJson(files.gsms, []) || [],
    pif: safeReadJson(files.pif, {}) || {},
    telephone: safeReadJson(files.telephone, {}) || {},
    awemeUser,
    accountSetting,
  });

  return {
    ok: true,
    detected,
    diag: {
      cfgDir,
      files,
      cfgDirOk: Boolean(cfgDir),
      awemeUserXmlOk: Boolean(files.awemeUserXml && fs.existsSync(files.awemeUserXml)),
      localSourceMbp: prepared.localSourceMbp || '',
      fetchMode: prepared.fetchMode || '',
      ssh: prepared.ssh || null,
    },
  };
}

async function runDetectUserFlow(userId, cfg = {}, preferredSource = '', preferredTargetName = '', preferredSlot = '') {
  const stages = [];
  const prepared = await prepareLocalDetectArtifacts(userId, cfg, preferredSource, preferredTargetName, preferredSlot);

  stages.push({
    key: 'prepare_source_extract',
    label: '定位 MBP → 复制工作副本 → 本地拆包',
    status: prepared.ok ? 'done' : 'failed',
    detail: prepared.ok
      ? `source=${prepared.sourceMbp}`
      : (prepared.error || '源包处理失败'),
  });

  if (!prepared.ok) {
    const tcpUnreachable = /rpa tcp unreachable/i.test(prepared.error || '');
    return {
      status: prepared.sourceMissing ? 'missing_source' : 'prepare_failed',
      message: tcpUnreachable
        ? `盒子连接不可达：${prepared.error || 'unreachable'}`
        : prepared.sourceMissing
          ? `${prepared.error || `找不到 MBP 文件：${prepared.sourceMbp || path.posix.join('/mmc/mbp', `${userId}.mbp`)}`}`
          : `MBP 处理失败：${prepared.error || 'prepare failed'}`,
      detected: {
        userId,
        sourceMbp: prepared.sourceMbp || path.posix.join('/mmc/mbp', `${userId}.mbp`),
        recoverMbp: '',
        extractRoot: '',
        taskDir: '',
        workingMbp: '',
      },
      stages,
      diag: { prepared },
    };
  }

  const readOut = await readDetectData(userId, cfg, prepared, preferredTargetName, preferredSlot);
  const detected = readOut.detected;
  const hasDetails = Boolean(
    detected.username || detected.nickname || detected.name || detected.secUid || detected.proxyIp || detected.model || detected.brand || detected.androidId
  );

  stages.push({
    key: 'read_metadata',
    label: '读取本地解包结果',
    status: hasDetails ? 'done' : 'failed',
    detail: hasDetails ? '已读取' : '已解包，但未读取到足够资料',
  });

  const status = hasDetails ? 'ready' : 'source_only';
  const message = hasDetails
    ? `已完成 UID ${userId} 的 MBP 定位、工作副本处理、拆包与基础数据提取`
    : `已完成 UID ${userId} 的 MBP 拆包，但文件结构/版本可能不兼容，当前拿到的基础数据不足`;

  return { status, message, detected, stages, diag: readOut.diag || {} };
}

function buildRecoverArgs(configPath, mode, body = {}) {
  const args = [mode, `--config=${configPath}`];
  const targetName = body.targetName || body.target || '';
  const baseline = body.baseline || '';
  const mbp = body.mbp || '';
  const userId = body.userId || '';
  if (targetName) args.push(`--target-name=${targetName}`);
  if (baseline) args.push(`--baseline=${baseline}`);
  if (mbp) args.push(`--mbp=${mbp}`);
  if (userId) args.push(`--user-id=${userId}`);
  return args;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${server.address()?.port || BASE_PORT}`);

  if (req.method === 'GET' && u.pathname === '/') return serveStatic(res, path.join(WEB_DIR, 'index.html'));
  if (req.method === 'GET' && u.pathname === '/app.js') return serveStatic(res, path.join(WEB_DIR, 'app.js'));
  if (req.method === 'GET' && u.pathname === '/style.css') return serveStatic(res, path.join(WEB_DIR, 'style.css'));

  if (req.method === 'GET' && u.pathname === '/api/config') {
    return send(res, 200, readJson(CONFIG_PATH, {
      boxBase: '', sdkDir: '', targets: {}, recover: { boxWorkRoot: DEFAULT_BOX_WORK_ROOT },
    }));
  }

  if (req.method === 'POST' && u.pathname === '/api/config') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        writeJson(CONFIG_PATH, body);
        send(res, 200, { ok: true, config: body });
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/slots') {
    const out = await runCli(['slots', `--config=${CONFIG_PATH}`]);
    return send(res, out.ok ? 200 : 500, out);
  }

  if (req.method === 'GET' && u.pathname === '/api/list') {
    const out = await runCli(['list', `--config=${CONFIG_PATH}`]);
    return send(res, out.ok ? 200 : 500, out);
  }

  if (req.method === 'POST' && u.pathname === '/api/action') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const args = [body.mode, `--config=${CONFIG_PATH}`];
        if (body.slot != null && body.slot !== '') args.push(`--slot=${body.slot}`);
        if (body.targetName) args.push(`--target-name=${body.targetName}`);
        if (body.dryRun) args.push('--dry-run');
        const out = await runCli(args);
        send(res, out.ok ? 200 : 500, out);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/recover/detect-user') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const userId = String(body.userId || '').trim();
        const preferredSource = String(body.mbp || body.sourceMbp || '').trim();
        const preferredTargetName = String(body.targetName || '').trim();
        const preferredSlot = String(body.slot || '').trim();
        if (!userId) return send(res, 400, { ok: false, error: 'missing userId' });
        const cfg = readJson(CONFIG_PATH, {});
        const parsed = await runDetectUserFlow(userId, cfg, preferredSource, preferredTargetName, preferredSlot);
        return send(res, 200, { ok: true, parsed, detected: parsed.detected });
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/recover/precheck') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = await runCli(buildRecoverArgs(CONFIG_PATH, 'precheck', body));
        send(res, out.ok ? 200 : 500, out);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/recover/plan') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = await runCli(buildRecoverArgs(CONFIG_PATH, 'recover-plan', body));
        send(res, out.ok ? 200 : 500, out);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/recover/start') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = await runCli(buildRecoverArgs(CONFIG_PATH, 'recover-run', body)); // Use 'recover-run' for actual execution
        send(res, out.ok ? 200 : 500, out);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/recover/dryrun') {
    let raw = '';
    req.on('data', (d) => raw += d.toString());
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = await runCli(buildRecoverArgs(CONFIG_PATH, 'recover-dryrun', body));
        send(res, out.ok ? 200 : 500, out);
      } catch (err) {
        send(res, 400, { ok: false, error: err.message });
      }
    });
    return;
  }

  send(res, 404, { ok: false, error: 'not found' });
});

let currentPort = BASE_PORT;
function startServer() {
  console.log(`ROOT=${ROOT}`);
  console.log(`WEB_DIR=${WEB_DIR}`);
  server.listen(currentPort, '0.0.0.0', () => {
    const url = `http://0.0.0.0:${currentPort}`;
    console.log(`MYT GUI listening on ${url}`);
    console.log(`LAN access: http://<server-ip>:${currentPort}`);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${currentPort} is in use, trying next...`);
    currentPort++;
    setTimeout(startServer, 100);
  } else {
    console.error(err);
    process.exit(1);
  }
});

startServer();
