async function j(url, opts) { const r = await fetch(url, opts); return r.json(); }
const $ = (id) => document.getElementById(id);

let slotRows = [];
let currentRecoverJobId = '';
let recoverPollTimer = null;
const pageMeta = {
  machines: { title: '机位管理', desc: '查看机位、实例、运行状态并直接执行切换/启停。' },
  users: { title: '用户检索', desc: '输入 UID，检索 MBP 并提取账号与机参摘要。' },
  recover: { title: '恢复任务', desc: '按顺序选择：用户 → 基座 → 机位 → 容器，并检查是否匹配。' },
  settings: { title: '参数设置', desc: '配置盒子地址、SSH 连接、私钥、基座与运行参数。' },
};

function switchPage(page) {
  document.querySelectorAll('.menu-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $('pageTitle').textContent = pageMeta[page]?.title || 'MYT 恢复工具';
  $('pageDesc').textContent = pageMeta[page]?.desc || '';
}

function summarizeMessage(data) {
  return data?.parsed?.message || data?.error || '已返回，请看下方原始结果';
}

function showResult(title, data) {
  $('summary').textContent = title + '\n\n' + summarizeMessage(data);
  $('raw').textContent = JSON.stringify(data, null, 2);
}

function formatReadableTime(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${MM}-${DD} ${hh}:${mm}:${ss}`;
}

function prettifyLogText(text = '') {
  return String(text || '').replace(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]/g, (_, iso) => `[${formatReadableTime(iso)}]`);
}

function renderRecoverJob(job = null, logText = '') {
  if (!job) {
    $('recoverJobSummary').textContent = '尚未启动恢复任务';
    $('recoverStageList').textContent = '暂无阶段信息';
    $('recoverJobLog').textContent = '暂无日志';
    return;
  }
  $('recoverJobSummary').textContent = [
    `jobId: ${job.jobId || '-'}`,
    `状态: ${job.status || '-'}`,
    `当前阶段: ${job.currentStage || '-'}`,
    `目标容器: ${job.payload?.targetName || '-'}`,
    `目标用户: ${job.payload?.userId || '-'}`,
    `基座: ${job.payload?.baseline || '-'}`,
    `MBP: ${job.payload?.mbp || job.payload?.resolvedMbp || job.mbp || '-'}`,
  ].join('\n');
  const stageLines = Array.isArray(job.stages) && job.stages.length
    ? job.stages.map((x) => `${x.step || '-'} | ${x.label || x.key || '-'} | ${x.status || '-'} | ${x.detail || '-'}`)
    : ['暂无阶段信息'];
  $('recoverStageList').textContent = stageLines.join('\n');
  const mergedLogText = logText || (Array.isArray(job.logs) ? job.logs.join('\n') : '暂无日志');
  $('recoverJobLog').textContent = prettifyLogText(mergedLogText);
}

async function pollRecoverJob(jobId) {
  if (!jobId) return;
  currentRecoverJobId = jobId;
  if (recoverPollTimer) clearTimeout(recoverPollTimer);
  try {
    const [jobOut, logOut] = await Promise.all([
      j(`/api/recover/job?id=${encodeURIComponent(jobId)}`),
      j(`/api/recover/log?id=${encodeURIComponent(jobId)}`),
    ]);
    const job = jobOut?.job || null;
    const logText = logOut?.log || '';
    renderRecoverJob(job, logText);
    const logEl = $('recoverJobLog');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    if (job && !['done', 'failed', 'finished', 'stopped'].includes(job.status)) {
      recoverPollTimer = setTimeout(() => pollRecoverJob(jobId), 1000);
    } else if (recoverPollTimer) {
      clearTimeout(recoverPollTimer);
      recoverPollTimer = null;
    }
  } catch (err) {
    $('recoverJobLog').textContent = `日志轮询失败: ${err?.message || err}`;
  }
}

async function attachLatestRecoverJob() {
  try {
    const out = await j('/api/recover/latest');
    const job = out?.job || null;
    if (!job?.jobId) {
      renderRecoverJob(null);
      return;
    }
    renderRecoverJob(job, '正在读取最新日志...');
    pollRecoverJob(job.jobId);
  } catch {
    renderRecoverJob(null);
  }
}

function slotCard(row) {
  const running = row.running || [];
  const exited = row.exited || [];
  return `
    <div class="slot">
      <h3>机位 ${row.slot} <span class="tag">running ${running.length}</span></h3>
      <div class="muted">当前运行中的容器优先显示；可直接点按钮操作。</div>
      ${running.map(x => `
        <div class="container running">
          <div><strong>${x.name}</strong></div>
          <div class="muted">RUNNING | api=${x.api || '-'} | rpa=${x.rpa || '-'} | ip=${x.ip || '-'}</div>
          <div class="actions">
            <button class="secondary" data-mode="stop" data-target="${x.name}">停止</button>
            <button class="secondary" data-mode="restart" data-target="${x.name}">重启</button>
          </div>
        </div>
      `).join('')}
      ${exited.map(x => `
        <div class="container">
          <div><strong>${x.name}</strong></div>
          <div class="muted">EXITED | api=${x.api || '-'} | rpa=${x.rpa || '-'} | ip=${x.ip || '-'}</div>
          <div class="actions">
            <button class="secondary" data-mode="start" data-target="${x.name}">启动</button>
            <button class="warn" data-mode="slot-switch" data-slot="${row.slot}" data-target="${x.name}" data-dry-run="1">预演切换</button>
            <button class="danger" data-mode="slot-switch" data-slot="${row.slot}" data-target="${x.name}">执行切换</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function normalizeSlots(out) {
  return out?.parsed?.slots || out?.slots || out?.data?.slots || [];
}

function setSelectOptions(selectEl, options, preferredValue = '') {
  if (!selectEl) return;
  const html = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join('');
  selectEl.innerHTML = html || '<option value="">暂无可选项</option>';
  if (preferredValue && options.some(x => String(x.value) === String(preferredValue))) {
    selectEl.value = preferredValue;
  }
}

function getDetectedUsers(cfg = {}) {
  const list = Array.isArray(cfg?.recover?.detectedUsers) ? cfg.recover.detectedUsers : [];
  return list.filter(x => x && (x.userId || x.uid || x.username));
}

function getBaselineOptions(cfg = {}) {
  const list = Array.isArray(cfg?.recover?.baselineOptions) ? cfg.recover.baselineOptions : [];
  return list.map(x => String(x || '').trim()).filter(Boolean);
}

function upsertDetectedUser(cfg = {}, info = {}) {
  const list = getDetectedUsers(cfg);
  const key = String(info.userId || info.uid || '').trim();
  if (!key) return list;
  const next = list.filter(x => String(x.userId || x.uid || '').trim() !== key);
  next.unshift({
    userId: info.userId || key,
    uid: info.uid || '',
    username: info.username || '',
    nickname: info.nickname || '',
    name: info.name || '',
    model: info.model || '',
    proxyIp: info.proxyIp || '',
    sourceMbp: info.sourceMbp || '',
    workingMbp: info.workingMbp || '',
    extractRoot: info.extractRoot || '',
    detectedAt: new Date().toISOString(),
  });
  return next.slice(0, 50);
}

function fillDetectedUserSelectors(cfg = {}) {
  const users = getDetectedUsers(cfg);
  const preferred = cfg?.recover?.userId || '';
  setSelectOptions(
    $('recoverDetectedUser'),
    users.map((x) => ({
      value: x.userId || x.uid,
      label: `${x.userId || x.uid} | ${x.username || '-'} | ${x.nickname || '-'} | ${x.model || '-'} | ${x.proxyIp || '-'}`,
    })),
    preferred,
  );
}

function fillBaselineSelectors(cfg = {}) {
  const baselines = getBaselineOptions(cfg);
  setSelectOptions(
    $('recoverBaseline'),
    baselines.map((x) => ({ value: x, label: x })),
    cfg?.recover?.baseline || '',
  );
  $('baselineOptions').value = baselines.join('\n');
}

function baselineImageHint(baseline = '') {
  const s = String(baseline || '');
  const m = s.match(/(tkyds\/custom:[^\/\s]+)/i) || s.match(/(q\d+_all_\d{8,})/i);
  return m ? m[1] : '';
}

function containerImageValue(item = {}) {
  return String(item.image || item.imageName || item.imageTag || '').trim();
}

function updateRecoverMatchHint() {
  const baseline = $('recoverBaseline')?.value || '';
  const targetName = $('recoverTargetName')?.value || '';
  const slot = $('recoverSlot')?.value || '';
  const row = slotRows.find((x) => String(x.slot) === String(slot));
  const all = [...(row?.running || []), ...(row?.exited || [])];
  const hit = all.find((x) => String(x.name) === String(targetName));
  if (!baseline || !targetName || !hit) {
    $('recoverMatchHint').textContent = '匹配提示：请先选择基座和容器';
    return;
  }
  const baselineHint = baselineImageHint(baseline);
  const image = containerImageValue(hit);
  const ok = baselineHint && image && image.includes(baselineHint);
  $('recoverMatchHint').textContent = [
    `容器镜像: ${image || '-'}`,
    `基座特征: ${baselineHint || '-'}`,
    `匹配结论: ${ok ? '看起来匹配' : '未看出明确匹配，建议人工确认'}`,
  ].join('\n');
}

function refreshTargetOptions(preferredTarget = '') {
  const slot = $('recoverSlot')?.value || '';
  const row = slotRows.find((x) => String(x.slot) === String(slot));
  const items = [...(row?.running || []), ...(row?.exited || [])];
  setSelectOptions(
    $('recoverTargetName'),
    items.map((x) => ({ value: x.name, label: `${x.name} | ${x.status || '-'} | ${containerImageValue(x) || '-'}` })),
    preferredTarget,
  );
  $('recoverTargetMirror').value = $('recoverTargetName').value || '';
  updateRecoverMatchHint();
}

function fillSlotSelectors(preferredSlot = '', preferredTarget = '') {
  setSelectOptions(
    $('recoverSlot'),
    slotRows.map(x => ({ value: x.slot, label: `机位 ${x.slot}（running ${x.running?.length || 0}）` })),
    preferredSlot,
  );
  refreshTargetOptions(preferredTarget);
}

function renderSshSection(cfg = {}) {
  const active = cfg?.ssh?.activeConnection || null;
  $('sshConnId').value = active?.id || cfg?.ssh?.activeConnectionId || '';
  $('sshKeyConnectionId').value = active?.id || cfg?.ssh?.activeConnectionId || '';
  $('sshConnName').value = active?.name || '';
  $('sshHost').value = active?.sshHost || '';
  $('sshPort').value = active?.sshPort || 22;
  $('sshUser').value = active?.sshUser || 'root';
  $('sshConnBoxBase').value = active?.boxBase || '';
  $('sshConnBoxWorkRoot').value = active?.boxWorkRoot || '';

  $('sshSummary').textContent = active ? [
    `activeConnectionId: ${active.id || '-'}`,
    `name: ${active.name || '-'}`,
    `host: ${active.sshHost || '-'}`,
    `port: ${active.sshPort || '-'}`,
    `user: ${active.sshUser || '-'}`,
    `boxBase: ${active.boxBase || '-'}`,
    `boxWorkRoot: ${active.boxWorkRoot || '-'}`,
    `私钥: ${active.hasPrivateKey ? '已配置' : '未配置'}`,
  ].join('\n') : '暂无 SSH 连接';

  $('sshKeySummary').textContent = active ? [
    `connectionId: ${active.id || '-'}`,
    `私钥状态: ${active.hasPrivateKey ? '已配置' : '未配置'}`,
    `指纹: ${active.privateKeyFingerprint || '-'}`,
    `更新时间: ${active.updatedAt || '-'}`,
  ].join('\n') : '尚未配置私钥';
}

async function loadConfig() {
  const cfg = await j('/api/config');
  $('boxBase').value = cfg.boxBase || '';
  $('sdkDir').value = cfg.sdkDir || '';
  $('boxWorkRoot').value = cfg.recover?.boxWorkRoot || '';
  $('proxyMappingFile').value = cfg.recover?.proxyMappingFile || '';
  $('recoverUserId').value = cfg.recover?.userId || '';
  $('userDetectSummary').textContent = cfg.recover?.detectedSummary || '等待检索用户…';
  $('recoverTargetMirror').value = cfg.recover?.targetName || '';
  fillDetectedUserSelectors(cfg);
  fillBaselineSelectors(cfg);
  renderSshSection(cfg);
  updateRecoverMatchHint();
  $('configSummary').textContent = [
    `boxBase: ${cfg.boxBase || '-'}`,
    `sdkDir: ${cfg.sdkDir || '-'}`,
    `boxWorkRoot: ${cfg.recover?.boxWorkRoot || '-'}`,
    `proxyMappingFile: ${cfg.recover?.proxyMappingFile || '-'}`,
    `默认目标容器: ${cfg.recover?.targetName || '-'}`,
    `默认机位: ${cfg.recover?.slot || '-'}`,
    `默认基座: ${cfg.recover?.baseline || '-'}`,
    `成功检索用户数: ${getDetectedUsers(cfg).length}`,
    `可用基座数: ${getBaselineOptions(cfg).length}`,
    `activeConnectionId: ${cfg.ssh?.activeConnectionId || '-'}`,
    `运行配置: ${cfg.runtime?.configPath || '-'} | data=${cfg.runtime?.dataDir || '-'}`,
  ].join('\n');
  return cfg;
}

async function saveConfig() {
  const payload = {
    boxBase: $('boxBase').value.trim(),
    sdkDir: $('sdkDir').value.trim(),
    boxWorkRoot: $('boxWorkRoot').value.trim(),
    proxyMappingFile: $('proxyMappingFile').value.trim(),
    baselineOptions: $('baselineOptions').value
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean),
  };
  const out = await j('/api/settings/general', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadConfig();
  showResult('通用设置已保存', out);
}

async function saveSshConnection() {
  const payload = {
    id: $('sshConnId').value.trim(),
    name: $('sshConnName').value.trim(),
    sshHost: $('sshHost').value.trim(),
    sshPort: Number($('sshPort').value.trim() || 22),
    sshUser: $('sshUser').value.trim() || 'root',
    boxBase: $('sshConnBoxBase').value.trim(),
    boxWorkRoot: $('sshConnBoxWorkRoot').value.trim(),
    setActive: true,
  };
  const out = await j('/api/settings/ssh-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadConfig();
  showResult('SSH 连接已保存', out);
}

async function saveSshPrivateKey() {
  const payload = {
    connectionId: $('sshKeyConnectionId').value.trim() || $('sshConnId').value.trim(),
    privateKey: $('sshPrivateKey').value,
  };
  if (!payload.connectionId) {
    showResult('保存私钥失败', { error: '请先保存 SSH 连接，拿到 connectionId' });
    return;
  }
  if (!payload.privateKey.trim()) {
    showResult('保存私钥失败', { error: '请先粘贴私钥内容' });
    return;
  }
  const out = await j('/api/settings/ssh-private-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  $('sshPrivateKey').value = '';
  await loadConfig();
  showResult('SSH 私钥已保存', out);
}

function getRecoverPayload() {
  return {
    userId: $('recoverDetectedUser')?.value?.trim?.() || $('recoverUserId')?.value?.trim?.() || '',
    baseline: $('recoverBaseline')?.value?.trim?.() || '',
    slot: $('recoverSlot')?.value?.trim?.() || '',
    targetName: $('recoverTargetName')?.value?.trim?.() || '',
    mbp: '',
  };
}

async function saveRecoverConfig(extra = {}, opts = {}) {
  const cfg = await j('/api/config');
  cfg.recover = {
    ...(cfg.recover || {}),
    ...getRecoverPayload(),
    ...extra,
  };
  const out = await j('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!opts.silent) showResult('恢复配置已保存', out);
  await loadConfig();
  return out;
}

async function refreshSlots() {
  const out = await j('/api/slots');
  slotRows = normalizeSlots(out);
  $('slots').innerHTML = slotRows.map(slotCard).join('') || '<div class="muted">暂无机位数据。请先到“参数设置”确认 boxBase 是否指向盒子总控接口，而不是单实例接口。</div>';
  const cfg = await j('/api/config');
  fillSlotSelectors(cfg.recover?.slot || '', cfg.recover?.targetName || '');
  bindActions();
  showResult('机位已刷新', out);
}

async function detectUser() {
  const payload = {
    userId: $('recoverUserId').value.trim(),
  };
  if (!payload.userId) {
    showResult('用户检索', { error: '请先填写目标 UID' });
    return;
  }
  const btn = $('detectUser');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检索中...';
  $('userDetectSummary').textContent = `检索中……\n目标UID: ${payload.userId}\n正在自动定位 MBP、复制工作副本并拆包，请稍候`;
  $('raw').textContent = '';
  $('summary').textContent = '用户检索\n\n请求已发出，正在执行中……';

  try {
    const out = await j('/api/recover/detect-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const info = out?.parsed?.detected || out?.detected || null;
    const status = out?.parsed?.status || '';
    const cfg = await j('/api/config');

    if (!out.ok) {
      const msg = out?.parsed?.message || out?.error || '检索失败';
      $('userDetectSummary').textContent = `用户检索失败\n${msg}`;
      await saveRecoverConfig({ userId: payload.userId, detectedSummary: `用户检索失败\n${msg}`, detected: info || { userId: payload.userId } }, { silent: true });
    } else if (out.ok && status === 'source_only') {
      const msg = [
        `已定位到 MBP，但基础数据不足：${payload.userId}`,
        `可能原因：文件结构异常 / 版本不兼容`,
        `源MBP: ${info?.sourceMbp || '-'}`,
      ].join('\n');
      $('userDetectSummary').textContent = msg;
      await saveRecoverConfig({ userId: info?.userId || payload.userId, detectedSummary: msg, detected: info }, { silent: true });
    } else if (info) {
      const lines = [
        `目标UID: ${info.userId || '-'}`,
        `账号UID: ${info.uid || '-'}`,
        `用户名: ${info.username || '-'}`,
        `昵称: ${info.nickname || '-'}`,
        `姓名: ${info.name || '-'}`,
        `sec_uid: ${info.secUid ? info.secUid.slice(0, 18) + '...' : '-'}`,
        `外显机型: ${info.model || '-'} / ${info.brand || '-'}`,
        `出口IP: ${info.proxyIp || '-'}`,
        `地区: ${info.country || '-'} / ${info.region || '-'} / ${info.city || '-'}`,
        `运营商: ${info.carrier || '-'} (${info.mcc || '-'}-${info.mnc || '-'})`,
        `S5: ${info.s5Ip || '-'}:${info.s5Port || '-'} (type=${info.s5Type || '-'})`,
        `Android ID: ${info.androidId || '-'}`,
        `GMS机型: ${info.gmsModel || '-'} / ${info.gmsBrand || '-'}`,
        `源MBP: ${info.sourceMbp || '-'}`,
      ];
      cfg.recover = cfg.recover || {};
      cfg.recover.userId = info.userId || payload.userId;
      cfg.recover.detectedSummary = lines.join('\n');
      cfg.recover.detected = info;
      cfg.recover.detectedUsers = upsertDetectedUser(cfg, info);
      await j('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      $('userDetectSummary').textContent = lines.join('\n');
      await loadConfig();
    }
    showResult('用户检索完成', out);
  } catch (err) {
    const msg = `用户检索失败\n目标UID: ${payload.userId}\n${err?.message || err}`;
    $('userDetectSummary').textContent = msg;
    showResult('用户检索失败', { error: String(err?.message || err) });
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function callRecoverApi(action) {
  const payload = getRecoverPayload();
  if (!payload.userId) {
    showResult('恢复任务', { error: '请先选择用户' });
    return;
  }
  if (!payload.slot) {
    showResult('恢复任务', { error: '请先选择机位' });
    return;
  }
  if (!payload.targetName) {
    showResult('恢复任务', { error: '请先选择目标容器' });
    return;
  }
  if (!payload.baseline) {
    showResult('恢复任务', { error: '请先选择基座 baseline' });
    return;
  }
  const out = await j(`/api/recover/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const textMap = { precheck: '恢复预检完成', plan: '恢复计划生成完成', dryrun: 'Dry-Run 恢复完成', start: '开始恢复任务' };
  showResult(textMap[action] || '恢复任务完成', out);
  if (action === 'start' && out?.jobId) {
    renderRecoverJob(out.state || { jobId: out.jobId, status: 'running', payload }, '任务已启动，等待日志...');
    pollRecoverJob(out.jobId);
  }
}

async function doAction(mode, targetName, slot, dryRun) {
  const dangerous = !dryRun && (mode === 'stop' || mode === 'restart' || mode === 'start' || mode === 'slot-switch');
  if (dangerous) {
    const label = mode === 'slot-switch' ? `确认执行切换？\nslot=${slot}\n目标=${targetName}` : `确认执行 ${mode} ？\n目标=${targetName}`;
    if (!window.confirm(label)) return;
  }
  const out = await j('/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, targetName, slot, dryRun: !!dryRun }),
  });
  showResult(`操作完成：${mode}`, out);
  await refreshSlots();
}

function bindActions() {
  document.querySelectorAll('button[data-mode]').forEach((btn) => {
    btn.onclick = () => doAction(btn.dataset.mode, btn.dataset.target, btn.dataset.slot, btn.dataset.dryRun === '1');
  });
}

document.querySelectorAll('.menu-btn').forEach((btn) => {
  btn.onclick = () => switchPage(btn.dataset.page);
});

$('saveConfig').onclick = saveConfig;
$('saveSshConnection').onclick = saveSshConnection;
$('saveSshPrivateKey').onclick = saveSshPrivateKey;
$('saveRecoverConfig').onclick = () => saveRecoverConfig();
$('refreshSlots').onclick = refreshSlots;
$('detectUser').onclick = detectUser;
$('recoverAttachLatest').onclick = attachLatestRecoverJob;
$('recoverPrecheck').onclick = () => callRecoverApi('precheck');
$('recoverPlan').onclick = () => callRecoverApi('plan');
$('recoverDryRun').onclick = () => callRecoverApi('dryrun');

async function copyTextCompat(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', 'readonly');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('浏览器不支持自动复制');
}

$('recoverStart').onclick = async () => {
  if (!window.confirm('确认开始正式恢复？此操作会对目标容器执行真实写入。')) return;
  return callRecoverApi('start');
};
$('recoverStop').onclick = async () => {
  if (!window.confirm('确认停止当前恢复任务？')) return;
  if (recoverPollTimer) {
    clearTimeout(recoverPollTimer);
    recoverPollTimer = null;
  }
  const stoppingJobId = currentRecoverJobId || '';
  const out = await j('/api/recover/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: stoppingJobId }) });
  showResult('已请求停止恢复任务', out);
  if (stoppingJobId) {
    const latest = await j(`/api/recover/job?id=${encodeURIComponent(stoppingJobId)}`);
    renderRecoverJob(latest?.job || { jobId: stoppingJobId, status: 'stopped' }, $('recoverJobLog')?.textContent || '任务已停止');
  }
};
$('recoverCopyLog').onclick = async () => {
  const text = ($('recoverJobLog')?.textContent || '').trim();
  if (!text || text === '暂无日志') {
    showResult('当前没有可复制的日志');
    return;
  }
  try {
    await copyTextCompat(text);
    showResult('日志已复制到剪贴板');
  } catch (err) {
    showResult(`复制失败：${err?.message || err}`);
  }
};
$('recoverSlot').onchange = () => { refreshTargetOptions(); updateRecoverMatchHint(); saveRecoverConfig({}, { silent: true }); };
$('recoverTargetName').onchange = () => { $('recoverTargetMirror').value = $('recoverTargetName').value || ''; updateRecoverMatchHint(); saveRecoverConfig({}, { silent: true }); };
$('recoverDetectedUser').onchange = () => { updateRecoverMatchHint(); saveRecoverConfig({}, { silent: true }); };
$('recoverBaseline').onchange = () => { refreshTargetOptions($('recoverTargetName')?.value || ''); updateRecoverMatchHint(); saveRecoverConfig({}, { silent: true }); };

loadConfig().then(refreshSlots).then(attachLatestRecoverJob);
