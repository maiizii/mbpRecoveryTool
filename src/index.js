import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { applyActiveConnection, ensureConnectionPrivateKeyFile, getActiveConnection } from './config-store.js';

function requestText(target, { method = 'GET', timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(target);
    const lib = u.protocol === 'https:' ? https : http;
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

function postJson(target, body, { timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(target);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body ?? {});
    const req = lib.request(
      u,
      {
        method: 'POST',
        timeout,
        headers: {
          accept: 'application/json,text/plain,*/*',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ ok: true, status: res.statusCode, headers: res.headers, body: raw, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
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

function pickArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function loadJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadJson(file, fallback = null) {
  const data = loadJsonIfExists(file);
  return data == null ? fallback : data;
}

function getConfig(configPath) {
  const raw = loadJsonIfExists(configPath) || {};
  return applyActiveConnection(raw);
}

function getNested(obj, keys, fallback = null) {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur;
}

function resolveVpcId(config = {}) {
  const candidates = [
    getNested(config, ['recover', 'vpcID'], null),
    getNested(config, ['recover', 'vpcId'], null),
    getNested(config, ['vpc', 'id'], null),
    config?.defaultVpcId,
  ];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 300;
}

function withPort(base, port) {
  const u = new URL(base);
  u.port = String(port);
  u.pathname = '/';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

function resolveInstanceApiFromTarget(target, boxBase) {
  if (target?.ip) return `http://${target.ip}:9082`;
  if (target?.api) return withPort(boxBase, target.api);
  return null;
}

function resolveEndpointOverrides(config, targetName) {
  const targetCfg = getNested(config, ['targets', targetName], {});
  return {
    instanceApi: targetCfg.instanceApi || null,
    rpaHost: targetCfg.rpaHost || null,
    rpaPort: targetCfg.rpaPort || null,
    adbPort: targetCfg.adbPort || null,
  };
}

async function probeBase(base) {
  const targets = [
    ['/info', '盒子版本信息'],
    ['/info/device', '盒子设备信息'],
    ['/android', '容器列表'],
    ['/mytVpc/group', 'VPC 组列表'],
  ];
  const rows = [];
  for (const [p, label] of targets) {
    const result = await requestJson(new URL(p, base).toString());
    rows.push({ kind: 'box-api', path: p, label, result });
  }
  return rows;
}

async function discoverInstances(base) {
  const result = await requestJson(new URL('/android', base).toString());
  if (!result.ok || !result.json) return { ok: false, result };
  const rawList = result.json?.data?.list;
  const list = Array.isArray(rawList) ? rawList.map(mapContainer) : [];
  return { ok: true, list, result };
}

async function probeInstanceApi(apiBase) {
  const targets = [
    ['/', '实例 API 根路径'],
    ['/proxy', '实例代理状态'],
  ];
  const rows = [];
  for (const [p, label] of targets) {
    const result = await requestJson(new URL(p, apiBase).toString());
    rows.push({ kind: 'instance-api', path: p, label, result });
  }
  return rows;
}

function runPythonSdkProbe({ host, port, sdkDir }) {
  const code = String.raw`
from common.mytRpc import MytRpc
api = MytRpc()
print('SDK_VERSION', api.get_sdk_version())
ok = api.init('${host}', ${port}, 15)
print('INIT_OK', ok)
print('CONNECTED', api.check_connect_state())
if ok:
    out, ok2 = api.exec_cmd('getprop ro.product.model')
    print('EXEC_OK', ok2)
    print('MODEL', str(out).strip())
`;

  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', code], { cwd: sdkDir, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolve({ kind: 'instance-rpa', host, port, ok: code === 0, code, stdout, stderr });
    });
    child.on('error', (err) => resolve({ kind: 'instance-rpa', host, port, ok: false, error: err.message }));
  });
}

function printTable(items) {
  for (const item of items) {
    console.log([
      item.name,
      `status=${item.status}`,
      `index=${item.indexNum}`,
      `adb=${item.adb ?? '-'}`,
      `api=${item.api ?? '-'}`,
      `rpa=${item.rpa ?? '-'}`,
      `ip=${item.ip || '-'}`,
    ].join(' | '));
  }
}

function briefResult(row) {
  if (!row?.result) return 'N/A';
  if (!row.result.ok) return `FAIL(${row.result.error || 'error'})`;
  return `OK(${row.result.status})`;
}

function pickRow(rows, kind, path) {
  return rows.find((r) => r.kind === kind && r.path === path);
}

function parseRpaStdout(stdout = '') {
  return {
    initOk: /INIT_OK\s+True/.test(stdout),
    connected: /CONNECTED\s+True/.test(stdout),
    execOk: /EXEC_OK\s+True/.test(stdout),
    model: stdout.match(/MODEL\s+(.+)/)?.[1]?.trim() || null,
  };
}

function sleep(ms = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContainerStatus({ boxBase, targetName, want = 'running', timeoutMs = 60000, intervalMs = 2000 }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const discovered = await discoverInstances(boxBase);
    if (discovered.ok) {
      const target = discovered.list.find((x) => x.name === targetName) || null;
      last = target;
      if (target?.status === want) return { ok: true, target };
    }
    await sleep(intervalMs);
  }
  return { ok: false, target: last, error: `timeout waiting for container status=${want}` };
}

async function waitForInstanceProxyReady({ instanceApi, timeoutMs = 60000, intervalMs = 3000 }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const row = await requestJson(new URL('/proxy', instanceApi).toString(), { timeout: 5000 });
    last = row;
    if (row?.ok) return { ok: true, result: row };
    await sleep(intervalMs);
  }
  return { ok: false, result: last, error: `timeout waiting for instance /proxy` };
}


async function waitForInstanceProxyReadyViaBox({ config, instanceApi, timeoutMs = 60000, intervalMs = 3000 }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const target = `${String(instanceApi || '').replace(/\/$/, '')}/proxy`;
    const script = [
      'URL=' + shellQuote(target),
      "TMP=/tmp/oc_proxy_$$.json",
      "STATUS=$(curl -sS --max-time 5 -o \"$TMP\" -w '%{http_code}' \"$URL\" 2>/dev/null || true)",
      "BODY=$(cat \"$TMP\" 2>/dev/null || true)",
      "rm -f \"$TMP\" >/dev/null 2>&1 || true",
      'printf "HTTP_STATUS=%s\n" "$STATUS"',
      'printf "BODY=%s\n" "$BODY"',
    ].join('; ');
    const out = await runSshCmd(config, script);
    const stdout = String(out.stdout || '');
    const status = (stdout.match(/HTTP_STATUS=(\d+)/) || [])[1] || '';
    const body = (stdout.match(/BODY=([\s\S]*)/) || [])[1] || '';
    let json = null;
    try { json = JSON.parse(body); } catch {}
    last = { ok: out.ok && status.startsWith('2'), status: Number(status || 0), body, json, stdout, stderr: out.stderr || '' };
    if (last.ok) return { ok: true, result: last };
    await sleep(intervalMs);
  }
  return { ok: false, result: last, error: 'timeout waiting for instance /proxy via box ssh' };
}

function runLocalCmd(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd || process.cwd(), env: options.env || process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message }));
  });
}

function stripSshNoise(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !/^Warning: Permanently added .* to the list of known hosts\.?$/i.test(x))
    .join('\n')
    .trim();
}

function summarizeCmdError(out = {}, fallback = 'command failed') {
  return stripSshNoise(out.stderr || '') || String(out.stdout || '').trim() || String(out.error || '').trim() || fallback;
}

