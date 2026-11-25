// 纯领域引擎：资源建模、约束求解、真实执行点落账与断点后续排程。
// 该模块不依赖 DOM/Node API，可同时被 server.js、浏览器和 node:test 使用。

const EPS = 1e-6;

function round10(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function deepCopy(value) {
  return structuredClone(value);
}

function pushEvent(state, event) {
  state.eventSeq += 1;
  state.events.push({
    seq: state.eventSeq,
    at: new Date().toISOString(),
    irreversible: false,
    ...event,
  });
}

export class EngineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
  }
}

export function createInitialState() {
  const powerDomains = [
    { id: 'pdu-a', name: 'PDU-A · A 列头柜', permanentKw: 4.2, note: 'A 区机柜主供电' },
    { id: 'pdu-b', name: 'PDU-B · B 列头柜', permanentKw: 5.2, note: 'B 区机柜主供电' },
    { id: 'pdu-c', name: 'PDU-C · C 备用回路', permanentKw: 3.5, note: 'C 区短机柜回路' },
  ];

  const tempFeeds = [
    {
      id: 'tp-7',
      name: '临时电源 TP-7（电源车）',
      domainId: 'pdu-a',
      kw: 2.8,
      active: true,
      temporary: true,
    },
  ];

  const racks = [
    { id: 'r-a', name: 'A-01', units: 12, powerDomainId: 'pdu-a' },
    { id: 'r-b', name: 'B-01', units: 12, powerDomainId: 'pdu-b' },
    { id: 'r-c', name: 'C-01', units: 8, powerDomainId: 'pdu-c' },
  ];

  const machines = [
    {
      id: 'm-order-db',
      name: 'order-db-01',
      role: '订单库主节点',
      service: 'orders',
      u: 2,
      powerKw: 2.6,
      candidateRackIds: ['r-a', 'r-b'],
      replicaSetId: 'rs-order',
    },
    {
      id: 'm-ledger-db',
      name: 'ledger-db-01',
      role: '账务库主节点',
      service: 'ledger',
      u: 2,
      powerKw: 2.2,
      candidateRackIds: ['r-a', 'r-b'],
      replicaSetId: 'rs-ledger',
    },
    {
      id: 'm-order-rep',
      name: 'order-db-02',
      role: '订单库副本节点',
      service: 'orders',
      u: 2,
      powerKw: 1.7,
      candidateRackIds: ['r-b', 'r-c'],
      replicaSetId: 'rs-order',
    },
    {
      id: 'm-ledger-rep',
      name: 'ledger-db-02',
      role: '账务库副本节点',
      service: 'ledger',
      u: 2,
      powerKw: 1.5,
      candidateRackIds: ['r-b', 'r-c'],
      replicaSetId: 'rs-ledger',
    },
    {
      id: 'm-web-1',
      name: 'web-edge-01',
      role: 'Web/接入节点 01',
      service: 'edge',
      u: 1,
      powerKw: 0.9,
      candidateRackIds: ['r-a', 'r-b'],
    },
    {
      id: 'm-web-2',
      name: 'web-edge-02',
      role: 'Web/接入节点 02',
      service: 'edge',
      u: 1,
      powerKw: 0.8,
      candidateRackIds: ['r-a', 'r-c'],
    },
  ];

  const linkPools = [
    { id: 'lp-db', name: '数据库复制专网', capacityGbps: 6.0 },
    { id: 'lp-app', name: '业务访问互联带宽', capacityGbps: 8.0 },
  ];

  const links = [
    {
      id: 'l-order-repl',
      name: '订单库主从复制',
      fromMachineId: 'm-order-db',
      toMachineId: 'm-order-rep',
      poolId: 'lp-db',
      needGbps: 3.0,
    },
    {
      id: 'l-ledger-repl',
      name: '账务库主从复制',
      fromMachineId: 'm-ledger-db',
      toMachineId: 'm-ledger-rep',
      poolId: 'lp-db',
      needGbps: 2.5,
    },
    {
      id: 'l-web1-order',
      name: 'web-01 → 订单库',
      fromMachineId: 'm-web-1',
      toMachineId: 'm-order-db',
      poolId: 'lp-app',
      needGbps: 2.5,
    },
    {
      id: 'l-web2-order',
      name: 'web-02 → 订单库',
      fromMachineId: 'm-web-2',
      toMachineId: 'm-order-db',
      poolId: 'lp-app',
      needGbps: 2.5,
    },
    {
      id: 'l-web1-ledger',
      name: 'web-01 → 账务库',
      fromMachineId: 'm-web-1',
      toMachineId: 'm-ledger-db',
      poolId: 'lp-app',
      needGbps: 1.5,
    },
  ];

  const replicaSets = [
    {
      id: 'rs-order',
      name: '订单库 orders-db',
      minHealthy: 2,
      antiAffinityRack: true,
      machineIds: ['m-order-db', 'm-order-rep'],
    },
    {
      id: 'rs-ledger',
      name: '账务库 ledger-db',
      minHealthy: 2,
      antiAffinityRack: true,
      machineIds: ['m-ledger-db', 'm-ledger-rep'],
    },
  ];

  const capacities = {
    power: Object.fromEntries(
      powerDomains.map((d) => [
        d.id,
        round10(d.permanentKw + tempFeeds.filter((f) => f.active && f.domainId === d.id).reduce((s, f) => s + f.kw, 0)),
      ]),
    ),
    rackUnits: Object.fromEntries(racks.map((r) => [r.id, r.units])),
    linkBandwidth: Object.fromEntries(linkPools.map((p) => [p.id, p.capacityGbps])),
    replicaMin: Object.fromEntries(replicaSets.map((r) => [r.id, r.minHealthy])),
  };

  const state = {
    schemaVersion: 1,
    eventSeq: 0,
    powerDomains,
    tempFeeds,
    racks,
    machines,
    linkPools,
    links,
    replicaSets,
    capacities,
    steps: [],
    completedStepIds: [],
    placements: {},
    stepChoices: {},
    events: [],
  };

  state.steps = buildSteps(state);

  pushEvent(state, {
    kind: 'system',
    tone: 'info',
    title: '规划台已就绪',
    message: '初始容量与搬迁模型已载入；确认步骤后，资源账本和真实执行点会单向前进。',
  });

  return state;
}

