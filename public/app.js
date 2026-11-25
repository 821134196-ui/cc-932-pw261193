import {
  confirmStep as engineConfirmStep,
  createInitialState,
  createMidwayDisasterState,
  getView,
  unplugTemporaryPower as engineUnplug,
  updateCapacity as engineUpdateCapacity,
} from './engine.js';

const state = {
  view: null,
  busy: false,
  mode: 'server',
};

const PHASE_LABELS = {
  'replica.sync': '副本',
  'source.offline': '下线',
  'rack.mount': '上架',
  'power.on': '上电',
  'link.up': '链路',
  'service.resume': '验收',
};

const RESOURCE_LABELS = {
  power: '供电',
  rack: 'U 位',
  link: '链路',
  replica: '副本',
  source: '旧站',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmt(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits).replace(/\.0$/, '');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload.state ?? payload;
}

function showToast(message, tone = 'info') {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.className = `toast ${tone === 'error' ? 'error' : ''}`;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function renderPreservingFocus() {
  const active = document.activeElement;
  const focusDescriptor =
    active && typeof active.matches === 'function' && active.matches('input.capacity-input')
      ? {
          kind: active.dataset.capacityKind,
          id: active.dataset.resourceId,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;

  render();

  if (focusDescriptor) {
    const next = [...document.querySelectorAll('input.capacity-input')].find(
      (input) =>
        input.dataset.capacityKind === focusDescriptor.kind &&
        input.dataset.resourceId === focusDescriptor.id,
    );
    if (next) {
      next.focus();
      if (focusDescriptor.start !== null && focusDescriptor.end !== null) {
        try {
          next.setSelectionRange(focusDescriptor.start, focusDescriptor.end);
        } catch {
          // number inputs do not always support selection ranges
        }
      }
    }
  }
}

async function performMutate(path, options, successMessage, localAction) {
  state.busy = true;
  document.body.setAttribute('aria-busy', 'true');
  try {
    let view;
    if (state.mode === 'local') {
      view = localAction();
    } else {
      try {
        view = await api(path, options);
      } catch (error) {
        // 允许把项目交给任意静态服务器：API 不可达后切换到浏览器引擎。
        if (!error.status && /failed to fetch|networkerror|invalid url/i.test(error.message)) {
          state.mode = 'local';
          view = localAction();
          showToast('API 不可达，已切换为浏览器本地执行点', 'error');
        } else {
          throw error;
        }
      }
    }
    state.view = view;
    renderPreservingFocus();
    if (successMessage) showToast(successMessage);
    return view;
  } catch (error) {
    if (error.payload?.state) {
      state.view = error.payload.state;
      render();
    }
    showToast(error.message, 'error');
    throw error;
  } finally {
    state.busy = false;
    document.body.removeAttribute('aria-busy');
    // busy 期间的渲染仍会把主按钮标为 disabled；状态复位后必须再渲染一次。
    if (state.view) renderPreservingFocus();
  }
}

let operationTail = Promise.resolve();
function mutate(...args) {
  const result = operationTail.then(() => performMutate(...args));
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function renderStatus() {
  const el = document.querySelector('#status-banner');
  const v = state.view;
  if (!v) return;

  if (v.progress.allDone) {
    el.className = 'status-banner done';
    el.innerHTML = `
      <span class="status-dot"></span>
      <div>全部 ${v.progress.total} 个步骤已确认，机器迁移与验收完成。
        <small>所有资源账本和事件均保留在当前执行点。</small>
      </div>`;
    return;
  }

  if (v.plan.feasible) {
    el.className = 'status-banner feasible';
    el.innerHTML = `
      <span class="status-dot"></span>
      <div>剩余排程可行：求解器已从当前真实执行点补齐候选机柜、U 位、供电、链路和副本约束。
        <small>下一条可确认步骤：${escapeHtml(v.progress.nextStepId ?? '无')}</small>
      </div>`;
  } else {
    el.className = 'status-banner infeasible';
    el.innerHTML = `
      <span class="status-dot"></span>
      <div>计划不可行：发现 ${v.plan.conflicts.length} 组冲突资源组合，已保留全部已确认动作且不会回滚。
        <small>请在左侧修改容量，或在右侧查看无法同时满足的机器 / 链路组合。</small>
      </div>`;
  }
}

function renderKpis() {
  const v = state.view;
  document.querySelector('#kpi-progress').textContent = `${v.progress.completed} / ${v.progress.total}`;
  document.querySelector('#progress-bar').style.width = `${v.progress.percent}%`;

  const next = v.decoratedSteps.find((s) => !s.done);
  document.querySelector('#kpi-next').textContent = next ? next.title.replace(/^.*?·\s*/, '') : '已完成';
  document.querySelector('#kpi-next').title = next?.title ?? '';

  const conflictCount = v.plan.conflicts.length;
  document.querySelector('#kpi-conflicts').textContent = conflictCount;
  document.querySelector('#kpi-conflict-hint').textContent = conflictCount
    ? '存在阻断性资源组合'
    : '剩余排程可行';

  const feed = v.tempFeeds[0];
  const feedEl = document.querySelector('#kpi-feed');
  if (feed?.active) {
    feedEl.textContent = `${feed.id.toUpperCase()} 在线 · +${fmt(feed.kw)} kW`;
  } else {
    feedEl.textContent = `${feed?.id.toUpperCase() ?? 'TEMP'} 已拔除`;
  }

  const confirmNext = document.querySelector('#confirm-next');
  confirmNext.disabled = state.busy || !v.progress.nextStepId || !v.plan.feasible || v.progress.allDone;
  confirmNext.textContent = v.progress.allDone ? '搬迁已完成' : '确认并执行下一条';

  const unplug = document.querySelector('#unplug-temp-power');
  unplug.disabled = state.busy || !feed?.active;
  unplug.textContent = feed?.active ? `⚡ 拔掉临时电源 ${feed.id.toUpperCase()}` : `⚡ ${feed.id.toUpperCase()} 已拔除`;
}

function capacityInput({ kind, id, name, sub, value, unit, min = 0, step = 1, extra = '' }) {
  return `
    <label class="cap-row">
      <span class="cap-resource">
        <strong>${escapeHtml(name)} ${extra}</strong>
        <span>${escapeHtml(sub)}</span>
      </span>
      <span class="cap-input-wrap">
        <input
          class="capacity-input"
          type="number"
          inputmode="decimal"
          data-capacity-kind="${kind}"
          data-resource-id="${escapeHtml(id)}"
          value="${escapeHtml(value)}"
          min="${min}"
          step="${step}"
          aria-label="${escapeHtml(name)}容量，单位${unit}"
        />
        <span>${unit}</span>
      </span>
    </label>`;
}

function renderCapacities() {
  const v = state.view;
  const feedForDomain = (domainId) => v.tempFeeds.find((f) => f.domainId === domainId);

  const power = v.powerDomains
    .map((d) => {
      const feed = feedForDomain(d.id);
      const pill = feed
        ? `<span class="feed-pill ${feed.active ? 'active' : 'removed'}">${feed.active ? '临时 +' + fmt(feed.kw) : '临时已拔'}</span>`
        : '';
      return capacityInput({
        kind: 'power',
        id: d.id,
        name: d.name,
        sub: d.note,
        value: v.capacities.power[d.id],
        unit: 'kW',
        min: 0,
        step: 0.1,
        extra: pill,
      });
    })
    .join('');

  const racks = v.racks
    .map((r) =>
      capacityInput({
        kind: 'rackUnits',
        id: r.id,
        name: r.name,
        sub: `${r.id} · ${v.powerDomains.find((d) => d.id === r.powerDomainId)?.name ?? ''}`,
        value: v.capacities.rackUnits[r.id],
        unit: 'U',
        min: 1,
        step: 1,
      }),
    )
    .join('');

  const links = v.linkPools
    .map((p) =>
      capacityInput({
        kind: 'linkBandwidth',
        id: p.id,
        name: p.name,
        sub: `${v.links.filter((l) => l.poolId === p.id).length} 条链路共享`,
        value: v.capacities.linkBandwidth[p.id],
        unit: 'Gbps',
        min: 0,
        step: 0.5,
      }),
    )
    .join('');

  const replicas = v.replicaSets
    .map((r) =>
      capacityInput({
        kind: 'replicaMin',
        id: r.id,
        name: r.name,
        sub: `当前成员 ${r.machineIds.length} 个 · ${r.antiAffinityRack ? '机架反亲和' : '不强制反亲和'}`,
        value: v.capacities.replicaMin[r.id],
        unit: '份',
        min: 1,
        step: 1,
      }),
    )
    .join('');

  document.querySelector('#capacity-form').innerHTML = `
    <section>
      <div class="cap-group-title">⚡ 供电配额 <span class="tag">拔除 TP-7 会扣减 PDU-A 容量</span></div>
      ${power}
    </section>
    <section>
      <div class="cap-group-title">🗄️ 机柜 U 位</div>
      ${racks}
    </section>
    <section>
      <div class="cap-group-title">🔗 链路带宽池</div>
      ${links}
    </section>
    <section>
      <div class="cap-group-title">🗃️ 数据库副本策略</div>
      ${replicas}
    </section>`;
}

function renderRackMap() {
  const v = state.view;
  document.querySelector('#rack-map').innerHTML = v.racks
    .map((rack) => {
      const u = v.usage.rackUnits[rack.id];
      const machines = [...u.placements].sort((a, b) => a.startUnit - b.startUnit);
      const items = machines.length
        ? machines
            .map((p) => {
              const machine = v.machines.find((m) => m.id === p.machineId);
              const fixed = Boolean(v.placements[p.machineId]);
              const overflow = p.startUnit + p.u - 1 > u.capacity;
              return `
                <div class="rack-machine ${fixed ? 'fixed' : 'proposed'} ${overflow ? 'overflow' : ''}">
                  <span>${escapeHtml(machine?.name ?? p.machineId)} · ${fmt(machine?.powerKw, 1)}kW</span>
                  <span>U${p.startUnit}–${p.startUnit + p.u - 1}${fixed ? ' · 已固定' : ' · 建议'}</span>
                </div>`;
            })
            .join('')
        : '<div class="badge waiting">暂无分配</div>';
      return `
        <article class="rack-card">
          <div class="rack-head">
            <strong>${escapeHtml(rack.name)}</strong>
            <span>${u.peak}/${u.capacity}U</span>
          </div>
          <div class="rack-units">${items}</div>
        </article>`;
    })
    .join('');
}

function stepTitleById(id) {
  return state.view?.steps.find((s) => s.id === id)?.title ?? id;
}

function renderSteps() {
  const v = state.view;
  const list = document.querySelector('#step-list');
  list.innerHTML = v.decoratedSteps
    .map((step, index) => {
      const status = step.done ? 'done' : step.ready ? 'ready' : 'blocked';
      const resourceBadges = (step.resourceKinds ?? [])
        .map((kind) => `<span class="badge resource-${escapeHtml(kind)}">${RESOURCE_LABELS[kind] ?? kind}</span>`)
        .join('');
      const missing = step.missingRequires
        .map((id) => `<span class="badge waiting">等待：${escapeHtml(stepTitleById(id).replace(/^.*?·\s*/, ''))}</span>`)
        .join('');
      const choice = step.choice
        ? `<span class="badge choice">📍 ${escapeHtml(step.choice.label)}</span>`
        : '';
      const irreversible = step.irreversible ? '<span class="badge irreversible">不可逆检查点</span>' : '';

      let action;
      if (step.done) {
        action = '<span class="step-check" title="已确认并写入账本">✓ 已落账</span>';
      } else if (step.canConfirm) {
        action = `<button class="btn btn-primary btn-small confirm-step" type="button" data-step-id="${escapeHtml(step.id)}" aria-label="确认执行：${escapeHtml(step.title)}">确认执行</button>`;
      } else if (step.ready && !v.plan.feasible) {
        action = '<button class="btn btn-small" type="button" disabled>冲突未解除</button>';
      } else {
        action = '<button class="btn btn-small" type="button" disabled>前置未完成</button>';
      }

      return `
        <li class="step-row ${status}" data-step-id="${escapeHtml(step.id)}" data-status="${status}">
          <div class="step-index">${step.done ? '✓' : index + 1}</div>
          <div class="step-body">
            <div class="step-title-line">
              <h3 class="step-title">${escapeHtml(step.title)}</h3>
              <span class="badge">${PHASE_LABELS[step.kind] ?? step.kind}</span>
              ${irreversible}
              <span class="badge ${step.done ? 'done' : 'waiting'}">${step.done ? '已确认' : step.ready ? '可执行' : '等待前置'}</span>
            </div>
            <p class="step-desc">${escapeHtml(step.description)}</p>
            <div class="step-meta">
              ${choice}
              ${resourceBadges}
              ${missing}
            </div>
          </div>
          <div class="step-action">${action}</div>
        </li>`;
    })
    .join('');
}

function ratioBar(demand, capacity) {
  const ratio = capacity > 0 ? demand / capacity : Number.POSITIVE_INFINITY;
  const width = Number.isFinite(ratio) ? Math.min(100, ratio * 100) : 100;
  const cls = ratio > 1 + 1e-6 ? 'over' : ratio > 0.85 ? 'warn' : '';
  return `<div class="mini-bar"><i class="${cls}" style="width:${width}%"></i></div>`;
}

function renderConflicts() {
  const v = state.view;
  const panel = document.querySelector('#conflict-panel');
  if (v.plan.feasible) {
    panel.innerHTML = `
      <div class="empty-success">
        ✓ 未发现供电、U 位、链路或副本冲突；剩余排程可从当前执行点继续。
      </div>`;
    return;
  }

  panel.innerHTML = v.plan.conflicts
    .map((c) => {
      const chips = (c.combination ?? [])
        .map(
          (item) => `
            <li class="combo-chip">
              <b>${escapeHtml(item.label)}</b>
              ${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}
            </li>`,
        )
        .join('');
      const scopeLabel = c.scope === 'actual' ? '真实账本' : c.scope === 'analysis' ? '求解分析' : '排程峰值';
      const metric = c.unit
        ? `<div class="metric-line"><span>需求 / 容量</span><strong>${fmt(c.demand, c.unit === 'U' ? 0 : 1)} / ${fmt(c.capacity, c.unit === 'U' || c.unit.includes('份') ? 0 : 1)} ${escapeHtml(c.unit)}</strong></div>
           ${ratioBar(c.demand, c.capacity)}`
        : '';
      return `
        <article class="conflict-card ${c.kind === 'combination' ? 'kind-combination' : ''} scope-${escapeHtml(c.scope ?? 'planned')}" data-conflict-kind="${escapeHtml(c.kind)}" data-conflict-id="${escapeHtml(c.id)}">
          <div class="conflict-head">
            <h3>${escapeHtml(c.title)}</h3>
            <span class="scope-pill ${c.scope === 'analysis' ? 'analysis' : ''}">${scopeLabel}</span>
          </div>
          <p class="conflict-message">${escapeHtml(c.message)}</p>
          ${metric}
          <ul class="conflict-combination" aria-label="冲突资源组合">${chips}</ul>
          <p class="conflict-suggestion">🛠 ${escapeHtml(c.suggestion)}</p>
        </article>`;
    })
    .join('');
}

function usageBar(actual, peak, capacity) {
  return ratioBar(peak, capacity).replace('mini-bar', 'usage-bar');
}

function renderUsage() {
  const v = state.view;
  const power = v.powerDomains
    .map((d) => {
      const u = v.usage.power[d.id];
      return `
        <div class="usage-block">
          <div class="usage-block-head"><span>⚡ ${escapeHtml(d.name)}</span><span>${fmt(u.peak)}/${fmt(u.capacity)} kW</span></div>
          ${usageBar(u.actual, u.peak, u.capacity)}
          <div class="usage-legend"><span>实际已上电 ${fmt(u.actual)} kW</span><span>排程峰值 ${fmt(u.peak)} kW</span></div>
        </div>`;
    })
    .join('');

  const racks = v.racks
    .map((r) => {
      const u = v.usage.rackUnits[r.id];
      return `
        <div class="usage-block">
          <div class="usage-block-head"><span>🗄 ${escapeHtml(r.name)}</span><span>${u.peak}/${u.capacity} U</span></div>
          ${usageBar(u.actual, u.peak, u.capacity)}
          <div class="usage-legend"><span>已固定 ${u.actual}U</span><span>最终占用 ${u.peak}U</span></div>
        </div>`;
    })
    .join('');

  const links = v.linkPools
    .map((p) => {
      const u = v.usage.linkBandwidth[p.id];
      return `
        <div class="usage-block">
          <div class="usage-block-head"><span>🔗 ${escapeHtml(p.name)}</span><span>${fmt(u.peak)}/${fmt(u.capacity)} Gbps</span></div>
          ${usageBar(u.actual, u.peak, u.capacity)}
          <div class="usage-legend"><span>已开通 ${fmt(u.actual)}</span><span>全部链路 ${fmt(u.peak)} Gbps</span></div>
        </div>`;
    })
    .join('');

  document.querySelector('#usage-panel').innerHTML = power + racks + links;
}

function renderEvents() {
  const v = state.view;
  document.querySelector('#event-log').innerHTML = [...v.events]
    .reverse()
    .map(
      (e) => `
      <article class="event-item ${escapeHtml(e.tone ?? 'info')}">
        <div class="event-title">${escapeHtml(e.title)}</div>
        <div class="event-message">${escapeHtml(e.message)}</div>
        <div class="event-time">#${e.seq} · ${new Date(e.at).toLocaleString('zh-CN', { hour12: false })}</div>
      </article>`,
    )
    .join('');
}

function render() {
  if (!state.view) return;
  renderStatus();
  renderKpis();
  renderCapacities();
  renderRackMap();
  renderSteps();
  renderConflicts();
  renderUsage();
  renderEvents();
}

let capacityInputTimer = null;
let lastCapacitySubmitKey = '';

async function submitCapacityInput(input) {
  if (!input) return;
  const { capacityKind, resourceId } = input.dataset;
  const rawValue = input.value;
  if (rawValue === '') return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return;

  const currentValue = state.view?.capacities?.[capacityKind]?.[resourceId];
  const submitKey = `${capacityKind}:${resourceId}:${value}`;
  if (Number(currentValue) === value || lastCapacitySubmitKey === submitKey) return;

  lastCapacitySubmitKey = submitKey;
  try {
    await mutate(
      '/api/capacities',
      {
        method: 'PATCH',
        body: JSON.stringify({ kind: capacityKind, resourceId, value }),
      },
      '容量已更新，剩余排程已从当前执行点重算',
      () => engineUpdateCapacity(state.view, capacityKind, resourceId, value),
    );
  } catch {
    lastCapacitySubmitKey = '';
  }
}

document.querySelector('#capacity-form').addEventListener('input', (event) => {
  const input = event.target.closest('input.capacity-input');
  if (!input) return;
  clearTimeout(capacityInputTimer);
  capacityInputTimer = setTimeout(() => submitCapacityInput(input), 350);
});

document.querySelector('#capacity-form').addEventListener('change', (event) => {
  const input = event.target.closest('input.capacity-input');
  if (!input) return;
  clearTimeout(capacityInputTimer);
  submitCapacityInput(input);
});

document.querySelector('#capacity-form').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const input = event.target.closest('input.capacity-input');
  if (!input) return;
  clearTimeout(capacityInputTimer);
  submitCapacityInput(input);
});

document.querySelector('#step-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button.confirm-step');
  if (!button || button.disabled) return;
  const stepId = button.dataset.stepId;
  await mutate(
    `/api/steps/${encodeURIComponent(stepId)}/confirm`,
    { method: 'POST' },
    '步骤已确认并写入真实执行点',
    () => engineConfirmStep(state.view, stepId),
  );
});

