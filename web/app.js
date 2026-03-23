async function j(url, opts) { const r = await fetch(url, opts); return r.json(); }
const $ = (id) => document.getElementById(id);

let slotRows = [];
const pageMeta = {
  machines: { title: '机位管理', desc: '查看机位、实例、运行状态并直接执行切换/启停。' },
  users: { title: '用户检索', desc: '输入 UID，检索 MBP 并提取账号与机参摘要。' },
  recover: { title: '恢复任务', desc: '选择基座和目标容器，执行预检、计划和 Dry-Run。' },
  settings: { title: '参数设置', desc: '配置盒子地址和后续恢复参数入口。' },
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
  const html = options.map((opt) => `<option value="${opt.value}">${opt.label}</option>`).join('');
  selectEl.innerHTML = html || '<option value="">暂无可选项</option>';
  if (preferredValue && options.some(x => x.value === preferredValue)) selectEl.value = preferredValue;
}

function refreshTargetOptions(preferredTarget = '') {
  const slot = $('recoverSlot').value;
  const row = slotRows.find(x => String(x.slot) === String(slot));
  const items = row ? row.all || [] : [];
  setSelectOptions(
    $('recoverTargetName'),
    items.map(x => ({ value: x.name, label: `${x.name} [${x.status}]` })),
    preferredTarget,
  );
  $('recoverTargetMirror').value = $('recoverTargetName').value || '';
}

function fillSlotSelectors(preferredSlot = '', preferredTarget = '') {
  setSelectOptions(
    $('recoverSlot'),
    slotRows.map(x => ({ value: x.slot, label: `机位 ${x.slot}（running ${x.running?.length || 0}）` })),
    preferredSlot,
  );
  refreshTargetOptions(preferredTarget);
}

async function loadConfig() {
  const cfg = await j('/api/config');
  $('boxBase').value = cfg.boxBase || '';
  $('recoverBaseline').value = cfg.recover?.baseline || '';
  $('recoverMbp').value = cfg.recover?.mbp || '';
  $('recoverUserId').value = cfg.recover?.userId || '';
  $('userDetectSummary').textContent = cfg.recover?.detectedSummary || '等待检索用户…';
  $('recoverTargetMirror').value = cfg.recover?.targetName || '';
  $('configSummary').textContent = [
    `boxBase: ${cfg.boxBase || '-'}`,
    `默认目标容器: ${cfg.recover?.targetName || '-'}`,
    `默认机位: ${cfg.recover?.slot || '-'}`,
    `SSH: ${cfg.ssh?.enabled ? '开启' : '关闭'}`,
  ].join('\n');
  return cfg;
}

async function saveConfig() {
  const cfg = await j('/api/config');
  cfg.boxBase = $('boxBase').value.trim();
  const out = await j('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
  showResult('配置已保存', out);
}

function getRecoverPayload() {
  return {
    slot: $('recoverSlot')?.value?.trim?.() || '',
    targetName: $('recoverTargetName')?.value?.trim?.() || '',
    userId: $('recoverUserId').value.trim(),
    baseline: $('recoverBaseline').value.trim(),
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
      $('userDetectSummary').textContent = lines.join('\n');
      await saveRecoverConfig({ userId: info.userId || payload.userId, detectedSummary: lines.join('\n'), detected: info }, { silent: true });
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
  if (!payload.targetName) {
    showResult('恢复任务', { error: '请先选择目标容器 targetName' });
    return;
  }
  const out = await j(`/api/recover/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const textMap = { precheck: '恢复预检完成', plan: '恢复计划生成完成', dryrun: 'Dry-Run 恢复完成', start: '开始恢复任务' };
  showResult(textMap[action] || '恢复任务完成', out);
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
$('saveRecoverConfig').onclick = () => saveRecoverConfig();
$('refreshSlots').onclick = refreshSlots;
$('detectUser').onclick = detectUser;
$('recoverPrecheck').onclick = () => callRecoverApi('precheck');
$('recoverPlan').onclick = () => callRecoverApi('plan');
$('recoverDryRun').onclick = () => callRecoverApi('dryrun');
$('recoverStart').onclick = () => callRecoverApi('start');
$('recoverSlot').onchange = () => refreshTargetOptions();
$('recoverTargetName').onchange = () => { $('recoverTargetMirror').value = $('recoverTargetName').value || ''; };

loadConfig().then(refreshSlots);
loadConfig().then(refreshSlots);