function buildSteps(state) {
  const steps = [];
  let order = 0;
  const nextOrder = () => {
    order += 1;
    return order;
  };

  for (const rs of state.replicaSets) {
    steps.push({
      id: `replica:${rs.id}`,
      kind: 'replica.sync',
      phase: 10,
      order: nextOrder(),
      refId: rs.id,
      title: `同步并校验库中副本 · ${rs.name}`,
      description: '等待副本追平 binlog/WAL，并校验副本可读、可提升。该检查点完成后作为后续下线前提。',
      irreversible: false,
      requires: [],
      resourceKinds: ['replica'],
    });
  }

  for (const machine of state.machines) {
    const requiresOffline = machine.replicaSetId ? [`replica:${machine.replicaSetId}`] : [];
    steps.push({
      id: `offline:${machine.id}`,
      kind: 'source.offline',
      phase: 20,
      order: nextOrder(),
      machineId: machine.id,
      title: `旧机房安全下线 · ${machine.name}`,
      description: `排空流量、停服并切断旧机柜电源。此步骤是切换检查点，完成后不自动回滚。`,
      irreversible: true,
      requires: requiresOffline,
      resourceKinds: ['source'],
    });

    steps.push({
      id: `mount:${machine.id}`,
      kind: 'rack.mount',
      phase: 30,
      order: nextOrder(),
      machineId: machine.id,
      title: `上架并固定 · ${machine.name}`,
      description: `按求解器选择的机柜和连续 U 位导轨上架 ${machine.u}U；上架位置一旦确认即固定。`,
      irreversible: true,
      requires: [`offline:${machine.id}`],
      resourceKinds: ['rack'],
    });

    steps.push({
      id: `power:${machine.id}`,
      kind: 'power.on',
      phase: 40,
      order: nextOrder(),
      machineId: machine.id,
      title: `目标机柜上电 · ${machine.name}`,
      description: `接入对应 PDU 并上电，占用 ${machine.powerKw.toFixed(1)} kW 供电配额。`,
      irreversible: true,
      requires: [`mount:${machine.id}`],
      resourceKinds: ['power'],
    });

    steps.push({
      id: `resume:${machine.id}`,
      kind: 'service.resume',
      phase: 60,
      order: nextOrder(),
      machineId: machine.id,
      title: `链路验收并恢复服务 · ${machine.name}`,
      description: '检查全部相关链路、副本健康和业务探针后恢复流量。',
      irreversible: true,
      requires: [`power:${machine.id}`],
      resourceKinds: ['link', 'replica'],
    });
  }

  for (const link of state.links) {
    steps.push({
      id: `link:${link.id}`,
      kind: 'link.up',
      phase: 50,
      order: nextOrder(),
      linkId: link.id,
      title: `接通链路 · ${link.name}`,
      description: `布线、点亮端口并验证 ${link.needGbps.toFixed(1)} Gbps 带宽配额。`,
      irreversible: false,
      requires: [`power:${link.fromMachineId}`, `power:${link.toMachineId}`],
      resourceKinds: ['link'],
    });

    for (const machineId of [link.fromMachineId, link.toMachineId]) {
      const resume = steps.find((s) => s.id === `resume:${machineId}`);
      if (resume && !resume.requires.includes(`link:${link.id}`)) {
        resume.requires.push(`link:${link.id}`);
      }
    }
  }

  return steps;
}

