import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmStep,
  createInitialState,
  createMidwayDisasterState,
  getView,
  unplugTemporaryPower,
  updateCapacity,
} from '../public/engine.js';

function confirmEveryReadyStep(state) {
  let confirmed = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const view = getView(state);
    if (view.progress.allDone) return confirmed;
    const next = view.decoratedSteps.find((step) => step.canConfirm);
    if (!next) {
      throw new Error(
        `没有可确认步骤；冲突：${view.plan.conflicts.map((c) => c.title).join(' | ')}`,
      );
    }
    confirmStep(state, next.id);
    confirmed += 1;
  }
  throw new Error('确认步骤超过保护上限');
}

test('初始场景可求解，且包含四类资源约束', () => {
  const view = getView(createInitialState());
  assert.equal(view.plan.feasible, true);
  assert.equal(view.plan.conflicts.length, 0);
  assert.ok(view.steps.length >= 25);
  assert.ok(view.decoratedSteps.some((s) => s.kind === 'rack.mount' && s.choice));
  assert.ok(view.decoratedSteps.some((s) => s.kind === 'link.up'));
  assert.ok(view.decoratedSteps.some((s) => s.kind === 'replica.sync'));
});

test('可以逐条确认直到全部完成', () => {
  const state = createInitialState();
  const count = confirmEveryReadyStep(state);
  const view = getView(state);
  assert.equal(count, view.progress.total);
  assert.equal(view.progress.allDone, true);
  assert.equal(view.plan.feasible, true);
});

test('容量下调到实际用量以下会立即显示冲突组合', () => {
  const state = createInitialState();
  confirmStep(state, 'replica:rs-order');
  confirmStep(state, 'offline:m-order-db');
  confirmStep(state, 'mount:m-order-db');
  confirmStep(state, 'power:m-order-db');

  updateCapacity(state, 'power', 'pdu-a', 1.0);
  const view = getView(state);
  assert.equal(view.plan.feasible, false);

  const actual = view.plan.conflicts.find((c) => c.id === 'actual-power:pdu-a');
  assert.ok(actual);
  assert.equal(actual.scope, 'actual');
  assert.ok(actual.combination.some((x) => x.id === 'm-order-db'));
  assert.ok(actual.demand > actual.capacity);
});

test('拔掉临时电源后保留真实执行点，并暴露已固定机器的供电组合', () => {
  const state = createMidwayDisasterState();
  const view = getView(state);

  assert.equal(view.tempFeeds[0].active, false);
  assert.deepEqual(
    state.completedStepIds,
    [
      'replica:rs-order',
      'offline:m-order-db',
      'mount:m-order-db',
      'power:m-order-db',
      'replica:rs-ledger',
      'offline:m-ledger-db',
      'mount:m-ledger-db',
    ],
  );
  assert.equal(state.placements['m-order-db'].rackId, 'r-a');
  assert.equal(state.placements['m-ledger-db'].rackId, 'r-a');
  assert.equal(view.plan.feasible, false);

  const powerConflict = view.plan.conflicts.find((c) => c.id === 'power:pdu-a');
  assert.ok(powerConflict, '应出现 PDU-A 排程峰值冲突');
  const ids = powerConflict.combination.map((x) => x.id);
  assert.ok(ids.includes('m-order-db'));
  assert.ok(ids.includes('m-ledger-db'));
  assert.ok(powerConflict.demand > powerConflict.capacity);
  assert.ok(
    powerConflict.combination.find((x) => x.id === 'm-order-db')?.detail.includes('U1–U2'),
    '2U 机器的冲突组合应显示完整起止 U 位',
  );
  assert.ok(
    powerConflict.combination.find((x) => x.id === 'm-ledger-db')?.detail.includes('U3–U4'),
  );
});

test('断电冲突后上调容量，不回滚已完成步骤即可跑完全部剩余排程', () => {
  const state = createMidwayDisasterState();
  const beforeCompleted = [...state.completedStepIds];

  assert.throws(() => confirmStep(state, 'offline:m-order-rep'), /冲突/);

  updateCapacity(state, 'power', 'pdu-a', 4.8);
  const view = getView(state);
  assert.equal(view.plan.feasible, true, view.plan.conflicts.map((c) => c.message).join('\n'));
  assert.deepEqual(state.completedStepIds, beforeCompleted, '调整容量不能回滚任何步骤');

  confirmEveryReadyStep(state);
  const finalView = getView(state);
  assert.equal(finalView.progress.allDone, true);
  for (const id of beforeCompleted) assert.ok(state.completedStepIds.includes(id));
  assert.equal(state.placements['m-order-db'].rackId, 'r-a');
  assert.equal(state.placements['m-ledger-db'].rackId, 'r-a');
});

test('链路容量过低时显示共享带宽上的链路组合', () => {
  const state = createInitialState();
  updateCapacity(state, 'linkBandwidth', 'lp-db', 4.0);
  const view = getView(state);
  assert.equal(view.plan.feasible, false);
  const conflict = view.plan.conflicts.find((c) => c.id === 'link:lp-db');
  assert.ok(conflict);
  assert.deepEqual(
    conflict.combination.map((x) => x.id).sort(),
    ['l-ledger-repl', 'l-order-repl'],
  );
});

test('重复拔除临时电源会被拒绝且状态不变', () => {
  const state = createInitialState();
  unplugTemporaryPower(state);
  assert.throws(() => unplugTemporaryPower(state), /已被拔除/);
  assert.equal(state.capacities.power['pdu-a'], 4.2);
});