function shellQuote(s = '') {
  return `'${String(s).replace(/'/g, `"'"'`)}'`;
}

function resolveProxyMappingPath(config = {}) {
  return String(config?.recover?.proxyMappingFile || path.join(process.cwd(), 'data', 'proxy-mapping.json'));
}

function parseSimpleCsvLine(line = '') {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => String(x || '').trim());
}

function normalizeProxyRow(row = {}, mappingFile = '') {
  const result = {
    id: row.ID ?? row.id ?? null,
    type: String(row.类型 ?? row.type ?? row.proxyType ?? 2),
    ip: String(row.IP ?? row.ip ?? row.proxyIp ?? '').trim(),
    port: String(row.端口 ?? row.port ?? row.proxyPort ?? '').trim(),
    user: String(row.用户名 ?? row.user ?? row.username ?? '').trim(),
    password: String(row.密码 ?? row.password ?? row.pass ?? '').trim(),
    status: row.状态 ?? row.status,
    remark: row.备注 ?? row.remark ?? '',
    raw: row,
    mappingFile,
  };
  return result;
}

async function lookupProxyMappingByIp({ config = {}, ip = '' }) {
  const mappingFile = resolveProxyMappingPath(config);
  if (!ip) return { ok: false, error: 'missing proxy ip', mappingFile };
  if (!fs.existsSync(mappingFile)) return { ok: false, error: `proxy mapping file not found: ${mappingFile}`, mappingFile };

  const ext = path.extname(mappingFile).toLowerCase();
  let row = null;

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : Array.isArray(parsed?.data) ? parsed.data : [];
      row = list.find((item) => String(item?.IP ?? item?.ip ?? item?.proxyIp ?? '').trim() === String(ip).trim()) || null;
    } catch (err) {
      return { ok: false, error: `proxy json parse failed: ${err.message}`, mappingFile };
    }
  } else if (ext === '.csv') {
    try {
      const raw = fs.readFileSync(mappingFile, 'utf8').replace(/^\uFEFF/, '');
      const lines = raw.split(/\r?\n/).filter((x) => x.trim());
      if (!lines.length) return { ok: false, error: 'proxy csv file is empty', mappingFile };
      const headers = parseSimpleCsvLine(lines[0]);
      const items = lines.slice(1).map((line) => {
        const cols = parseSimpleCsvLine(line);
        const item = {};
        headers.forEach((key, idx) => { item[key] = cols[idx] ?? ''; });
        return item;
      });
      row = items.find((item) => String(item?.IP ?? item?.ip ?? item?.proxyIp ?? '').trim() === String(ip).trim()) || null;
    } catch (err) {
      return { ok: false, error: `proxy csv parse failed: ${err.message}`, mappingFile };
    }
  } else if (ext === '.xlsx') {
    const py = [
      'import json, sys',
      'from openpyxl import load_workbook',
      'file_path = sys.argv[1]',
      'target_ip = str(sys.argv[2]).strip()',
      'wb = load_workbook(file_path, read_only=True, data_only=True)',
      'ws = wb[wb.sheetnames[0]]',
      'headers = [str(v).strip() if v is not None else "" for v in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]',
      'rows = []',
      'for row in ws.iter_rows(min_row=2, values_only=True):',
      '    item = {headers[i]: row[i] if i < len(row) else None for i in range(len(headers))}',
      '    if str(item.get("IP", "")).strip() == target_ip:',
      '        rows.append(item)',
      'payload = rows[0] if rows else None',
      'print(json.dumps(payload, ensure_ascii=False, default=str))',
    ].join('\n');
    const out = await runLocalCmd('python3', ['-c', py, mappingFile, String(ip)]);
    if (!out.ok) return { ok: false, error: (out.stderr || out.stdout || 'proxy lookup failed').trim(), mappingFile };
    const raw = String(out.stdout || '').trim();
    try { row = raw ? JSON.parse(raw) : null; } catch (err) {
      return { ok: false, error: `proxy lookup parse failed: ${err.message}`, mappingFile, raw };
    }
  } else {
    return { ok: false, error: `unsupported proxy mapping format: ${ext || '(none)'}`, mappingFile };
  }

  if (!row) return { ok: false, error: `proxy mapping not found for ip=${ip}`, mappingFile, proxyIp: ip };
  const result = normalizeProxyRow(row, mappingFile);
  if (!result.ip || !result.port) return { ok: false, error: `proxy mapping row incomplete for ip=${ip}`, mappingFile, row: result };
  return { ok: true, proxy: result };
}

async function callInstanceProxyCmdViaBox({ config = {}, instanceApi = '', query = '', method = 'GET', body = '' }) {
  const target = `${String(instanceApi || '').replace(/\/$/, '')}/proxy${query ? `?${query}` : ''}`;
  const parts = [
    'set -eu',
    `URL=${shellQuote(target)}`,
    `METHOD=${shellQuote(method)}`,
    `BODY=${shellQuote(body)}`,
    'TMP=/tmp/oc_proxy_call_$$.out',
    'if [ "$METHOD" = "POST" ]; then STATUS=$(curl -sS --max-time 12 -X POST -o "$TMP" -w "%{http_code}" --data "$BODY" "$URL" 2>/dev/null || true); else STATUS=$(curl -sS --max-time 12 -o "$TMP" -w "%{http_code}" "$URL" 2>/dev/null || true); fi',
    'BODY_TEXT=$(cat "$TMP" 2>/dev/null || true)',
    'rm -f "$TMP" >/dev/null 2>&1 || true',
    'printf "HTTP_STATUS=%s\n" "$STATUS"',
    'printf "BODY=%s\n" "$BODY_TEXT"',
  ];
  const out = await runSshCmd(config, parts.join('; '));
  const stdout = String(out.stdout || '');
  const status = (stdout.match(/HTTP_STATUS=(\d+)/) || [])[1] || '';
  const bodyText = (stdout.match(/BODY=([\s\S]*)/) || [])[1] || '';
  let json = null;
  try { json = JSON.parse(bodyText); } catch {}
  return { ok: out.ok && status.startsWith('2'), status: Number(status || 0), body: bodyText, json, stdout, stderr: out.stderr || '', url: target };
}

function normalizeProxyAddr(value = '') {
  return String(value || '').replace(/^socks5:\/\//i, '').trim();
}

function proxyReadbackMatches(state = {}, expected = {}) {
  const data = state?.json?.data || {};
  const actualAddr = normalizeProxyAddr(data.addr || '');
  const expectedAddr = normalizeProxyAddr(`${expected.ip || ''}:${expected.port || ''}`);
  const actualType = String(data.type ?? '').trim();
  const expectedType = String(expected.type ?? '').trim();
  if (!actualAddr || !expectedAddr) return false;
  if (actualAddr !== expectedAddr) return false;
  if (expectedType && actualType && actualType !== expectedType) return false;
  return true;
}

function pickSshRuntime(cfg = {}) {
  const active = getActiveConnection(cfg || {});
  const ssh = cfg?.ssh || {};
  const enabled = ssh.enabled === true || process.env.MYT_BOX_SSH_ENABLED === '1' || Boolean(active?.privateKeyPath);
  return {
    enabled,
    host: String(ssh.host || active?.sshHost || process.env.MYT_BOX_SSH_HOST || '').trim(),
    port: Number(ssh.port || active?.sshPort || process.env.MYT_BOX_SSH_PORT || 22),
    user: String(ssh.user || active?.sshUser || process.env.MYT_BOX_SSH_USER || 'root').trim(),
    key: String(ssh.key || active?.privateKeyPath || process.env.MYT_BOX_SSH_KEY || '').trim(),
  };
}

function ensureActiveSshKeyFile(config = {}) {
  const active = getActiveConnection(config || {});
  const pickedId = String(config?.recover?.connectionId || active?.id || '').trim();
  if (!pickedId) return { ok: true, config };

  // ensureConnectionPrivateKeyFile 会在私钥文件缺失时自动重建，并返回带有最新 privateKeyPath 的 config
  // 这里必须优先用 recover.connectionId（用户在 UI 选的盒子），否则会误用 activeConnectionId
  const ensured = ensureConnectionPrivateKeyFile(config, pickedId);
  if (!ensured.ok) return { ok: false, error: ensured.error || 'ssh private key unavailable' };

  return { ok: true, config: ensured.config || config };
}

async function runSshCmd(config = {}, command = '') {
  const ensured = ensureActiveSshKeyFile(config);
  if (!ensured.ok) return { ok: false, error: ensured.error || 'ssh private key unavailable' };
  const ssh = pickSshRuntime(ensured.config);
  if (!ssh.enabled) return { ok: false, error: 'ssh disabled' };
  return runLocalCmd('ssh', [
    '-i', ssh.key,
    '-p', String(ssh.port),
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=8',
    '-o', 'LogLevel=ERROR',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    `${ssh.user}@${ssh.host}`,
    command,
  ]);
}

async function resolveUserdataImagePath(config = {}, targetName = '', log) {
  const cmd = `find /mmc/data -maxdepth 2 -path ${shellQuote(`*${targetName}*/userdata.img`)} 2>/dev/null | head -n 1`;
  const out = await runSshCmd(config, cmd);

  log(`DEBUG[resolveUserdataImagePath]: targetName=${targetName}`);
  log(`DEBUG[resolveUserdataImagePath]: cmd=${cmd}`);
  log(`DEBUG[resolveUserdataImagePath]: runSshCmd ok=${out.ok}, code=${out.code}, stdout=${JSON.stringify(out.stdout)}, stderr=${JSON.stringify(out.stderr)}`);
  const userdata = String(out.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return { ...out, userdata };
}

async function replaceBaselineOverSsh({ config = {}, targetName = '', baseline = '', log }) {
  const resolved = await resolveUserdataImagePath(config, targetName, log);
  if (!resolved.ok || !resolved.userdata) {
    return { ok: false, error: `未找到目标 userdata.img: ${targetName}`, detail: resolved.stderr || resolved.stdout || resolved.error || '' };
  }

  const userdata = resolved.userdata;
  log(`DEBUG[replaceBaselineOverSsh]: input targetName=${targetName}, baseline=${baseline}`);
  log(`DEBUG[replaceBaselineOverSsh]: resolved.ok=${resolved.ok}, resolved.userdata=${JSON.stringify(resolved.userdata)}, resolved.stderr=${JSON.stringify(resolved.stderr)}`);
  log(`DEBUG[replaceBaselineOverSsh]: userdata=${userdata}`);
  const script = [
    'set -eu',
    `BASELINE=${shellQuote(baseline)}`,
    `TARGET=${shellQuote(userdata)}`,
    'if [ ! -f "' + '$' + 'BASELINE" ]; then echo BASELINE_MISSING; exit 11; fi',
    'if [ ! -f "' + '$' + 'TARGET" ]; then echo TARGET_MISSING; exit 12; fi',
    'BS=$(stat -c%s "' + '$' + 'BASELINE" 2>/dev/null || wc -c < "' + '$' + 'BASELINE")',
    'TS=$(stat -c%s "' + '$' + 'TARGET" 2>/dev/null || wc -c < "' + '$' + 'TARGET")',
    'echo BASELINE_SIZE=' + '$' + 'BS',
    'echo TARGET_SIZE_BEFORE=' + '$' + 'TS',
    'START_TS=$(date +%s)',
    'cp -f "' + '$' + 'BASELINE" "' + '$' + 'TARGET"',
    'sync',
    'END_TS=$(date +%s)',
    'TS2=$(stat -c%s "' + '$' + 'TARGET" 2>/dev/null || wc -c < "' + '$' + 'TARGET")',
    'echo TARGET_SIZE_AFTER=' + '$' + 'TS2',
    'echo COPY_SECONDS=$((' + '$' + 'END_TS-' + '$' + 'START_TS))',
    'echo COPY_OK=1',
  ].join('; ');
  log(`DEBUG[replaceBaselineOverSsh]: script=${JSON.stringify(script)}`);
  const out = await runSshCmd(config, script);
  return { ...out, userdata };
}

async function scpToBox(config = {}, localFile = '', remoteFile = '') {
  const ensured = ensureActiveSshKeyFile(config);
  if (!ensured.ok) return { ok: false, error: ensured.error || 'ssh private key unavailable' };
  const ssh = pickSshRuntime(ensured.config);
  if (!ssh.enabled) return { ok: false, error: 'ssh disabled' };
  if (!localFile || !fs.existsSync(localFile)) return { ok: false, error: 'local file not found' };
  return runLocalCmd('scp', [
    '-i', ssh.key,
    '-P', String(ssh.port),
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=8',
    '-o', 'LogLevel=ERROR',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    localFile,
    `${ssh.user}@${ssh.host}:${remoteFile}`,
  ]);
}

function ensureDir(dir = '') {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function resolveLocalUserLayerSource(userId = '') {
  if (!userId) return '';
  const base = path.resolve(process.cwd(), 'tmp', 'detect-user', String(userId), 'extract', 'data', 'data', 'com.zhiliaoapp.musically');
  return fs.existsSync(base) ? base : '';
}

function resolveBoxWorkRoot(config = {}) {
  return config?.recover?.boxWorkRoot || '/mmc/myt_recover_work';
}

function resolveBoxRecoverWorkspace(config = {}, userId = '') {
  const root = resolveBoxWorkRoot(config);
  return {
    root,
    taskDir: path.posix.join(root, String(userId || 'unknown')),
    sourceMbp: path.posix.join('/mmc/mbp', `${userId}.mbp`),
    remoteMbp: path.posix.join(root, String(userId || 'unknown'), `${userId}.mbp`),
    extractRoot: path.posix.join(root, String(userId || 'unknown'), 'extract'),
    appRoot: path.posix.join(root, String(userId || 'unknown'), 'extract', 'data', 'data', 'com.zhiliaoapp.musically'),
    cfgDevRoot: path.posix.join(root, String(userId || 'unknown'), 'extract', 'dev'),
  };
}

async function prepareRemoteMbpArtifacts({ config = {}, userId = '', mbp = '', log }) {
  const ws = resolveBoxRecoverWorkspace(config, userId);
  const rawMbp = String(mbp || '').trim();
  const workRoot = resolveBoxWorkRoot(config);
  const isEphemeralRemoteMbp = rawMbp.startsWith(`${workRoot}/`) || rawMbp === ws.remoteMbp;
  const sourceMbp = (!rawMbp || rawMbp.startsWith('/root/') || rawMbp.startsWith('/tmp/') || rawMbp.includes('/workspace/') || isEphemeralRemoteMbp)
    ? ws.sourceMbp
    : rawMbp;
  if (log) log(`DEBUG[prepareRemoteMbpArtifacts]: rawMbp=${rawMbp || '-'} -> sourceMbp=${sourceMbp}`);
  const cmd = [
    'set -eu',
    `SRC=${shellQuote(sourceMbp)}`,
    `TASK_DIR=${shellQuote(ws.taskDir)}`,
    `REMOTE_MBP=${shellQuote(ws.remoteMbp)}`,
    `EXTRACT_ROOT=${shellQuote(ws.extractRoot)}`,
    'if [ ! -f "$SRC" ]; then echo MBP_MISSING=$SRC; exit 21; fi',
    'mkdir -p "$TASK_DIR"',
    'if [ "$SRC" = "$REMOTE_MBP" ]; then echo SKIP_COPY_SAME_FILE=1; else cp -f "$SRC" "$REMOTE_MBP"; fi',
    'rm -rf "$EXTRACT_ROOT"',
    'mkdir -p "$EXTRACT_ROOT"',
    'tar -xzf "$REMOTE_MBP" -C "$EXTRACT_ROOT"',
    `test -d ${shellQuote(ws.appRoot)}`,
    'echo REMOTE_MBP_READY=1',
    'echo REMOTE_EXTRACT_ROOT="$EXTRACT_ROOT"',
  ].join('; ');
  const out = await runSshCmd(config, cmd);
  if (!out.ok) {
    return { ok: false, step: 'prepare-remote-mbp', error: summarizeCmdError(out, 'remote mbp prepare failed'), workspace: ws, sourceMbp };
  }
  return { ok: true, workspace: ws, sourceMbp, detail: (out.stdout || '').trim() };
}

async function cleanupRemoteRecoverWorkspace({ config = {}, userId = '', log }) {
  const ws = resolveBoxRecoverWorkspace(config, userId);
  const cmd = [
    'set +e',
    `TASK_DIR=${shellQuote(ws.taskDir)}`,
    'if [ -n "$TASK_DIR" ] && [ "$TASK_DIR" != "/" ] && [ -d "$TASK_DIR" ]; then rm -rf "$TASK_DIR"; fi',
    'echo CLEANED_TASK_DIR="$TASK_DIR"',
  ].join('; ');
  const out = await runSshCmd(config, cmd);
  if (log) {
    if (out.ok) log(`收尾清理：已删除盒子工作目录 ${ws.taskDir}`);
    else log(`收尾清理失败：${(out.stderr || out.stdout || out.error || 'cleanup failed').trim()}`);
  }
  return { ok: out.ok, workspace: ws, detail: (out.stdout || out.stderr || out.error || '').trim() };
}

function resolveLocalCfgSource(userId = '') {
  if (!userId) return '';
  const devDir = path.resolve(process.cwd(), 'tmp', 'detect-user', String(userId), 'extract', 'dev');
  if (!fs.existsSync(devDir)) return '';
  const hit = fs.readdirSync(devDir, { withFileTypes: true }).find((d) => d.isDirectory() && d.name.startsWith('.cfg-'));
  return hit ? path.join(devDir, hit.name) : '';
}

async function prepareRemoteDeviceFile({ config = {}, localFile = '', remoteFile = '', log }) {
  if (!localFile || !fs.existsSync(localFile)) {
    return { ok: false, error: `missing local file: ${localFile}` };
  }
  const remoteTmp = `/tmp/${path.basename(remoteFile)}`;
  const pushed = await scpToBox(config, localFile, remoteTmp);
  if (!pushed.ok) {
    return { ok: false, step: 'upload-device-file', error: (pushed.stderr || pushed.stdout || pushed.error || 'scp failed').trim(), remoteTmp };
  }
  const cmd = [
    'set -eu',
    `mkdir -p ${shellQuote(path.posix.dirname(remoteFile))}`,
    `cp -f ${shellQuote(remoteTmp)} ${shellQuote(remoteFile)}`,
    'sync',
    `sha256sum ${shellQuote(remoteFile)} | cut -d" " -f1`,
  ].join('; ');
  const applied = await runSshCmd(config, cmd);
  if (!applied.ok) {
    return { ok: false, step: 'apply-device-file', error: (applied.stderr || applied.stdout || applied.error || 'apply failed').trim(), remoteTmp };
  }
  const sha = String(applied.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  return { ok: true, remoteTmp, remoteFile, sha };
}

async function injectDeviceFiles({ config = {}, targetName = '', userId = '', mbp = '', prepared = null, log }) {
  const resolved = await resolveUserdataImagePath(config, targetName, log);
  if (!resolved.ok || !resolved.userdata) {
    return { ok: false, error: `未找到目标 userdata.img: ${targetName}` };
  }
  const preparedState = prepared || await prepareRemoteMbpArtifacts({ config, userId, mbp, log });
  if (!preparedState.ok) {
    return { ok: false, error: preparedState.error || 'remote mbp prepare failed', step: preparedState.step, workspace: preparedState.workspace, sourceMbp: preparedState.sourceMbp };
  }
  const targetRoot = path.posix.dirname(resolved.userdata);
  const cfgDevRoot = preparedState.workspace?.cfgDevRoot || path.posix.join(resolveBoxWorkRoot(config), String(userId || 'unknown'), 'extract', 'dev');
  const findCfgCmd = [
    'set -eu',
    `CFG_DEV_ROOT=${shellQuote(cfgDevRoot)}`,
    'CFG_DIR=$(find "$CFG_DEV_ROOT" -maxdepth 1 -mindepth 1 -type d -name ".cfg-*" | head -n 1)',
    'if [ -z "$CFG_DIR" ]; then echo CFG_DIR_MISSING; exit 31; fi',
    'echo "$CFG_DIR"',
  ].join('; ');
  const cfgDirOut = await runSshCmd(config, findCfgCmd);
  if (!cfgDirOut.ok) {
    return { ok: false, error: (cfgDirOut.stderr || cfgDirOut.stdout || cfgDirOut.error || 'cfg dir resolve failed').trim(), step: 'resolve-remote-cfg-dir', targetRoot, cfgDevRoot };
  }
  const cfgSource = String(cfgDirOut.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  if (!cfgSource) {
    return { ok: false, error: `未找到盒子机参目录: ${cfgDevRoot}`, step: 'resolve-remote-cfg-dir', targetRoot, cfgDevRoot };
  }
  const listCmd = [
    'set -eu',
    `CFG_DIR=${shellQuote(cfgSource)}`,
    'cd "$CFG_DIR"',
    'for f in *; do [ -f "$f" ] && printf "%s\\n" "$f"; done | sort',
  ].join('; ');
  const listOut = await runSshCmd(config, listCmd);
  if (!listOut.ok) {
    return { ok: false, error: (listOut.stderr || listOut.stdout || listOut.error || 'cfg file list failed').trim(), step: 'list-remote-cfg-files', targetRoot, cfgSource };
  }
  const cfgFiles = String(listOut.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!cfgFiles.length) {
    return { ok: false, error: `机参目录内没有可复制文件: ${cfgSource}`, step: 'list-remote-cfg-files', targetRoot, cfgSource };
  }

  const rootDupSet = new Set(['cfg.json', 'baseCfg.json']);
  const results = [];
  for (const name of cfgFiles) {
    results.push({ name, remoteFile: `${targetRoot}/modelData/${name}`, copied: true, mode: 'bulk' });
    if (rootDupSet.has(name)) results.push({ name, remoteFile: `${targetRoot}/${name}`, copied: true, mode: 'bulk-root-dup' });
  }

  const quotedFiles = cfgFiles.map((name) => shellQuote(name)).join(' ');
  log(`机参批量覆盖开始：共 ${cfgFiles.length} 个源文件，目标 modelData + 根目录补位`);
  const bulkCmd = [
    'set -eu',
    `SRC_DIR=${shellQuote(cfgSource)}`,
    `TARGET_ROOT=${shellQuote(targetRoot)}`,
    'MODEL_DIR="$TARGET_ROOT/modelData"',
    'mkdir -p "$MODEL_DIR"',
    `(cd "$SRC_DIR" && tar -cf - ${quotedFiles}) | (cd "$MODEL_DIR" && tar -xf -)`,
    'if [ -f "$SRC_DIR/cfg.json" ]; then cp -f "$SRC_DIR/cfg.json" "$TARGET_ROOT/cfg.json"; fi',
    'if [ -f "$SRC_DIR/baseCfg.json" ]; then cp -f "$SRC_DIR/baseCfg.json" "$TARGET_ROOT/baseCfg.json"; fi',
    'sync',
    'echo BULK_COPY_OK=1',
    'echo BULK_MODEL_DIR="$MODEL_DIR"',
    'find "$MODEL_DIR" -maxdepth 1 -type f | sed -n "1,40p"',
  ].join('; ');
  const bulkOut = await runSshCmd(config, bulkCmd);
  if (!bulkOut.ok) {
    return { ok: false, error: (bulkOut.stderr || bulkOut.stdout || bulkOut.error || 'bulk remote device file failed').trim(), step: 'bulk-apply-remote-device-files', targetRoot, cfgSource, results };
  }
  log('机参批量覆盖完成');
  const bulkText = String(bulkOut.stdout || '').trim();
  if (bulkText) {
    for (const line of bulkText.split(/\r?\n/)) log(`机参批量日志：${line}`);
  }

  const verifyCmd = [
    'set -eu',
    `CFG=${shellQuote(targetRoot + '/modelData/cfg.json')}`,
    `DINFO=${shellQuote(targetRoot + '/modelData/device_info.json')}`,
    `PIF=${shellQuote(targetRoot + '/modelData/pif.json')}`,
    "python3 - <<'PY'\nimport json\nfrom pathlib import Path\nimport os\nfor key, path in [('cfg', os.environ.get('CFG')), ('dinfo', os.environ.get('DINFO')), ('pif', os.environ.get('PIF'))]:\n    if not path or not Path(path).exists():\n        continue\n    try:\n        data=json.loads(Path(path).read_text())\n    except Exception:\n        continue\n    if key=='cfg':\n        print('VERIFY_CFG_MODEL=' + str(data.get('model','')))\n        prop=data.get('prop') or {}\n        print('VERIFY_CFG_PATCH=' + str(prop.get('ro.build.version.security_patch','')))\n    elif key=='dinfo':\n        base=data.get('base') or {}\n        prop=data.get('prop') or {}\n        build=prop.get('Build') or {}\n        print('VERIFY_DINFO_MODEL=' + str(base.get('deviceName','') or build.get('Build.MODEL','')))\n        print('VERIFY_DINFO_BUILD=' + str(build.get('Build.DISPLAY','')))\n    elif key=='pif':\n        print('VERIFY_PIF_MODEL=' + str(data.get('MODEL','')))\n        print('VERIFY_PIF_FINGERPRINT=' + str(data.get('FINGERPRINT','')))\nPY",
  ].join('; ');
  const verifyOut = await runSshCmd(config, verifyCmd);
  const verifyText = String(verifyOut.stdout || '').trim();
  if (verifyText) {
    for (const line of verifyText.split(/\r?\n/)) log(`机参回读：${line}`);
  }
  return { ok: true, targetRoot, cfgSource, results, verify: verifyText, workspace: preparedState.workspace, sourceMbp: preparedState.sourceMbp };
}

function buildRecoverJobId(userId = '') {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `recover_${userId || 'unknown'}_${stamp}`;
}

async function uploadUserLayerEntry({ config = {}, relPath = '', localSourceBase = '', remoteSourceBase = '', jobLocalDir = '', log }) {
  const localPath = path.join(localSourceBase, relPath);
  if (!fs.existsSync(localPath)) {
    return { ok: false, skipped: true, relPath, error: `missing local path: ${localPath}` };
  }
  ensureDir(jobLocalDir);
  const safeName = relPath.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const archiveFile = path.join(jobLocalDir, `${safeName || 'entry'}_${Date.now()}.tgz`);
  const pack = await runLocalCmd('tar', ['-czf', archiveFile, '-C', localSourceBase, relPath]);
  if (!pack.ok) {
    return { ok: false, relPath, step: 'pack', error: (pack.stderr || pack.stdout || 'tar pack failed').trim() };
  }

  const remoteArchive = `/tmp/${path.basename(archiveFile)}`;
  const push = await scpToBox(config, archiveFile, remoteArchive);
  if (!push.ok) {
    return { ok: false, relPath, step: 'upload', error: (push.stderr || push.stdout || push.error || 'scp failed').trim() };
  }

  const remoteTarget = path.posix.join(remoteSourceBase, relPath);
  const unpackCmd = [
    'set -eu',
    `mkdir -p ${shellQuote(path.posix.dirname(remoteTarget))}`,
    `rm -rf ${shellQuote(remoteTarget)}`,
    `cd ${shellQuote(remoteSourceBase)}`,
    `tar -xzf ${shellQuote(remoteArchive)}`,
    `test -e ${shellQuote(remoteTarget)}`,
    `find ${shellQuote(remoteTarget)} -maxdepth 2 | sed -n '1,20p'`,
  ].join('; ');
  const unpack = await runSshCmd(config, unpackCmd);
  if (!unpack.ok) {
    return { ok: false, relPath, step: 'unpack', error: (unpack.stderr || unpack.stdout || unpack.error || 'remote unpack failed').trim() };
  }

  return {
    ok: true,
    relPath,
    archiveFile,
    remoteArchive,
    remoteDir: remoteTarget,
    detail: (unpack.stdout || '').trim(),
  };
}

async function prepareRemoteUserLayer({ config = {}, userId = '', mbp = '', prepared = null, log }) {
  const preparedState = prepared || await prepareRemoteMbpArtifacts({ config, userId, mbp, log });
  if (!preparedState.ok) {
    return { ok: false, error: preparedState.error, step: preparedState.step, workspace: preparedState.workspace, sourceMbp: preparedState.sourceMbp };
  }

  const jobId = buildRecoverJobId(userId);
  const remoteSourceBase = preparedState.workspace.appRoot;
  const entries = [
    'shared_prefs',
    'files/keva',
    'files/TTMachineCoreCache',
    `files/${userId}`,
    'files/ColdBootFilePrefs',
    'databases',
  ];

  const verifyCmd = [
    'set -eu',
    `test -f ${shellQuote(path.posix.join(remoteSourceBase, 'shared_prefs', 'aweme_user.xml'))}`,
    `test -f ${shellQuote(path.posix.join(remoteSourceBase, 'shared_prefs', 'ttnetCookieStore.xml'))}`,
    `find ${shellQuote(path.posix.join(remoteSourceBase, 'files', 'keva', 'repo'))} -maxdepth 2 | sed -n '1,20p'`,
  ].join('; ');
  const verify = await runSshCmd(config, verifyCmd);
  if (!verify.ok) {
    return { ok: false, jobId, remoteSourceBase, workspace: preparedState.workspace, step: 'verify', error: (verify.stderr || verify.stdout || verify.error || 'verify failed').trim() };
  }

  return {
    ok: true,
    jobId,
    remoteSourceBase,
    sourceMbp: preparedState.sourceMbp,
    workspace: preparedState.workspace,
    entries,
    prepared: preparedState.detail || '',
    verify: (verify.stdout || '').trim(),
  };
}

async function runRemoteScript(config = {}, remoteScript = '', args = []) {
  if (!remoteScript) return { ok: false, error: 'missing remoteScript' };
  const argText = Array.isArray(args) && args.length ? ' ' + args.map((x) => shellQuote(String(x ?? ''))).join(' ') : '';
  return runSshCmd(config, `sh ${shellQuote(remoteScript)}${argText}`);
}



function resolveTargetUserdataPath(targetName = '') {
  const base = path.resolve(process.cwd(), 'tmp', 'targets', targetName || '');
  const meta = safeReadJson(path.join(base, 'meta.json'), {});
  return String(meta?.userdata || '').trim();
}

function getRecoverIdentityArgs(config = {}) {
  return [
    String(config?.recover?.baselineIdentity?.uid || ''),
    String(config?.recover?.userId || ''),
    String(config?.recover?.baselineIdentity?.username || ''),
    String(config?.recover?.detected?.username || ''),
    String(config?.recover?.baselineIdentity?.name || ''),
    String(config?.recover?.detected?.name || ''),
  ];
}

function firstExistingPath(paths = []) {
  for (const p of paths) {
    const v = String(p || '').trim();
    if (v && fs.existsSync(v)) return v;
  }
  return String(paths[0] || '').trim();
}

function resolveChecklistLocalPath(config = {}) {
  return firstExistingPath([
    config?.recover?.oldIdentityChecklist,
    path.resolve(process.cwd(), 'data', 'checklists', 'old-identity-checklist-v1.tsv'),
    path.resolve(process.cwd(), 'tmp', 'checklists', 'old-identity-checklist-v1.tsv'),
  ]);
}

function resolveChecklistRemotePath(config = {}) {
  const name = path.basename(resolveChecklistLocalPath(config) || 'old-identity-checklist-v1.tsv');
  return `/tmp/${name}`;
}

function resolveRecoverScriptLocalPath(name = '') {
  return firstExistingPath([
    path.resolve(process.cwd(), 'scripts', 'recover', name),
    path.resolve(process.cwd(), 'tmp', 'live-run', name),
  ]);
}

function validateRecoverRuntimeAssets(config = {}) {
  const required = [
    { kind: 'script', file: resolveRecoverScriptLocalPath('slot1_targeted_cleanup.sh') },
    { kind: 'script', file: resolveRecoverScriptLocalPath('slot1_inject_user_layer.sh') },
    { kind: 'script', file: resolveRecoverScriptLocalPath('slot1_precise_postinject_scan.sh') },
    { kind: 'checklist', file: resolveChecklistLocalPath(config) },
    { kind: 'proxy-mapping', file: resolveProxyMappingPath(config) },
  ];
  const missing = required.filter((x) => !x.file || !fs.existsSync(x.file));
  return { ok: missing.length === 0, required, missing };
}

async function ensureRemoteRecoverScripts({ config = {}, log }) {
  const mapping = [
    [resolveRecoverScriptLocalPath('slot1_targeted_cleanup.sh'), '/tmp/slot1_targeted_cleanup.sh', 'slot1_targeted_cleanup.sh'],
    [resolveRecoverScriptLocalPath('slot1_inject_user_layer.sh'), '/tmp/slot1_inject_user_layer.sh', 'slot1_inject_user_layer.sh'],
    [resolveRecoverScriptLocalPath('slot1_precise_postinject_scan.sh'), '/tmp/slot1_precise_postinject_scan.sh', 'slot1_precise_postinject_scan.sh'],
    [resolveChecklistLocalPath(config), resolveChecklistRemotePath(config), path.basename(resolveChecklistLocalPath(config) || 'old-identity-checklist-v1.tsv')],
  ];
  for (const [local, remote, name] of mapping) {
    if (!local || !fs.existsSync(local)) {
      return { ok: false, error: `运行依赖不存在: ${local || name}` };
    }
    log(`同步远端脚本：${name}`);
    const pushed = await scpToBox(config, local, remote);
    if (!pushed.ok) {
      return { ok: false, step: 'upload-script', error: (pushed.stderr || pushed.stdout || pushed.error || `scp failed: ${name}`).trim() };
    }
  }
  const chmodOut = await runSshCmd(config, 'chmod +x /tmp/slot1_targeted_cleanup.sh /tmp/slot1_inject_user_layer.sh /tmp/slot1_precise_postinject_scan.sh');
  if (!chmodOut.ok) {
    return { ok: false, step: 'chmod-script', error: (chmodOut.stderr || chmodOut.stdout || chmodOut.error || 'chmod failed').trim() };
  }
  return { ok: true, scripts: mapping.map((x) => x[1]) };
}

function parseKeyedCounts(stdout = '', keys = []) {
  const text = String(stdout || '');
  const out = {};
  for (const key of keys) {
    const m = text.match(new RegExp(`${key}=(-?` + String.raw`\d+` + `)`));
    out[key] = m ? Number(m[1]) : null;
  }
  return out;
}

function parseRewriteCounts(stdout = '') {
  return parseKeyedCounts(stdout, ['files', 'old_uid', 'old_username', 'old_name']);
}

function parseScanCounts(stdout = '') {
  return parseKeyedCounts(stdout, ['old_uid', 'old_username', 'old_name', 'new_uid', 'new_username', 'new_name']);
}

function printProbeSummary(report) {
  console.log('=== Probe Summary ===');
  console.log(`boxBase: ${report.boxBase}`);
  if (report.targetName) console.log(`targetName: ${report.targetName}`);
  if (report.target) {
    console.log(`targetStatus: ${report.target.status}`);
    console.log(`targetPorts(raw): adb=${report.target.adb || '-'} api=${report.target.api || '-'} rpa=${report.target.rpa || '-'}`);
  }
  if (report.instanceApiResolved) console.log(`instanceApiResolved: ${report.instanceApiResolved}`);
  if (report.rpaResolved) console.log(`rpaResolved: ${report.rpaResolved.host}:${report.rpaResolved.port}`);

  const infoRow = pickRow(report.rows, 'box-api', '/info');
  const deviceRow = pickRow(report.rows, 'box-api', '/info/device');
  const vpcRow = pickRow(report.rows, 'box-api', '/mytVpc/group');
  const apiRootRow = pickRow(report.rows, 'instance-api', '/');
  const apiProxyRow = pickRow(report.rows, 'instance-api', '/proxy');
  const rpaRow = report.rows.find((r) => r.kind === 'instance-rpa');
  const rpaMeta = parseRpaStdout(rpaRow?.stdout || '');

  console.log(`box /info: ${briefResult(infoRow)}`);
  console.log(`box /info/device: ${briefResult(deviceRow)}`);
  console.log(`box /mytVpc/group: ${briefResult(vpcRow)}`);
  console.log(`instance /: ${briefResult(apiRootRow)}`);
  console.log(`instance /proxy: ${briefResult(apiProxyRow)}`);
  console.log(`rpa: ${rpaRow ? (rpaMeta.connected ? 'OK' : 'FAIL') : 'N/A'}`);

  const proxyText = apiProxyRow?.result?.json?.data?.statusText || null;
  if (proxyText) console.log(`proxyStatus: ${proxyText}`);
  if (rpaMeta.model) console.log(`deviceModel: ${rpaMeta.model}`);
  console.log('=====================');
}

function filePathCheck(label, file) {
  if (!file) return { item: label, ok: false, note: '缺少参数' };
  if (!path.isAbsolute(file)) return { item: label, ok: false, note: '不是绝对路径' };
  if (fs.existsSync(file)) return { item: label, ok: true, note: '本机路径存在' };
  if (file.startsWith('/mmc/')) return { item: label, ok: true, note: '看起来是盒子路径（当前主机不校验存在性）' };
  return { item: label, ok: false, note: '当前主机不可见，且不像标准盒子路径' };
}

function summarizeChecks(checks) {
  const okCount = checks.filter((x) => x.ok).length;
  return { ok: checks.every((x) => x.ok), okCount, total: checks.length };
}

function buildRecoverPlan({ targetName, target, baseline, mbp, userId, overrides, dryRun }) {
  return [
    { step: 1, key: 'precheck', action: '预检', detail: `${targetName} / status=${target?.status || 'unknown'} | baseline=${baseline} | mbp=${mbp} | userId=${userId}`, dangerous: false },
    { step: 2, key: 'replace_baseline', action: '先停机再覆盖 baseline', detail: '先停机确认目标容器可写，再将基座彻底覆盖到指定容器，作为后续恢复底盘', dangerous: true },
    { step: 3, key: 'inject_device', action: '注入机参层', detail: '按 MBP/提取层写入 machine parameter files', dangerous: true },
    { step: 4, key: 'clean_old_identity', action: '清旧身份', detail: '旧 UID / username / name 第一轮清理与定点清理', dangerous: true },
    { step: 5, key: 'inject_user_layer', action: '注入用户层', detail: '执行用户层合并覆盖与必要替换', dangerous: true },
    { step: 6, key: 'precise_rescan', action: '按清单复验', detail: '若仍有残留，则回到第4步继续清理', dangerous: false },
    { step: 7, key: 'network_vpc', action: '配置 VPC', detail: '绑定并回读确认 VPC', dangerous: true },
    { step: 8, key: 'network_s5', action: '配置 S5', detail: '设置并回读确认 S5', dangerous: true },
    { step: 9, key: 'start_container', action: '启动容器', detail: '完成恢复写入后重新启动目标容器', dangerous: true },
    { step: 10, key: 'final_verify', action: '最终验证', detail: dryRun ? 'dry-run 模式只输出验证计划' : '输出本轮恢复结果与状态', dangerous: false },
  ];
}

function printRecoverPlanSummary(report) {
  console.log('=== Recover Dry Run ===');
  console.log(`target: ${report.targetName || '-'}`);
  console.log(`ready: ${report.precheck?.ok ? 'YES' : 'NO'} (${report.precheck?.okCount || 0}/${report.precheck?.total || 0})`);
  for (const step of report.plan) {
    console.log(`${step.step}. ${step.action}${step.dangerous ? ' [danger]' : ''}`);
    console.log(`   ${step.detail}`);
  }
  if (report.blockers?.length) {
    console.log('blockers:');
    for (const x of report.blockers) console.log(`- ${x}`);
  }
  console.log('=======================');
}

function printActionSummary(report) {
  console.log(`=== ${report.action.toUpperCase()} ===`);
  console.log(`target: ${report.targetName}`);
  console.log(`requestPath: ${report.requestPath}`);
  if (report.dryRun) {
    console.log('mode: dry-run');
  } else {
    console.log(`http: ${report.httpStatus ?? '-'}`);
    console.log(`success: ${report.success ? 'YES' : 'NO'}`);
  }
  if (report.message) console.log(`message: ${report.message}`);
  console.log('================');
}

async function runContainerAction({ boxBase, targetName, action, dryRun = false, jsonOutput = false }) {
  const pathMap = {
    start: '/android/start',
    stop: '/android/stop',
    restart: '/android/restart',
  };
  const requestPath = pathMap[action];
  const report = {
    time: new Date().toISOString(),
    mode: 'container-action',
    action,
    boxBase,
    targetName,
    requestPath,
    dryRun,
    success: false,
  };

  if (!targetName) {
    report.message = '缺少 --target-name';
    if (!jsonOutput) printActionSummary(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (dryRun) {
    report.success = true;
    report.message = `将向 ${requestPath} 发送 {\"name\":\"${targetName}\"}`;
    if (!jsonOutput) printActionSummary(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const result = await postJson(new URL(requestPath, boxBase).toString(), { name: targetName });
  report.result = result;
  report.httpStatus = result.status ?? null;

  const payload = result.json || {};
  const code = payload.code;
  report.success = result.ok && (code === 0 || code === 200 || code === undefined);
  report.message = payload.msg || payload.message || (report.success ? '请求已发送' : result.error || '请求失败');

  if (!jsonOutput) printActionSummary(report);
  console.log(JSON.stringify(report, null, 2));
}

function printStageStatus(report) {
  console.log('=== Stage Status ===');
  console.log(`target: ${report.targetName}`);
  if (!report.target) {
    console.log('status: NOT FOUND');
    return;
  }
  console.log(`containerStatus: ${report.target.status}`);
  console.log(`rawPorts: adb=${report.target.adb || '-'} api=${report.target.api || '-'} rpa=${report.target.rpa || '-'}`);
  console.log(`overrideApi: ${report.overrides?.instanceApi || '-'}`);
  console.log(`overrideRpa: ${report.overrides?.rpaHost || '-'}:${report.overrides?.rpaPort || '-'}`);
  console.log(`overrideAdb: ${report.overrides?.adbPort || '-'}`);
  console.log('====================');
}

function printSlots(slots) {
  console.log('=== Slots ===');
  for (const row of slots) {
    const running = row.running.map((x) => x.name).join(', ') || '-';
    const exited = row.exited.map((x) => x.name).join(', ') || '-';
    console.log(`slot=${row.slot} | running=${running} | exited=${exited}`);
  }
  console.log('============');
}

function printSlotStatus(report) {
  console.log('=== Slot Status ===');
  console.log(`slot: ${report.slot}`);
  if (!report.slotRow) {
    console.log('status: SLOT NOT FOUND');
    return;
  }
  console.log(`runningCount: ${report.slotRow.running.length}`);
  for (const x of report.slotRow.running) {
    console.log(`RUNNING | ${x.name} | api=${x.api || '-'} | rpa=${x.rpa || '-'} | ip=${x.ip || '-'}`);
  }
  for (const x of report.slotRow.exited) {
    console.log(`EXITED  | ${x.name} | api=${x.api || '-'} | rpa=${x.rpa || '-'} | ip=${x.ip || '-'}`);
  }
  console.log('===================');
}

function resolveRecoverMbpFromConfig(config, userId, explicitMbp = '') {
  if (explicitMbp) return explicitMbp;
  const users = Array.isArray(config?.recover?.detectedUsers) ? config.recover.detectedUsers : [];
  const hit = users.find((x) => String(x?.userId || x?.uid || '') === String(userId || '')) || null;
  return hit?.workingMbp || hit?.sourceMbp || config?.recover?.detected?.workingMbp || config?.recover?.detected?.recoverMbp || config?.recover?.detected?.sourceMbp || '';
}

async function buildPrecheckReport({ boxBase, targetName, config, baseline, mbp, userId }) {
  const discovered = await discoverInstances(boxBase);
  const resolvedMbp = resolveRecoverMbpFromConfig(config, userId, mbp);
  const report = {
    time: new Date().toISOString(),
    mode: 'recover-plan',
    boxBase,
    targetName,
    baseline: baseline || null,
    mbp: resolvedMbp || null,
    userId: userId || null,
    checks: [],
    rows: [],
    instanceApiResolved: null,
    rpaResolved: null,
  };

  report.rows.push(...await probeBase(boxBase));

  report.checks.push(filePathCheck('baseline', baseline));
  report.checks.push(resolvedMbp ? { item: 'mbp', ok: true, note: `已自动解析 ${resolvedMbp}` } : { item: 'mbp', ok: false, note: '未从 UID 检测结果解析到 MBP' });
  report.checks.push(userId ? { item: 'userId', ok: true, note: '已提供' } : { item: 'userId', ok: false, note: '缺少 --user-id' });
  report.discoveryOk = discovered.ok;

  if (!targetName) {
    report.checks.push({ item: 'targetName', ok: false, note: '缺少 --target-name' });
  }

  if (discovered.ok && targetName) {
    const target = discovered.list.find((x) => x.name === targetName);
    if (target) {
      report.target = target;
      report.overrides = resolveEndpointOverrides(config, targetName);
      report.checks.push({ item: 'targetExists', ok: true, note: `${target.name} (${target.status})` });
      report.checks.push({ item: 'targetState', ok: ['running', 'exited'].includes(target.status), note: `当前状态 ${target.status}` });

      const baseUrl = new URL(boxBase);
      let resolvedApi = report.overrides.instanceApi || null;
      let resolvedRpaHost = report.overrides.rpaHost || null;
      let resolvedRpaPort = report.overrides.rpaPort ? Number(report.overrides.rpaPort) : null;
      if (!resolvedApi && target.api) resolvedApi = withPort(baseUrl.toString(), target.api);
      if (!resolvedRpaHost && target.rpa) resolvedRpaHost = baseUrl.hostname;
      if (!resolvedRpaPort && target.rpa) resolvedRpaPort = Number(target.rpa);
      report.checks.push({ item: 'instanceApiRoute', ok: !!resolvedApi, note: resolvedApi || '未解析出实例 API 地址' });
      report.checks.push({ item: 'rpaRoute', ok: !!(resolvedRpaHost && resolvedRpaPort), note: resolvedRpaHost && resolvedRpaPort ? `${resolvedRpaHost}:${resolvedRpaPort}` : '未解析出 RPA 地址' });
      if (!resolvedApi && target.api) resolvedApi = withPort(baseUrl.toString(), target.api);
      if (!resolvedRpaHost && target.rpa) resolvedRpaHost = baseUrl.hostname;
      if (!resolvedRpaPort && target.rpa) resolvedRpaPort = Number(target.rpa);
      if (resolvedApi) {
        report.instanceApiResolved = resolvedApi;
        report.rows.push(...await probeInstanceApi(resolvedApi));
      }
      if (resolvedRpaHost && resolvedRpaPort) {
        report.rpaResolved = { host: resolvedRpaHost, port: resolvedRpaPort };
      }
    } else {
      report.checks.push({ item: 'targetExists', ok: false, note: `未找到目标实例 ${targetName}` });
    }
  }

  report.summary = summarizeChecks(report.checks);
  report.risks = [];
  if (report.target?.status === 'running') report.risks.push('目标实例当前为 running，后续真正恢复前必须先确认是否允许停机/覆盖');
  if (!report.overrides?.instanceApi || !report.overrides?.rpaHost || !report.overrides?.rpaPort) report.risks.push('当前实例缺少完整外部端口覆盖配置，后续自动化连通性可能不稳定');
  if (!baseline || !resolvedMbp || !userId) report.risks.push('恢复核心参数未齐，不能进入执行阶段');

  report.plan = [
    '1. 校验目标实例、baseline、UID，以及按 UID 自动解析出的 MBP 是否齐全',
    '2. 读取目标实例当前状态与端口覆盖配置',
    '3. 执行 baseline 覆盖前检查（状态、路径、授权）',
    '4. 执行机参层注入前检查',
    '5. 执行用户层注入前检查',
    '6. 执行精确残留扫描前检查',
    '7. 执行网络层（VPC/S5）配置检查',
  ];
  return report;
}

function groupSlots(list = []) {
  const slots = new Map();
  for (const item of list) {
    const slot = String(item.indexNum ?? 'unknown');
    if (!slots.has(slot)) slots.set(slot, { slot, running: [], exited: [], all: [] });
    const row = slots.get(slot);
    row.all.push(item);
    if (item.status === 'running') row.running.push(item);
    else row.exited.push(item);
  }
  return [...slots.values()].sort((a, b) => Number(a.slot) - Number(b.slot));
}

async function runList({ boxBase, jsonOutput }) {
  const discovered = await discoverInstances(boxBase);
  const report = { time: new Date().toISOString(), boxBase, discovered };
  if (!jsonOutput && discovered.ok) printTable(discovered.list);
  console.log(JSON.stringify(report, null, 2));
}

async function runSlots({ boxBase, jsonOutput }) {
  const discovered = await discoverInstances(boxBase);
  const slots = discovered.ok ? groupSlots(discovered.list) : [];
  const report = { time: new Date().toISOString(), mode: 'slots', boxBase, slots, discoveredOk: discovered.ok };
  if (!jsonOutput && discovered.ok) printSlots(slots);
  console.log(JSON.stringify(report, null, 2));
}

async function runSlotStatus({ boxBase, slot, jsonOutput }) {
  const discovered = await discoverInstances(boxBase);
  const slots = discovered.ok ? groupSlots(discovered.list) : [];
  const slotRow = slots.find((x) => x.slot === String(slot)) || null;
  const report = { time: new Date().toISOString(), mode: 'slot-status', boxBase, slot: String(slot), slotRow, discoveredOk: discovered.ok };
  if (!jsonOutput && discovered.ok) printSlotStatus(report);
  console.log(JSON.stringify(report, null, 2));
}

async function runStageStatus({ boxBase, targetName, config, jsonOutput }) {
  const discovered = await discoverInstances(boxBase);
  const report = { time: new Date().toISOString(), mode: 'stage-status', boxBase, targetName, target: null, overrides: null };
  if (discovered.ok && targetName) {
    report.target = discovered.list.find((x) => x.name === targetName) || null;
    report.overrides = resolveEndpointOverrides(config, targetName);
  }
  if (!jsonOutput) printStageStatus(report);
  console.log(JSON.stringify(report, null, 2));
}

async function runSlotSwitch({ boxBase, slot, targetName, dryRun = false, jsonOutput = false }) {
  const discovered = await discoverInstances(boxBase);
  const slots = discovered.ok ? groupSlots(discovered.list) : [];
  const slotRow = slots.find((x) => x.slot === String(slot)) || null;
  const report = {
    time: new Date().toISOString(),
    mode: 'slot-switch',
    boxBase,
    slot: String(slot),
    targetName,
    dryRun,
    success: false,
    steps: [],
  };

  if (!slot) {
    report.message = '缺少 --slot';
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!targetName) {
    report.message = '缺少 --target-name';
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!slotRow) {
    report.message = `未找到机位 ${slot}`;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const current = slotRow.running[0] || null;
  const target = slotRow.all.find((x) => x.name === targetName) || null;
  report.currentRunning = current?.name || null;
  report.slotContainers = slotRow.all.map((x) => ({ name: x.name, status: x.status }));

  if (!target) {
    report.message = `机位 ${slot} 下未找到目标容器 ${targetName}`;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (current?.name === targetName) {
    report.success = true;
    report.message = '目标容器已经在运行，无需切换';
    report.steps.push({ action: 'noop', ok: true, detail: targetName });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (current) report.steps.push({ action: 'stop-current', target: current.name, dryRun, ok: true });
  report.steps.push({ action: 'start-target', target: target.name, dryRun, ok: true });

  if (dryRun) {
    report.success = true;
    report.message = current
      ? `将先停止 ${current.name}，再启动 ${target.name}`
      : `机位 ${slot} 当前无 running，直接启动 ${target.name}`;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (current) {
    const stopResult = await postJson(new URL('/android/stop', boxBase).toString(), { name: current.name });
    report.steps[0].result = stopResult;
    report.steps[0].ok = stopResult.ok;
    if (!stopResult.ok) {
      report.message = `停止当前容器失败：${current.name}`;
      console.log(JSON.stringify(report, null, 2));
      return;
    }
  }

  const startResult = await postJson(new URL('/android/start', boxBase).toString(), { name: target.name });
  report.steps[report.steps.length - 1].result = startResult;
  report.steps[report.steps.length - 1].ok = startResult.ok;
  report.success = startResult.ok;
  report.message = startResult.ok ? `已请求切换到 ${target.name}` : `启动目标容器失败：${target.name}`;
  console.log(JSON.stringify(report, null, 2));
}

async function runProbe({ boxBase, instanceApi, rpaHost, rpaPort, targetName, sdkDir, config, jsonOutput }) {
  const report = {
    time: new Date().toISOString(),
    boxBase,
    targetName: targetName || null,
    instanceApi: instanceApi || null,
    rpa: rpaHost && rpaPort ? { host: rpaHost, port: rpaPort } : null,
    discovered: null,
    rows: [],
  };

  report.rows.push(...await probeBase(boxBase));

  const discovered = await discoverInstances(boxBase);
  report.discovered = discovered;

  let resolvedApi = instanceApi;
  let resolvedRpaHost = rpaHost;
  let resolvedRpaPort = rpaPort;

  if (discovered.ok && targetName) {
    const hit = discovered.list.find((x) => x.name === targetName);
    if (hit) {
      report.target = hit;
      const baseUrl = new URL(boxBase);
      const overrides = resolveEndpointOverrides(config, targetName);
      if (!resolvedApi && overrides.instanceApi) resolvedApi = overrides.instanceApi;
      if (!resolvedRpaHost && overrides.rpaHost) resolvedRpaHost = overrides.rpaHost;
      if (!resolvedRpaPort && overrides.rpaPort) resolvedRpaPort = Number(overrides.rpaPort);
      if (!resolvedApi && hit.api) resolvedApi = withPort(baseUrl.toString(), hit.api);
      if (!resolvedRpaHost && hit.rpa) resolvedRpaHost = baseUrl.hostname;
      if (!resolvedRpaPort && hit.rpa) resolvedRpaPort = Number(hit.rpa);
      report.overrides = overrides;
    }
  }

  if (resolvedApi) report.rows.push(...await probeInstanceApi(resolvedApi));
  if (resolvedRpaHost && resolvedRpaPort) {
    report.rows.push(await runPythonSdkProbe({ host: resolvedRpaHost, port: resolvedRpaPort, sdkDir }));
  }

  report.instanceApiResolved = resolvedApi || null;
  report.rpaResolved = resolvedRpaHost && resolvedRpaPort ? { host: resolvedRpaHost, port: resolvedRpaPort } : null;

  if (!jsonOutput) printProbeSummary(report);
  console.log(JSON.stringify(report, null, 2));
}

async function runRecoverPlan({ boxBase, targetName, config, baseline, mbp, userId }) {
  const report = await buildPrecheckReport({ boxBase, targetName, config, baseline, mbp, userId });
  console.log('=== Recover Plan / Precheck ===');
  console.log(`target: ${targetName || '-'}`);
  console.log(`precheck: ${report.summary.ok ? 'PASS' : 'NOT READY'} (${report.summary.okCount}/${report.summary.total})`);
  for (const check of report.checks) {
    console.log(`- [${check.ok ? 'OK' : 'NO'}] ${check.item}: ${check.note}`);
  }
  if (report.risks.length) {
    console.log('risks:');
    for (const risk of report.risks) console.log(`  - ${risk}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

async function runRecover({ boxBase, targetName, slot, config, baseline, mbp, userId, dryRun = true }) {
  const pre = await buildPrecheckReport({ boxBase, targetName, config, baseline, mbp, userId });
  mbp = pre.mbp || mbp;
  const report = {
    time: new Date().toISOString(),
    mode: 'recover',
    dryRun,
    targetName,
    precheck: pre.summary,
    blockers: [],
    target: pre.target || null,
    overrides: pre.overrides || null,
    steps: [],
  };

  const plan = buildRecoverPlan({
    targetName,
    target: pre.target,
    baseline,
    mbp,
    userId,
    overrides: pre.overrides,
    dryRun,
  });
  report.plan = plan;

  const emit = (event) => console.log(`@@RECOVER_EVENT@@${JSON.stringify({ time: new Date().toISOString(), ...event })}`);
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const setStage = async (stage, runner) => {
    emit({ type: 'stage', status: 'running', stage });
    try {
      const result = await runner();
      emit({ type: 'stage', status: 'done', stage, result });
      report.steps.push({ step: stage.step, key: stage.key, ok: true, detail: result?.detail || stage.detail, result });
      return { ok: true, result };
    } catch (err) {
      const error = String(err?.message || err || 'stage failed');
      emit({ type: 'stage', status: 'failed', stage, error });
      report.steps.push({ step: stage.step, key: stage.key, ok: false, detail: error });
      throw err;
    }
  };
  const log = (message, extra = {}) => emit({ type: 'log', level: 'info', message, ...extra });

  if (!pre.summary.ok) report.blockers.push('precheck 未通过，不能进入恢复执行');
  report.risks = [...(pre.risks || [])];

  const runtimeAssets = validateRecoverRuntimeAssets(config);
  if (!runtimeAssets.ok) {
    report.blockers.push(`recover 运行依赖缺失: ${runtimeAssets.missing.map((x) => x.file || x.kind).join(', ')}`);
  }

  emit({ type: 'job', status: 'started', dryRun, targetName, slot, userId, baseline, mbp, runtimeAssets });

  if (dryRun || report.blockers.length) {
    if (report.blockers.length) report.message = '前置检查未通过，当前仅返回计划';
    emit({ type: 'job', status: 'blocked', targetName, slot, userId, baseline, mbp, blockers: report.blockers, risks: report.risks || [], precheck: pre.summary, plan });
    printRecoverPlanSummary(report);
    console.log(JSON.stringify({ ...report, precheckReport: pre }, null, 2));
    return;
  }

  try {
    let preparedWorkspace = null;
    await setStage(plan[0], async () => {
      log('开始预检：校验目标、基座、用户、容器状态');
      return { detail: `预检通过 ${pre.summary.okCount}/${pre.summary.total}` };
    });

    await setStage(plan[1], async () => {
      log('子任务 2.1：确认目标容器状态');
      log(`子任务 2.2：准备停机 -> ${targetName}`);
      if (pre.target?.status === 'running') {
        log(`目标容器当前为 running，执行停机：${targetName}`);
        const stopResult = await postJson(new URL('/android/stop', boxBase).toString(), { name: targetName });
        if (!stopResult.ok) throw new Error(stopResult.error || '停止目标实例失败');
        log('子任务 2.3：停机完成，目标容器已进入可覆盖阶段');
      } else {
        log(`子任务 2.3：目标容器当前不是 running（${pre.target?.status || 'unknown'}），跳过停机`);
      }
      log('子任务 2.4：确认基座文件与目标镜像进入覆盖准备状态');
      const copyOut = await replaceBaselineOverSsh({ config, targetName, baseline, log });
      if (!copyOut.ok) {
        throw new Error(`baseline 覆盖失败: ${(copyOut.stderr || copyOut.stdout || copyOut.error || copyOut.detail || 'ssh copy failed').trim()}`);
      }
      const copyLog = `${copyOut.stdout || ''}`.trim();
      if (copyLog) log(`子任务 2.5：baseline 覆盖结果 -> ${copyLog.replace(/\s+/g, ' ').slice(0, 400)}`);
      return { detail: `baseline 已真实覆盖到 ${copyOut.userdata}` };
    });

    await setStage(plan[2], async () => {
      log('子任务 3.0：准备本次 recover 共用盒子工作目录（仅一次）');
      preparedWorkspace = await prepareRemoteMbpArtifacts({ config, userId, mbp, log });
      if (!preparedWorkspace?.ok) {
        throw new Error(`盒子工作目录准备失败: ${preparedWorkspace?.error || preparedWorkspace?.step || 'prepare failed'}`);
      }
      if (preparedWorkspace?.detail) {
        log(`子任务 3.0：盒子工作目录已就绪 -> ${preparedWorkspace.detail.replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      log('开始注入机参层：批量覆盖、关键字段校验');
      const injected = await injectDeviceFiles({ config, targetName, userId, mbp, prepared: preparedWorkspace, log });
      if (!injected.ok) {
        throw new Error(`机参层注入失败: ${injected.error || injected.step || 'inject device failed'}`);
      }
      return { detail: `机参层整组覆盖完成，共 ${injected.results.length} 个落点${injected.verify ? '，已输出关键字段回读' : ''}` };
    });

    const runCleanupStage = async (round = 1) => setStage(plan[3], async () => {
      const oldUid = config?.recover?.baselineIdentity?.uid || '';
      const oldUsername = config?.recover?.baselineIdentity?.username || '';
      const oldName = config?.recover?.baselineIdentity?.name || '';
      log(`子任务 4.${round}：加载基座旧身份 uid=${oldUid || '-'} username=${oldUsername || '-'} name=${oldName || '-'}`);
      const synced = await ensureRemoteRecoverScripts({ config, log });
      if (!synced.ok) {
        throw new Error(`恢复脚本同步失败: ${synced.error || synced.step || 'sync failed'}`);
      }
      log(`子任务 4.${round}：执行清旧脚本`);
      const resolved = await resolveUserdataImagePath(config, targetName, log);
      if (!resolved.ok || !resolved.userdata) {
        throw new Error(`未找到目标 userdata.img: ${targetName}`);
      }
      const cleanupArgs = [resolved.userdata, resolveChecklistRemotePath(config), ...getRecoverIdentityArgs(config)];
      const cleanupOut = await runRemoteScript(config, '/tmp/slot1_targeted_cleanup.sh', cleanupArgs);
      if (!cleanupOut.ok) {
        throw new Error(`清旧脚本失败: ${(cleanupOut.stderr || cleanupOut.stdout || cleanupOut.error || 'cleanup failed').trim()}`);
      }
      const cleanupLog = `${cleanupOut.stdout || ''}`.trim();
      const rewriteCounts = parseRewriteCounts(cleanupLog);
      if (cleanupLog) log(`子任务 4.${round}：清旧结果 -> ${cleanupLog.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (rewriteCounts.files !== null) {
        log(`子任务 4.${round}：替换计数 files=${rewriteCounts.files ?? '-'}, old_uid=${rewriteCounts.old_uid ?? '-'}, old_username=${rewriteCounts.old_username ?? '-'}, old_name=${rewriteCounts.old_name ?? '-'}`);
      }

      const strictVerifyArgs = [resolved.userdata, resolveChecklistRemotePath(config), String(config?.recover?.baselineIdentity?.uid || ''), String(config?.recover?.baselineIdentity?.username || ''), String(config?.recover?.baselineIdentity?.name || ''), String(config?.recover?.userId || ''), String(config?.recover?.detected?.username || ''), String(config?.recover?.detected?.name || '')];
      const strictVerifyOut = await runRemoteScript(config, '/tmp/slot1_precise_postinject_scan.sh', strictVerifyArgs);
      if (!strictVerifyOut.ok) {
        throw new Error(`清旧后严格复验失败: ${(strictVerifyOut.stderr || strictVerifyOut.stdout || strictVerifyOut.error || 'strict verify failed').trim()}`);
      }
      const strictCounts = parseScanCounts(strictVerifyOut.stdout || '');
      log(`子任务 4.${round}：严格复验 old_uid=${strictCounts.old_uid ?? '-'}, old_username=${strictCounts.old_username ?? '-'}, old_name=${strictCounts.old_name ?? '-'}, new_uid=${strictCounts.new_uid ?? '-'}, new_username=${strictCounts.new_username ?? '-'}, new_name=${strictCounts.new_name ?? '-'}`);
      return { detail: `旧身份清理脚本已执行（第 ${round} 轮）`, rewriteCounts, strictCounts };
    });

    const runInjectUserLayerStage = async () => setStage(plan[4], async () => {
      log('子任务 5.1：复用本次 recover 已准备好的盒子工作目录（不重复解包）');
      const prepared = await prepareRemoteUserLayer({ config, userId, mbp, prepared: preparedWorkspace, log });
      if (!prepared.ok) {
        throw new Error(`用户层准备失败: ${prepared.error || prepared.detail || prepared.step || 'prepare failed'}`);
      }
      if (prepared.prepared) log(`子任务 5.2：盒子解包完成 -> ${prepared.prepared.replace(/\s+/g, ' ').slice(0, 400)}`);
      log(`子任务 5.3：本轮用户层改为盒子内本地注入，不再从服务器回传碎文件 -> jobId=${prepared.jobId}`);
      if (prepared.verify) log(`子任务 5.4：关键文件校验通过 -> ${prepared.verify.replace(/\s+/g, ' ').slice(0, 400)}`);
      const resolved = await resolveUserdataImagePath(config, targetName, log);
      if (!resolved.ok || !resolved.userdata) {
        throw new Error(`未找到目标 userdata.img: ${targetName}`);
      }
      const injectArgs = [resolved.userdata, prepared.remoteSourceBase];
      const injectOut = await runRemoteScript(config, '/tmp/slot1_inject_user_layer.sh', injectArgs);
      if (!injectOut.ok) {
        throw new Error(`用户层注入脚本失败: ${(injectOut.stderr || injectOut.stdout || injectOut.error || 'inject failed').trim()}`);
      }
      const injectLog = `${injectOut.stdout || ''}`.trim();
      if (injectLog) log(`子任务 5.5：注入结果 -> ${injectLog.replace(/\s+/g, ' ').slice(0, 400)}`);
      return { detail: `用户层已改为盒子内解包 + 盒子内拷贝注入：jobId=${prepared.jobId}` };
    });

    const runPreciseRescanStage = async (round = 1) => setStage(plan[5], async () => {
      log(`子任务 6.${round}：执行按清单严格复验`);
      const resolved = await resolveUserdataImagePath(config, targetName, log);
      if (!resolved.ok || !resolved.userdata) {
        throw new Error(`未找到目标 userdata.img: ${targetName}`);
      }
      const scanArgs = [resolved.userdata, resolveChecklistRemotePath(config), String(config?.recover?.baselineIdentity?.uid || ''), String(config?.recover?.baselineIdentity?.username || ''), String(config?.recover?.baselineIdentity?.name || ''), String(config?.recover?.userId || ''), String(config?.recover?.detected?.username || ''), String(config?.recover?.detected?.name || '')];
      const scanOut = await runRemoteScript(config, '/tmp/slot1_precise_postinject_scan.sh', scanArgs);
      if (!scanOut.ok) {
        throw new Error(`按清单复验脚本失败: ${(scanOut.stderr || scanOut.stdout || scanOut.error || 'scan failed').trim()}`);
      }
      const counts = parseScanCounts(scanOut.stdout || '');
      log(`子任务 6.${round}：严格复验结果 old_uid=${counts.old_uid ?? '-'}, old_username=${counts.old_username ?? '-'}, old_name=${counts.old_name ?? '-'}, new_uid=${counts.new_uid ?? '-'}, new_username=${counts.new_username ?? '-'}, new_name=${counts.new_name ?? '-'}`);
      const scanLog = `${scanOut.stdout || ''}`.trim();
      if (scanLog) log(`子任务 6.${round}：严格复验明细 -> ${scanLog.replace(/\s+/g, ' ').slice(0, 500)}`);
      return {
        detail: `按清单复验完成 old_uid=${counts.old_uid ?? '-'}, old_username=${counts.old_username ?? '-'}, old_name=${counts.old_name ?? '-'}`,
        counts,
      };
    });

    await runCleanupStage(1);
    await runInjectUserLayerStage();
    const maxCleanupRounds = Number(config?.recover?.maxCleanupRounds || 5);
    let cleanupRound = 1;
    let finalScanCounts = null;
    while (true) {
      const scanStage = await runPreciseRescanStage(cleanupRound);
      const counts = scanStage?.result?.counts || {};
      finalScanCounts = counts;
      const oldUidLeft = Number(counts.old_uid || 0);
      const oldUsernameLeft = Number(counts.old_username || 0);
      const oldNameLeft = Number(counts.old_name || 0);
      if (!oldUidLeft && !oldUsernameLeft) {
        log(`子任务 6.${cleanupRound}：旧 uid / username 已归零，进入网络层（old_name=${oldNameLeft} 仅展示不阻塞）`);
        break;
      }
      if (cleanupRound >= maxCleanupRounds) {
        throw new Error(`按清单复验后仍有旧身份残留：old_uid=${oldUidLeft}, old_username=${oldUsernameLeft}, old_name=${oldNameLeft}；已达最大清理轮次 ${maxCleanupRounds}`);
      }
      emit({ type: 'flow', action: 'jump', fromStep: 6, toStep: 4, reason: `检测到旧身份残留，回到清旧身份（第 ${cleanupRound + 1} 轮）` });
      log(`子任务 6.${cleanupRound}：检测到旧残留，回退到第4步继续清旧（下一轮=${cleanupRound + 1}）`);
      cleanupRound += 1;
      await runCleanupStage(cleanupRound);
    }

    await setStage(plan[6], async () => {
      log('开始配置 VPC');
      const vpcRow = pickRow(pre.rows || [], 'box-api', '/mytVpc/group');
      if (!vpcRow?.result?.ok) {
        throw new Error(`VPC 阶段失败：盒子 /mytVpc/group 不可用 (${vpcRow?.result?.error || 'no response'})`);
      }
      const vpcID = resolveVpcId(config);
      const addRuleUrl = `${boxBase.replace(/\/$/, '')}/mytVpc/addRule`;
      const addRuleResp = await postJson(addRuleUrl, { name: targetName, vpcID });
      if (!addRuleResp?.ok || (addRuleResp?.json && addRuleResp.json.code !== 0)) {
        throw new Error(`VPC 阶段失败：addRule 失败 (${addRuleResp?.body || addRuleResp?.error || 'unknown error'})`);
      }
      const ruleUrl = `${boxBase.replace(/\/$/, '')}/mytVpc/containerRule?name=${encodeURIComponent(targetName)}`;
      const ruleResp = await requestJson(ruleUrl);
      if (!ruleResp?.ok || (ruleResp?.json && ruleResp.json.code !== 0)) {
        throw new Error(`VPC 阶段失败：containerRule 校验失败 (${ruleResp?.body || ruleResp?.error || 'unknown error'})`);
      }
      const matched = Array.isArray(ruleResp?.json?.data?.list)
        ? ruleResp.json.data.list.find((x) => x?.containerName === targetName)
        : null;
      if (!matched) {
        throw new Error(`VPC 阶段失败：未在 containerRule 中看到 ${targetName} 的规则`);
      }
      log(`VPC 阶段：已绑定 ${targetName} -> ${matched.groupName || '-'} (vpcID=${vpcID})`);
      return {
        detail: `VPC 已真实绑定并回读确认：${matched.groupName || '-'} (vpcID=${vpcID})`,
        check: { path: '/mytVpc/addRule', verifyPath: '/mytVpc/containerRule', vpcID, groupName: matched.groupName || null, vpcRemarks: matched.vpcRemarks || null },
      };
    });

    await setStage(plan[7], async () => {
      log('开始配置 S5：先检查容器是否已启动');
      let targetStatus = pre.target?.status || 'unknown';
      let resolvedInstanceApi = pre.instanceApiResolved || null;
      const currentDiscovery = await discoverInstances(boxBase);
      if (currentDiscovery.ok) {
        const currentTarget = currentDiscovery.list.find((x) => x.name === targetName) || null;
        if (currentTarget) {
          targetStatus = currentTarget.status || targetStatus;
          if (currentTarget.ip) {
            resolvedInstanceApi = resolveInstanceApiFromTarget(currentTarget, boxBase);
          }
          log(`S5 阶段：实时探测容器状态=${targetStatus}${resolvedInstanceApi ? `，instanceApi=${resolvedInstanceApi}` : ''}`);
        } else {
          log('S5 阶段：实时探测未找到目标容器，沿用前序状态');
        }
      } else {
        log(`S5 阶段：实时探测失败，沿用前序状态 (${currentDiscovery.error || 'unknown'})`);
      }
      if (targetStatus !== 'running') {
        log(`S5 阶段：目标容器当前为 ${targetStatus}，先启动容器 -> ${targetName}`);
        const startResult = await postJson(new URL('/android/start', boxBase).toString(), { name: targetName });
        if (!startResult.ok) throw new Error(startResult.error || '启动目标实例失败');
        const waited = await waitForContainerStatus({ boxBase, targetName, want: 'running', timeoutMs: 90000, intervalMs: 3000 });
        if (!waited.ok) {
          throw new Error(`S5 阶段失败：容器启动后未进入 running (${waited.error || 'unknown'})`);
        }
        targetStatus = waited.target?.status || 'running';
        log(`S5 阶段：容器已启动，当前状态=${targetStatus}`);
        const waitedApiPort = waited.target?.api || null;
        if (waited.target?.ip) {
          resolvedInstanceApi = `http://${waited.target.ip}:9082`;
          log(`S5 阶段：启动后重新解析实例 API -> ${resolvedInstanceApi}`);
        } else if (waitedApiPort) {
          log('S5 阶段：启动后仅拿到外部映射端口，先不采用，准备再探测一次');
        } else {
          log('S5 阶段：启动后实例 API 端口仍未出现在容器信息里，准备再探测一次');
          const rediscovered = await discoverInstances(boxBase);
          if (rediscovered.ok) {
            const refreshed = rediscovered.list.find((x) => x.name === targetName) || null;
            const refreshedApiPort = refreshed?.api || null;
            if (refreshed?.ip) {
              resolvedInstanceApi = `http://${refreshed.ip}:9082`;
              log(`S5 阶段：二次探测实例 API 成功 -> ${resolvedInstanceApi}`);
            } else if (refreshedApiPort) {
              log('S5 阶段：二次探测仍只有外部映射端口，继续等待内网 IP');
            }
          }
        }
      } else {
        log('S5 阶段：目标容器已是 running');
        if (!resolvedInstanceApi) {
          const rediscovered = await discoverInstances(boxBase);
          if (rediscovered.ok) {
            const refreshed = rediscovered.list.find((x) => x.name === targetName) || null;
            const refreshedApiPort = refreshed?.api || null;
            if (refreshed?.ip) {
              resolvedInstanceApi = `http://${refreshed.ip}:9082`;
              log(`S5 阶段：补充解析实例 API -> ${resolvedInstanceApi}`);
            } else if (refreshedApiPort) {
              log('S5 阶段：补充探测仅拿到外部映射端口，继续使用空值等待后续解析');
            }
          }
        }
      }

      const detectedProxyIp = getNested(config, ['recover', 'detected', 'proxyIp'], null) || null;
      if (!detectedProxyIp) {
        throw new Error('S5 阶段失败：未从 detect/MBP 中解析出外网代理 IP');
      }
      const proxyMap = await lookupProxyMappingByIp({ config, ip: detectedProxyIp });
      if (!proxyMap.ok) {
        throw new Error(`S5 阶段失败：代理映射查找失败 (${proxyMap.error || 'unknown'})`);
      }
      const s5 = proxyMap.proxy;
      log(`S5 阶段：代理映射命中 ${detectedProxyIp} -> ${s5.ip}:${s5.port} user=${s5.user || '-'} type=${s5.type}`);
      if (!resolvedInstanceApi) {
        throw new Error('S5 阶段失败：未解析出实例 API 地址');
      }
      log(`S5 阶段：等待实例 /proxy 就绪 -> ${resolvedInstanceApi}`);
      const proxyReady = await waitForInstanceProxyReadyViaBox({ config, instanceApi: resolvedInstanceApi, timeoutMs: 90000, intervalMs: 3000 });
      if (!proxyReady.ok) {
        throw new Error(`S5 阶段失败：实例 /proxy 不可用 (${proxyReady?.result?.error || proxyReady.error || 'no response'})`);
      }
      const beforeQuery = 'cmd=1';
      const beforeState = await callInstanceProxyCmdViaBox({ config, instanceApi: resolvedInstanceApi, query: beforeQuery });
      log(`S5 阶段：写入前代理状态 http=${beforeState.status || '-'}${beforeState.body ? ` body=${beforeState.body}` : ''}`);
      const writeQuery = `cmd=2&type=${encodeURIComponent(String(s5.type || '2'))}&ip=${encodeURIComponent(String(s5.ip || ''))}&port=${encodeURIComponent(String(s5.port || ''))}&usr=${encodeURIComponent(String(s5.user || ''))}&pwd=${encodeURIComponent(String(s5.password || ''))}`;
      log(`S5 阶段：开始写入代理 -> ${s5.ip}:${s5.port} user=${s5.user || '-'} type=${s5.type}`);
      const writeState = await callInstanceProxyCmdViaBox({ config, instanceApi: resolvedInstanceApi, query: writeQuery });
      if (!writeState.ok) {
        throw new Error(`S5 阶段失败：代理写入调用失败 (http=${writeState.status || '-'} body=${writeState.body || writeState.stderr || '-'})`);
      }
      const appliedExpected = { ip: s5.ip, port: s5.port, type: s5.type, user: s5.user };
      await sleep(1000);
      let afterState = null;
      const retryStarted = Date.now();
      const retryTimeoutMs = 5000;
      let retryCount = 0;
      while (Date.now() - retryStarted <= retryTimeoutMs) {
        retryCount += 1;
        const current = await callInstanceProxyCmdViaBox({ config, instanceApi: resolvedInstanceApi, query: 'cmd=1' });
        afterState = current;
        if (current.ok && proxyReadbackMatches(current, appliedExpected)) {
          if (retryCount > 1) log(`S5 阶段：写入后回读在第 ${retryCount} 次恢复并匹配`);
          break;
        }
        if (!current.ok) {
          log(`S5 阶段：写入后回读第 ${retryCount} 次未恢复 (http=${current.status || '-'} body=${current.body || current.stderr || '-'})`);
        } else {
          log(`S5 阶段：写入后回读第 ${retryCount} 次未匹配，继续等待 (http=${current.status || '-'} body=${current.body || '-'})`);
        }
        if (Date.now() - retryStarted > retryTimeoutMs) break;
        await sleep(1000);
      }
      if (!afterState?.ok) {
        throw new Error(`S5 阶段失败：代理写入后回读失败 (http=${afterState?.status || '-'} body=${afterState?.body || afterState?.stderr || '-'})`);
      }
      if (!proxyReadbackMatches(afterState, appliedExpected)) {
        throw new Error(`S5 阶段失败：代理写入后回读不匹配 (http=${afterState.status || '-'} body=${afterState.body || afterState.stderr || '-'})`);
      }
      log(`S5 阶段：写入后代理状态 http=${afterState.status || '-'}${afterState.body ? ` body=${afterState.body}` : ''}`);
      return {
        detail: `S5 已按外网 IP=${detectedProxyIp} 从映射表反查并写入 ${s5.ip}:${s5.port}（type=${s5.type}）`,
        check: {
          path: '/proxy?cmd=2',
          instanceApi: resolvedInstanceApi,
          detectedProxyIp,
          mappingFile: proxyMap.proxy.mappingFile,
          applied: { ip: s5.ip, port: s5.port, user: s5.user, type: s5.type },
          before: { httpStatus: beforeState.status, body: beforeState.body },
          write: { httpStatus: writeState.status, body: writeState.body },
          after: { httpStatus: afterState.status, body: afterState.body },
        },
      };
    });

    await setStage(plan[8], async () => {
      log(`启动容器阶段：目标容器当前已用于 S5，跳过重复启动 -> ${targetName}`);
      return { detail: '容器已在 S5 前置阶段启动或已处于 running，跳过重复启动' };
    });

    await setStage(plan[9], async () => {
      log('开始最终验证');
      const counts = finalScanCounts || {};
      const oldUidLeft = Number(counts.old_uid || 0);
      const oldUsernameLeft = Number(counts.old_username || 0);
      const oldNameLeft = Number(counts.old_name || 0);
      if (!finalScanCounts) {
        throw new Error('最终验证失败：缺少第6步按清单复验结果');
      }
      if (oldUidLeft || oldUsernameLeft) {
        throw new Error(`最终验证失败：旧 uid/username 仍未归零 old_uid=${oldUidLeft}, old_username=${oldUsernameLeft}, old_name=${oldNameLeft}`);
      }
      return {
        detail: `最终验证通过：旧 uid/username 已归零（old_name=${oldNameLeft} 仅展示，轮次=${cleanupRound}）`,
        counts,
      };
    });

    report.message = '恢复任务阶段流已跑通（S5 已接入映射表自动反查 + 真实写入 + 回读校验）';
    emit({ type: 'job', status: 'done', targetName, slot, userId, baseline, mbp, message: report.message });
    log(`任务完成：${report.message}`);
  } catch (err) {
    report.message = String(err?.message || err || '恢复失败');
    emit({ type: 'job', status: 'failed', targetName, slot, userId, baseline, mbp, message: report.message });
    log(`任务失败：${report.message}`);
  } finally {
    await cleanupRemoteRecoverWorkspace({ config, userId, log });
  }
}

async function main() {
  const mode = process.argv[2] || 'probe';
  const configPath = pickArg('config', process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json'));
  const config = getConfig(configPath);
  const connectionId = pickArg('connection-id', config?.recover?.connectionId || '');
  if (connectionId) {
    if (!config.recover || typeof config.recover !== 'object') config.recover = {};
    if (!config.ssh || typeof config.ssh !== 'object') config.ssh = {};
    config.recover.connectionId = connectionId;
    config.ssh.activeConnectionId = connectionId;
  }
  // 注意：只设置 activeConnectionId 不会自动更新 config.boxBase；
  // 这里显式 applyActiveConnection，确保 boxBase/ssh 参数来自所选 connection。
  const applied = applyActiveConnection(config);
  const boxBase = process.env.MYT_BASE || pickArg('base', applied.boxBase || config.boxBase || 'http://127.0.0.1:30201');
  const instanceApi = process.env.MYT_INSTANCE_API || pickArg('instance-api', '');
  const rpaHost = process.env.MYT_RPA_HOST || pickArg('rpa-host', '');
  const rpaPort = Number(process.env.MYT_RPA_PORT || pickArg('rpa-port', '0'));
  const targetName = process.env.MYT_TARGET_NAME || pickArg('target-name', config?.recover?.targetName || '');
  const slot = process.env.MYT_SLOT || pickArg('slot', config?.recover?.slot || '');
  const baseline = pickArg('baseline', config?.recover?.baseline || '');
  const mbp = pickArg('mbp', config?.recover?.mbp || '');
  const userId = pickArg('user-id', config?.recover?.userId || '');
  const jsonOutput = hasFlag('json');
  const dryRun = hasFlag('dry-run');
  const sdkDir = process.env.MYT_RPA_SDK_DIR || pickArg(
    'sdk-dir',
    config.sdkDir || path.resolve('/root/.openclaw/workspace/tmp/myt-rpa-sdk/extracted/demo_py_x64'),
  );

  if (mode === 'list') {
    await runList({ boxBase, jsonOutput });
    return;
  }

  if (mode === 'slots') {
    await runSlots({ boxBase, jsonOutput });
    return;
  }

  if (mode === 'slot-status') {
    await runSlotStatus({ boxBase, slot, jsonOutput });
    return;
  }

  if (mode === 'slot-switch') {
    await runSlotSwitch({ boxBase, slot, targetName, dryRun, jsonOutput });
    return;
  }

  if (mode === 'stage-status') {
    await runStageStatus({ boxBase, targetName, config, jsonOutput });
    return;
  }

  if (mode === 'probe') {
    await runProbe({ boxBase, instanceApi, rpaHost, rpaPort, targetName, sdkDir, config, jsonOutput });
    return;
  }

  if (mode === 'start' || mode === 'stop' || mode === 'restart') {
    await runContainerAction({ boxBase, targetName, action: mode, dryRun, jsonOutput });
    return;
  }

  if (mode === 'recover-plan' || mode === 'precheck') {
    await runRecoverPlan({ boxBase, targetName, config, baseline, mbp, userId });
    return;
  }

  if (mode === 'recover') {
    await runRecover({ boxBase, targetName, slot, config, baseline, mbp, userId, dryRun: true });
    return;
  }

  if (mode === 'recover-dryrun') {
    await runRecover({ boxBase, targetName, slot, config, baseline, mbp, userId, dryRun: true });
    return;
  }

  if (mode === 'recover-run') {
    await runRecover({ boxBase, targetName, slot, config, baseline, mbp, userId, dryRun: false });
    return;
  }

  console.log('Usage:');
  console.log('  npm run list -- --config=./config.json');
  console.log('  npm run slots -- --config=./config.json');
  console.log('  npm run slot-status -- --config=./config.json --slot=1');
  console.log('  npm run slot-switch -- --config=./config.json --slot=1 --target-name=container [--dry-run]');
  console.log('  npm run stage-status -- --config=./config.json --target-name=container');
  console.log('  npm run probe -- --config=./config.json --target-name=container');
  console.log('  npm run start -- --config=./config.json --target-name=container [--dry-run]');
  console.log('  npm run stop -- --config=./config.json --target-name=container [--dry-run]');
  console.log('  npm run restart -- --config=./config.json --target-name=container [--dry-run]');
  console.log('  npm run recover-plan -- --config=./config.json --target-name=container --baseline=/path/userdata.img --mbp=/path/user.mbp --user-id=123');
  console.log('  npm run recover-dryrun -- --config=./config.json --target-name=container --baseline=/path/userdata.img --mbp=/path/user.mbp --user-id=123');
  console.log('  npm run recover-run -- --config=./config.json --target-name=container --baseline=/path/userdata.img --mbp=/path/user.mbp --user-id=123');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