document.querySelector('#confirm-next').addEventListener('click', async () => {
  const stepId = state.view?.progress.nextStepId;
  if (!stepId) return;
  await mutate(
    `/api/steps/${encodeURIComponent(stepId)}/confirm`,
    { method: 'POST' },
    '下一条步骤已确认',
    () => engineConfirmStep(state.view, stepId),
  );
});

document.querySelector('#unplug-temp-power').addEventListener('click', async () => {
  await mutate(
    '/api/power/unplug-temp',
    { method: 'POST', body: '{}' },
    '临时电源已拔除，排程已从真实断点重算',
    () => engineUnplug(state.view),
  );
});

document.querySelector('#reset-demo').addEventListener('click', async () => {
  lastCapacitySubmitKey = '';
  await mutate(
    '/api/reset',
    { method: 'POST', body: '{}' },
    '演练已重置到初始执行点',
    () => getView(createInitialState()),
  );
});

document.querySelector('#load-midway').addEventListener('click', async () => {
  lastCapacitySubmitKey = '';
  await mutate(
    '/api/demo/midway',
    { method: 'POST' },
    '已载入“完成关键上架后拔除 TP-7”的中途断点',
    () => getView(createMidwayDisasterState()),
  );
});

try {
  state.view = await api('/api/state');
  state.mode = 'server';
  render();
} catch (error) {
  state.mode = 'local';
  state.view = getView(createInitialState());
  render();
  showToast(`未连接后端 API（${error.message}），已启用浏览器内置引擎`, 'error');
}
