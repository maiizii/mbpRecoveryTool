import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

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

function getConfig(configPath) {
  return loadJsonIfExists(configPath) || {};
}

function getNested(obj, keys, fallback = null) {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur;
}

function withPort(base, port) {
  const u = new URL(base);
  u.port = String(port);
  u.pathname = '/';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
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
    { step: 1, action: '读取并确认目标实例', detail: `${targetName} / status=${target?.status || 'unknown'}`, dangerous: false },
    { step: 2, action: '确认执行输入', detail: `baseline=${baseline} | mbp=${mbp} | userId=${userId}`, dangerous: false },
    { step: 3, action: '确认外部连通配置', detail: `instanceApi=${overrides?.instanceApi || '-'} | rpa=${overrides?.rpaHost || '-'}:${overrides?.rpaPort || '-'}`, dangerous: false },
    { step: 4, action: '停止目标实例（未来执行）', detail: '若实例为 running，恢复前必须先停机', dangerous: true },
    { step: 5, action: '覆盖 baseline（未来执行）', detail: '将 baseline userdata 应用到目标实例', dangerous: true },
    { step: 6, action: '注入机参层（未来执行）', detail: '按 MBP/提取层写入 machine parameter files', dangerous: true },
    { step: 7, action: '注入用户层（未来执行）', detail: '执行用户层合并、旧身份清理、新身份注入', dangerous: true },
    { step: 8, action: '执行精确重扫（未来执行）', detail: '确认旧 UID/用户名/昵称残留为 0', dangerous: false },
    { step: 9, action: '配置网络层（未来执行）', detail: '检查/设置 VPC + S5', dangerous: true },
    { step: 10, action: dryRun ? '仅输出计划，不执行写入' : '进入真实执行（尚未实现）', detail: dryRun ? 'dry-run 模式安全结束' : '当前版本未开放真实执行', dangerous: !dryRun },
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

async function buildPrecheckReport({ boxBase, targetName, config, baseline, mbp, userId }) {
  const discovered = await discoverInstances(boxBase);
  const report = {
    time: new Date().toISOString(),
    mode: 'recover-plan',
    boxBase,
    targetName,
    baseline: baseline || null,
    mbp: mbp || null,
    userId: userId || null,
    checks: [],
  };

  report.checks.push(filePathCheck('baseline', baseline));
  report.checks.push(filePathCheck('mbp', mbp));
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
      report.checks.push({ item: 'instanceApiOverride', ok: !!report.overrides.instanceApi, note: report.overrides.instanceApi || '缺少实例 API 覆盖' });
      report.checks.push({ item: 'rpaOverride', ok: !!(report.overrides.rpaHost && report.overrides.rpaPort), note: report.overrides.rpaHost && report.overrides.rpaPort ? `${report.overrides.rpaHost}:${report.overrides.rpaPort}` : '缺少 RPA 覆盖' });
    } else {
      report.checks.push({ item: 'targetExists', ok: false, note: `未找到目标实例 ${targetName}` });
    }
  }

  report.summary = summarizeChecks(report.checks);
  report.risks = [];
  if (report.target?.status === 'running') report.risks.push('目标实例当前为 running，后续真正恢复前必须先确认是否允许停机/覆盖');
  if (!report.overrides?.instanceApi || !report.overrides?.rpaHost || !report.overrides?.rpaPort) report.risks.push('当前实例缺少完整外部端口覆盖配置，后续自动化连通性可能不稳定');
  if (!baseline || !mbp || !userId) report.risks.push('恢复核心参数未齐，不能进入执行阶段');

  report.plan = [
    '1. 校验目标实例、baseline、MBP、userId 参数是否齐全',
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

async function runRecover({ boxBase, targetName, config, baseline, mbp, userId, dryRun = true }) {
  const pre = await buildPrecheckReport({ boxBase, targetName, config, baseline, mbp, userId });
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

  if (!pre.summary.ok) report.blockers.push('precheck 未通过，不能进入恢复执行');
  report.blockers.push(...(pre.risks || []));
  report.plan = buildRecoverPlan({
    targetName,
    target: pre.target,
    baseline,
    mbp,
    userId,
    overrides: pre.overrides,
    dryRun,
  });

  if (dryRun || report.blockers.length) {
    if (report.blockers.length) report.message = '前置检查未通过，当前仅返回计划';
    printRecoverPlanSummary(report);
    console.log(JSON.stringify({ ...report, precheckReport: pre }, null, 2));
    return;
  }

  const pushStep = (step, ok, detail, extra = {}) => {
    report.steps.push({ step: report.steps.length + 1, ok, detail, ...extra });
  };

  pushStep('确认目标实例', true, `${targetName || '-'} / ${pre.target?.status || 'unknown'}`);

  const stopResult = await postJson(new URL('/android/stop', boxBase).toString(), { name: targetName });
  pushStep('停止目标实例', !!stopResult.ok, stopResult.ok ? '已发送 stop 请求' : (stopResult.error || 'stop failed'), { result: stopResult });
  if (!stopResult.ok) {
    report.message = '停止目标实例失败';
    console.log(JSON.stringify({ ...report, precheckReport: pre }, null, 2));
    return;
  }

  pushStep('覆盖 baseline', true, `待接 SSH/shell 执行：${baseline || '-'}`);
  pushStep('注入机参层', true, `待接 SSH/shell 执行：${mbp || '-'}`);
  pushStep('注入用户层', true, `待接 SSH/shell 执行：${userId || '-'}`);
  pushStep('执行精确重扫', true, '待接 SSH/shell 执行');
  pushStep('配置网络层', true, '待接 VPC + S5 接口');

  const startResult = await postJson(new URL('/android/start', boxBase).toString(), { name: targetName });
  pushStep('启动目标实例', !!startResult.ok, startResult.ok ? '已发送 start 请求' : (startResult.error || 'start failed'), { result: startResult });

  report.message = startResult.ok ? '恢复主流程骨架已执行完成（写入步骤仍为占位）' : '启动目标实例失败';
  console.log(JSON.stringify({ ...report, precheckReport: pre }, null, 2));
}

async function main() {
  const mode = process.argv[2] || 'probe';
  const configPath = pickArg('config', path.resolve(process.cwd(), 'config.json'));
  const config = getConfig(configPath);
  const boxBase = process.env.MYT_BASE || pickArg('base', config.boxBase || 'http://127.0.0.1:30201');
  const instanceApi = process.env.MYT_INSTANCE_API || pickArg('instance-api', '');
  const rpaHost = process.env.MYT_RPA_HOST || pickArg('rpa-host', '');
  const rpaPort = Number(process.env.MYT_RPA_PORT || pickArg('rpa-port', '0'));
  const targetName = process.env.MYT_TARGET_NAME || pickArg('target-name', '');
  const slot = process.env.MYT_SLOT || pickArg('slot', '');
  const baseline = pickArg('baseline', '');
  const mbp = pickArg('mbp', '');
  const userId = pickArg('user-id', '');
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
    await runRecover({ boxBase, targetName, config, baseline, mbp, userId, dryRun: true });
    return;
  }

  if (mode === 'recover-dryrun') {
    await runRecover({ boxBase, targetName, config, baseline, mbp, userId, dryRun: true });
    return;
  }

  if (mode === 'recover-run') {
    await runRecover({ boxBase, targetName, config, baseline, mbp, userId, dryRun: false });
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