function machineById(state, id) {
  return state.machines.find((m) => m.id === id);
}

function rackById(state, id) {
  return state.racks.find((r) => r.id === id);
}

function domainById(state, id) {
  return state.powerDomains.find((d) => d.id === id);
}

function placementLabel(state, placement, explicitMachineId = null) {
  if (!placement) return '位置未分配';
  const rack = rackById(state, placement.rackId);
  const machineId = explicitMachineId ?? placement.machineId;
  let machine = machineId ? machineById(state, machineId) : null;
  if (!machine) {
    machine = state.machines.find((candidate) => state.placements[candidate.id] === placement) ?? null;
  }
  const end = placement.startUnit + (machine?.u ?? 1) - 1;
  return `${rack?.name ?? placement.rackId} · U${placement.startUnit}–U${end}`;
}

function machineRef(state, id, extra = '') {
  const m = machineById(state, id);
  return {
    type: 'machine',
    id,
    label: m ? `${m.name}（${m.role}）` : id,
    detail: extra,
  };
}

function linkRef(state, id, extra = '') {
  const l = state.links.find((x) => x.id === id);
  return { type: 'link', id, label: l?.name ?? id, detail: extra };
}

function findFirstSlot(state, machine, rackId, tentative) {
  const capacity = state.capacities.rackUnits[rackId] ?? 0;
  const intervals = [];

  for (const [machineId, p] of Object.entries(state.placements)) {
    if (p.rackId !== rackId) continue;
    const m = machineById(state, machineId);
    intervals.push({ start: p.startUnit, end: p.startUnit + (m?.u ?? 1) - 1 });
  }
  for (const [machineId, p] of Object.entries(tentative)) {
    if (p.rackId !== rackId) continue;
    intervals.push({ start: p.startUnit, end: p.startUnit + (machineById(state, machineId)?.u ?? 1) - 1 });
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  let start = 1;
  for (const interval of intervals) {
    if (start + machine.u - 1 <= interval.start - 1) {
      return { rackId, startUnit: start, overflow: start + machine.u - 1 > capacity };
    }
    start = Math.max(start, interval.end + 1);
  }

  return { rackId, startUnit: start, overflow: start + machine.u - 1 > capacity };
}

function evaluateAssignment(state, assignment, activeIds, options = {}) {
  const enforceReplicaCount = options.enforceReplicaCount !== false;
  const placements = { ...state.placements, ...assignment };
  const active = new Set(activeIds);
  const conflicts = [];
  const scoreParts = [];

  // 机柜 U 位 / 上架位置
  for (const rack of state.racks) {
    const members = state.machines.filter(
      (m) => active.has(m.id) && placements[m.id]?.rackId === rack.id,
    );
    if (members.length === 0) continue;

    const demand = members.reduce((sum, m) => sum + m.u, 0);
    const capacity = state.capacities.rackUnits[rack.id] ?? 0;
    const maxEnd = Math.max(
      ...members.map((m) => {
        const p = placements[m.id];
        return p.startUnit + m.u - 1;
      }),
    );

    if (demand > capacity + EPS || maxEnd > capacity + EPS) {
      const excess = Math.max(demand - capacity, maxEnd - capacity);
      scoreParts.push(excess / Math.max(1, capacity));
      conflicts.push({
        id: `rack:${rack.id}`,
        kind: 'rack',
        scope: 'planned',
        resourceId: rack.id,
        resourceName: `机柜 ${rack.name}`,
        title: `上架位置冲突 · 机柜 ${rack.name}`,
        capacity,
        demand,
        unit: 'U',
        severity: 'blocking',
        combination: members.map((m) =>
          machineRef(state, m.id, `${m.u}U · ${placementLabel(state, placements[m.id], m.id)}`),
        ),
        message: `${demand}U 的机器组合无法放入容量 ${capacity}U 的 ${rack.name}。`,
        suggestion: '调大该机柜 U 容量，或将尚未上架的机器改派到其他机柜；已确认上架的机器不能自动挪柜。',
      });
    }
  }

  // 供电配额
  for (const domain of state.powerDomains) {
    const rackIds = new Set(state.racks.filter((r) => r.powerDomainId === domain.id).map((r) => r.id));
    const members = state.machines.filter(
      (m) => active.has(m.id) && rackIds.has(placements[m.id]?.rackId),
    );
    if (members.length === 0) continue;

    const demand = round10(members.reduce((sum, m) => sum + m.powerKw, 0));
    const capacity = state.capacities.power[domain.id] ?? 0;
    if (demand > capacity + EPS) {
      scoreParts.push((demand - capacity) / Math.max(0.1, capacity));
      conflicts.push({
        id: `power:${domain.id}`,
        kind: 'power',
        scope: 'planned',
        resourceId: domain.id,
        resourceName: domain.name,
        title: `供电配额冲突 · ${domain.name}`,
        capacity,
        demand,
        unit: 'kW',
        severity: 'blocking',
        combination: members.map((m) =>
          machineRef(state, m.id, `${m.powerKw.toFixed(1)} kW · ${placementLabel(state, placements[m.id], m.id)}`),
        ),
        message: `${demand.toFixed(1)} kW 的供电组合超过 ${capacity.toFixed(1)} kW 配额，缺口 ${(demand - capacity).toFixed(1)} kW。`,
        suggestion: '提高该 PDU 配额、恢复临时电源，或把尚未上架/上电的机器改派到其他供电域。',
      });
    }
  }

  // 链路带宽池
  for (const pool of state.linkPools) {
    const poolLinks = state.links.filter(
      (l) => l.poolId === pool.id && active.has(l.fromMachineId) && active.has(l.toMachineId),
    );
    if (poolLinks.length === 0) continue;

    const demand = round10(poolLinks.reduce((sum, l) => sum + l.needGbps, 0));
    const capacity = state.capacities.linkBandwidth[pool.id] ?? 0;
    if (demand > capacity + EPS) {
      scoreParts.push((demand - capacity) / Math.max(0.1, capacity));
      conflicts.push({
        id: `link:${pool.id}`,
        kind: 'link',
        scope: 'planned',
        resourceId: pool.id,
        resourceName: pool.name,
        title: `链路带宽冲突 · ${pool.name}`,
        capacity,
        demand,
        unit: 'Gbps',
        severity: 'blocking',
        combination: poolLinks.map((l) =>
          linkRef(state, l.id, `${l.needGbps.toFixed(1)} Gbps · ${machineById(state, l.fromMachineId)?.name} ↔ ${machineById(state, l.toMachineId)?.name}`),
        ),
        message: `${demand.toFixed(1)} Gbps 的链路组合超过 ${capacity.toFixed(1)} Gbps 容量。`,
        suggestion: '提高链路带宽容量，或拆分/延后其中部分链路。',
      });
    }
  }

  // 数据库副本数量与机架反亲和
  for (const rs of state.replicaSets) {
    const memberIds = rs.machineIds.filter((id) => active.has(id));
    const minHealthy = state.capacities.replicaMin[rs.id] ?? rs.minHealthy;

    if (enforceReplicaCount && memberIds.length < minHealthy) {
      conflicts.push({
        id: `replica-count:${rs.id}`,
        kind: 'replica',
        subkind: 'count',
        scope: 'planned',
        resourceId: rs.id,
        resourceName: rs.name,
        title: `库中副本数不足 · ${rs.name}`,
        capacity: minHealthy,
        demand: memberIds.length,
        unit: '份健康副本',
        severity: 'blocking',
        combination: memberIds.map((id) => machineRef(state, id, '现有副本成员')),
        message: `安全策略要求 ${minHealthy} 份副本，但当前资源组合中只有 ${memberIds.length} 份。`,
        suggestion: '降低副本安全下限，或为该数据库增加可放置的副本节点。',
      });
    }

    if (rs.antiAffinityRack) {
      const byRack = new Map();
      for (const id of memberIds) {
        const rackId = placements[id]?.rackId;
        if (!rackId) continue;
        if (!byRack.has(rackId)) byRack.set(rackId, []);
        byRack.get(rackId).push(id);
      }
      for (const [rackId, ids] of byRack) {
        if (ids.length < 2) continue;
        const rack = rackById(state, rackId);
        conflicts.push({
          id: `replica-anti:${rs.id}:${rackId}`,
          kind: 'replica',
          subkind: 'anti-affinity',
          scope: 'planned',
          resourceId: rs.id,
          resourceName: rs.name,
          title: `副本机架反亲和冲突 · ${rs.name}`,
          capacity: 1,
          demand: ids.length,
          unit: '副本/机柜',
          severity: 'blocking',
          combination: ids.map((id) => machineRef(state, id, `均计划放入 ${rack?.name ?? rackId}`)),
          message: `${ids.length} 份库中副本被分配到同一故障域 ${rack?.name ?? rackId}，无法满足机架反亲和。`,
          suggestion: '将其中尚未上架的副本改派到其他机柜；已上架成员不能回滚挪柜。',
        });
      }
    }
  }

  return {
    ok: conflicts.length === 0,
    assignment,
    conflicts,
    score: scoreParts.reduce((sum, x) => sum + x * x, 0),
  };
}

function solveCombination(state, requiredIds, options = {}) {
  const required = new Set(requiredIds ?? state.machines.map((m) => m.id));
  const fixedIds = Object.keys(state.placements);
  const variables = state.machines.filter(
    (m) => required.has(m.id) && !state.placements[m.id],
  );
  const activeIds = new Set([...fixedIds, ...variables.map((m) => m.id)]);

  let best = null;
  const tentative = {};

  function dfs(index) {
    if (index === variables.length) {
      const result = evaluateAssignment(state, { ...tentative }, activeIds, options);
      if (result.ok) {
        best = result;
        return true;
      }
      if (!best || result.score < best.score) best = result;
      return false;
    }

    const machine = variables[index];
    for (const rackId of machine.candidateRackIds) {
      const choice = findFirstSlot(state, machine, rackId, tentative);
      tentative[machine.id] = choice;
      if (dfs(index + 1)) return true;
      delete tentative[machine.id];
    }
    return false;
  }

  dfs(0);

  if (best?.ok) return best;
  return (
    best ?? {
      ok: true,
      assignment: {},
      conflicts: [],
      score: 0,
    }
  );
}

function diagnoseActual(state) {
  const completed = new Set(state.completedStepIds);
  const conflicts = [];

  const powered = state.machines.filter((m) => completed.has(`power:${m.id}`));
  for (const domain of state.powerDomains) {
    const rackIds = new Set(state.racks.filter((r) => r.powerDomainId === domain.id).map((r) => r.id));
    const members = powered.filter((m) => rackIds.has(state.placements[m.id]?.rackId));
    const demand = round10(members.reduce((s, m) => s + m.powerKw, 0));
    const capacity = state.capacities.power[domain.id] ?? 0;
    if (demand > capacity + EPS) {
      conflicts.push({
        id: `actual-power:${domain.id}`,
        kind: 'power',
        scope: 'actual',
        resourceId: domain.id,
        resourceName: domain.name,
        title: `真实执行点已超供电配额 · ${domain.name}`,
        capacity,
        demand,
        unit: 'kW',
        severity: 'critical',
        combination: members.map((m) =>
          machineRef(state, m.id, `已上电 ${m.powerKw.toFixed(1)} kW · ${placementLabel(state, state.placements[m.id], m.id)}`),
        ),
        message: `不可回滚的上电动作已形成 ${demand.toFixed(1)} kW 实际负载，而当前配额只有 ${capacity.toFixed(1)} kW。`,
        suggestion: '求解器不会下架这些机器；请上调配额或恢复/改接供电后继续剩余步骤。',
      });
    }
  }

  for (const rack of state.racks) {
    const members = state.machines.filter((m) => state.placements[m.id]?.rackId === rack.id);
    const demand = members.reduce((s, m) => s + m.u, 0);
    const capacity = state.capacities.rackUnits[rack.id] ?? 0;
    if (demand > capacity + EPS) {
      conflicts.push({
        id: `actual-rack:${rack.id}`,
        kind: 'rack',
        scope: 'actual',
        resourceId: rack.id,
        resourceName: `机柜 ${rack.name}`,
        title: `实际上架位置已超容量 · ${rack.name}`,
        capacity,
        demand,
        unit: 'U',
        severity: 'critical',
        combination: members.map((m) => machineRef(state, m.id, `已占用 ${m.u}U · ${placementLabel(state, state.placements[m.id], m.id)}`)),
        message: `已确认上架的机器占用 ${demand}U，超过当前 ${capacity}U 容量；物理动作不能回滚。`,
        suggestion: '上调该机柜 U 位容量，或在现场另行扩展机柜空间。',
      });
    }
  }

  for (const pool of state.linkPools) {
    const usedLinks = state.links.filter(
      (l) => l.poolId === pool.id && completed.has(`link:${l.id}`),
    );
    const demand = round10(usedLinks.reduce((s, l) => s + l.needGbps, 0));
    const capacity = state.capacities.linkBandwidth[pool.id] ?? 0;
    if (demand > capacity + EPS) {
      conflicts.push({
        id: `actual-link:${pool.id}`,
        kind: 'link',
        scope: 'actual',
        resourceId: pool.id,
        resourceName: pool.name,
        title: `已开通链路超带宽 · ${pool.name}`,
        capacity,
        demand,
        unit: 'Gbps',
        severity: 'critical',
        combination: usedLinks.map((l) => linkRef(state, l.id, `已开通 ${l.needGbps.toFixed(1)} Gbps`)),
        message: `已确认接通的链路占用 ${demand.toFixed(1)} Gbps，超过当前容量 ${capacity.toFixed(1)} Gbps。`,
        suggestion: '上调链路容量后再继续验收。',
      });
    }
  }

  return conflicts;
}

function planRemaining(state) {
  const unplacedIds = state.machines.filter((m) => !state.placements[m.id]).map((m) => m.id);
  const full = solveCombination(state, state.machines.map((m) => m.id), {
    enforceReplicaCount: true,
  });

  const actualConflicts = diagnoseActual(state);
  const conflicts = [...actualConflicts, ...full.conflicts];

  let unsatCore = null;
  if (!full.ok) {
    let coreIds = [...unplacedIds];
    for (const id of [...unplacedIds]) {
      const trialIds = coreIds.filter((x) => x !== id);
      const trial = solveCombination(state, trialIds, { enforceReplicaCount: false });
      if (!trial.ok) coreIds = trialIds;
    }

    if (coreIds.length > 0) {
      const coreResult = solveCombination(state, coreIds, { enforceReplicaCount: false });
      unsatCore = {
        machineIds: coreIds,
        assignment: coreResult.assignment,
        conflicts: coreResult.conflicts,
      };
      conflicts.unshift({
        id: 'unsat-core',
        kind: 'combination',
        scope: 'analysis',
        resourceId: 'minimal-core',
        resourceName: '最小冲突组合',
        title: '计划不可行：求解器找到冲突的资源组合',
        severity: 'blocking',
        combination: coreIds.map((id) => machineRef(state, id, '无法与固定执行点同时排程')),
        message: `从当前真实执行点出发，枚举所有候选机柜后，${coreIds.length} 台待迁机器仍构成最小不可排程核心。`,
        suggestion: '解除下方任一资源冲突，或提高对应容量后重新求解剩余排程。',
      });
    }
  }

  const seen = new Set();
  const dedupedConflicts = conflicts.filter((c) => {
    if (c.id === 'unsat-core') return true;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  return {
    feasible: dedupedConflicts.length === 0,
    assignment: full.assignment,
    conflicts: dedupedConflicts,
    unsatCore,
    remainingMachineIds: unplacedIds,
  };
}

function decorateSteps(state, plan) {
  const completed = new Set(state.completedStepIds);
  return state.steps
    .map((step) => {
      const done = completed.has(step.id);
      const missingRequires = step.requires.filter((id) => !completed.has(id));
      const choice =
        state.stepChoices[step.id] ??
        (step.kind === 'rack.mount' ? plan.assignment?.[step.machineId] : undefined);
      return {
        ...step,
        done,
        missingRequires,
        choice: choice
          ? {
              ...choice,
              label: placementLabel(state, choice, step.machineId),
            }
          : undefined,
        ready: !done && missingRequires.length === 0,
        canConfirm: !done && missingRequires.length === 0 && plan.feasible,
      };
    })
    .sort((a, b) => a.phase - b.phase || a.order - b.order);
}

function buildUsage(state, assignment = {}) {
  const completed = new Set(state.completedStepIds);
  const projected = { ...state.placements, ...assignment };
  const result = { power: {}, rackUnits: {}, linkBandwidth: {}, replica: {} };

  for (const domain of state.powerDomains) {
    const rackIds = new Set(state.racks.filter((r) => r.powerDomainId === domain.id).map((r) => r.id));
    const actualMembers = state.machines.filter(
      (m) => completed.has(`power:${m.id}`) && rackIds.has(state.placements[m.id]?.rackId),
    );
    const peakMembers = state.machines.filter((m) => rackIds.has(projected[m.id]?.rackId));
    result.power[domain.id] = {
      capacity: state.capacities.power[domain.id],
      actual: round10(actualMembers.reduce((s, m) => s + m.powerKw, 0)),
      peak: round10(peakMembers.reduce((s, m) => s + m.powerKw, 0)),
      actualMembers: actualMembers.map((m) => m.id),
      peakMembers: peakMembers.map((m) => m.id),
    };
  }

  for (const rack of state.racks) {
    const actualMembers = state.machines.filter((m) => state.placements[m.id]?.rackId === rack.id);
    const peakMembers = state.machines.filter((m) => projected[m.id]?.rackId === rack.id);
    result.rackUnits[rack.id] = {
      capacity: state.capacities.rackUnits[rack.id],
      actual: actualMembers.reduce((s, m) => s + m.u, 0),
      peak: peakMembers.reduce((s, m) => s + m.u, 0),
      placements: peakMembers.map((m) => ({
        machineId: m.id,
        u: m.u,
        ...projected[m.id],
        label: placementLabel(state, projected[m.id], m.id),
      })),
    };
  }

  for (const pool of state.linkPools) {
    const actualLinks = state.links.filter(
      (l) => l.poolId === pool.id && completed.has(`link:${l.id}`),
    );
    const peakLinks = state.links.filter((l) => l.poolId === pool.id);
    result.linkBandwidth[pool.id] = {
      capacity: state.capacities.linkBandwidth[pool.id],
      actual: round10(actualLinks.reduce((s, l) => s + l.needGbps, 0)),
      peak: round10(peakLinks.reduce((s, l) => s + l.needGbps, 0)),
      actualLinks: actualLinks.map((l) => l.id),
      peakLinks: peakLinks.map((l) => l.id),
    };
  }

  for (const rs of state.replicaSets) {
    result.replica[rs.id] = {
      min: state.capacities.replicaMin[rs.id],
      members: rs.machineIds.map((id) => ({
        machineId: id,
        rackId: projected[id]?.rackId ?? state.placements[id]?.rackId,
        synced: completed.has(`replica:${rs.id}`),
      })),
    };
  }

  return result;
}

export function getView(state) {
  const plan = planRemaining(state);
  const steps = decorateSteps(state, plan);
  const usage = buildUsage(state, plan.assignment);
  const completedCount = state.completedStepIds.length;
  const total = state.steps.length;
  const nextStep = steps.find((s) => !s.done && s.ready) ?? null;

  return {
    ...state,
    plan,
    decoratedSteps: steps,
    usage,
    progress: {
      completed: completedCount,
      total,
      percent: total === 0 ? 0 : Math.round((completedCount / total) * 100),
      allDone: completedCount === total,
      nextStepId: nextStep?.id ?? null,
    },
  };
}

export function confirmStep(state, stepId) {
  const step = state.steps.find((s) => s.id === stepId);
  if (!step) throw new EngineError('STEP_NOT_FOUND', `找不到步骤 ${stepId}`, 404);
  if (state.completedStepIds.includes(stepId)) {
    throw new EngineError('STEP_ALREADY_DONE', `步骤 ${stepId} 已确认，不能重复执行`, 409);
  }

  const completed = new Set(state.completedStepIds);
  const missing = step.requires.filter((id) => !completed.has(id));
  if (missing.length > 0) {
    throw new EngineError('PREREQUISITE_MISSING', `步骤前置条件未完成：${missing.join(', ')}`, 409);
  }

  const plan = planRemaining(state);
  if (!plan.feasible) {
    throw new EngineError('PLAN_INFEASIBLE', '当前排程存在未解除的资源冲突，不能继续确认步骤', 409);
  }

  if (step.kind === 'rack.mount') {
    const choice = plan.assignment[step.machineId];
    if (!choice) throw new EngineError('NO_PLACEMENT', '求解器未给出可用上架位置', 409);
    state.placements[step.machineId] = {
      rackId: choice.rackId,
      startUnit: choice.startUnit,
      confirmedAt: new Date().toISOString(),
    };
    state.stepChoices[step.id] = state.placements[step.machineId];
  }

  state.completedStepIds.push(step.id);

  const eventTone = step.kind.includes('power') || step.irreversible ? 'warning' : 'success';
  pushEvent(state, {
    kind: 'step-confirmed',
    tone: eventTone,
    stepId,
    machineId: step.machineId,
    irreversible: Boolean(step.irreversible),
    title: `已确认：${step.title}`,
    message: step.irreversible
      ? '该动作已进入真实执行点；重新排程会保留此结果，不会回滚。'
      : '检查点已完成；剩余排程从当前账本继续。',
  });

  return getView(state);
}

const CAPACITY_SPECS = {
  power: { collection: 'powerDomains', label: '供电配额', unit: 'kW', min: 0, step: 0.1 },
  rackUnits: { collection: 'racks', label: '机柜 U 位容量', unit: 'U', min: 1, step: 1 },
  linkBandwidth: { collection: 'linkPools', label: '链路带宽', unit: 'Gbps', min: 0, step: 0.5 },
  replicaMin: { collection: 'replicaSets', label: '副本安全下限', unit: '份', min: 1, step: 1 },
};

export function updateCapacity(state, kind, resourceId, rawValue) {
  const spec = CAPACITY_SPECS[kind];
  if (!spec) throw new EngineError('BAD_CAPACITY_KIND', `未知容量类型 ${kind}`, 400);

  const resource = state[spec.collection].find((x) => x.id === resourceId);
  if (!resource) throw new EngineError('RESOURCE_NOT_FOUND', `找不到资源 ${resourceId}`, 404);

  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new EngineError('BAD_CAPACITY_VALUE', '容量必须是数字', 400);
  if (value < spec.min) throw new EngineError('BAD_CAPACITY_VALUE', `${spec.label}不能小于 ${spec.min}`, 400);

  const oldValue = state.capacities[kind][resourceId];
  const rounded = kind === 'rackUnits' || kind === 'replicaMin' ? Math.round(value) : round10(value);
  state.capacities[kind][resourceId] = rounded;

  pushEvent(state, {
    kind: 'capacity-changed',
    tone: 'info',
    capacityKind: kind,
    resourceId,
    title: `容量已修改：${resource.name}`,
    message: `${spec.label} ${oldValue}${spec.unit} → ${rounded}${spec.unit}；已从当前真实执行点重新求解。`,
  });

  return getView(state);
}

export function unplugTemporaryPower(state, feedId = 'tp-7') {
  const feed = state.tempFeeds.find((f) => f.id === feedId);
  if (!feed) throw new EngineError('FEED_NOT_FOUND', `找不到临时电源 ${feedId}`, 404);
  if (!feed.active) throw new EngineError('FEED_ALREADY_REMOVED', `${feed.name} 已被拔除`, 409);

  feed.active = false;
  const oldCapacity = state.capacities.power[feed.domainId];
  const newCapacity = round10(Math.max(0, oldCapacity - feed.kw));
  state.capacities.power[feed.domainId] = newCapacity;
  const domain = domainById(state, feed.domainId);

  pushEvent(state, {
    kind: 'temp-power-unplugged',
    tone: 'danger',
    feedId,
    resourceId: feed.domainId,
    title: `现场事件：${feed.name} 被拔除`,
    message: `${domain?.name ?? feed.domainId} 供电配额由 ${oldCapacity.toFixed(1)} kW 降至 ${newCapacity.toFixed(1)} kW。系统保留所有已确认动作，并从当前执行点重算剩余排程。`,
  });

  return getView(state);
}

export function createMidwayDisasterState() {
  const state = createInitialState();
  const fixedSteps = [
    'replica:rs-order',
    'offline:m-order-db',
    'mount:m-order-db',
    'power:m-order-db',
    'replica:rs-ledger',
    'offline:m-ledger-db',
    'mount:m-ledger-db',
  ];
  for (const id of fixedSteps) confirmStep(state, id);
  unplugTemporaryPower(state, 'tp-7');
  return state;
}

export const capacitySpecs = CAPACITY_SPECS;
