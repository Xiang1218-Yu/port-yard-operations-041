import test from 'node:test'; import assert from 'node:assert/strict'; import { containerPlan, dashboard, gateConflicts, prioritizeTasks } from './domain.js';
test('dashboard aggregates berth, yard, gate and exception signals', () => { const data = dashboard(); assert.equal(data.activeVoyages, 2); assert.ok(data.yardUtilization > 0.7); assert.ok(data.blockedTasks >= 1); });
test('gate conflict engine detects same truck overlap', () => { const conflicts = gateConflicts(); assert.ok(conflicts.some(item => item.appointmentId === 'APT-9001' || item.appointmentId === 'APT-9004')); });
test('yard planner respects reefer and hazmat constraints', () => { const plan = containerPlan('TGHU-9831204'); assert.equal(plan?.recommendedBlock?.hazmatAllowed, true); assert.ok(plan?.reasons.some(reason => reason.includes('危险品'))); });
test('priority queue promotes customs inspection work', () => { const tasks = prioritizeTasks(); assert.equal(tasks[0].containerId, 'TGHU-9831204'); });

test('container create, update and delete form a complete audited CRUD cycle', async () => {
  const { createContainer, updateContainer, deleteContainer, containers } = await import('./domain.js');
  const created = createContainer({ id: 'TEST-CRUD-0001', voyageId: 'VOY-AX7', size: '20', isoType: '22G1', direction: 'import', status: 'in-yard', weightT: 10, reefer: false, customs: 'released', priority: 'normal', yardSlot: 'C03-R11-T1' });
  assert.equal(created.id, 'TEST-CRUD-0001');
  assert.equal(updateContainer(created.id, { weightT: 12 })?.weightT, 12);
  assert.equal(deleteContainer(created.id)?.id, 'TEST-CRUD-0001');
  assert.equal(containers.some(item => item.id === 'TEST-CRUD-0001'), false);
});

test('appointment and task domain operations support create, update and delete', async () => {
  const { createGateAppointment, editGateAppointment, deleteGateAppointment, createYardTask, updateYardTask, deleteYardTask } = await import('./domain.js');
  const appointment = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: 'TEST-CRUD-01', driver: '测试司机', type: 'pickup', windowStart: new Date(Date.now()+3600000).toISOString(), windowEnd: new Date(Date.now()+7200000).toISOString(), lane: 'north' });
  assert.equal(editGateAppointment(appointment.id, { driver: '更新司机' })?.driver, '更新司机');
  assert.equal(deleteGateAppointment(appointment.id)?.id, appointment.id);
  const task = createYardTask({ kind: 'deliver', containerId: 'MSCU-4829017', from: 'A01-R01-T1', to: '南闸口', priority: 40, scheduledAt: new Date().toISOString(), estimatedMinutes: 12 });
  assert.equal(updateYardTask(task.id, { to: '北闸口' })?.to, '北闸口');
  assert.equal(deleteYardTask(task.id)?.id, task.id);
});

test('editing one appointment boundary validates the final window and rolls back all side effects', async () => {
  const { appointments, auditEvents, containers, createGateAppointment, editGateAppointment, deleteGateAppointment } = await import('./domain.js');
  const now = Date.now();
  const windowStart = new Date(now + 2 * 3600000).toISOString();
  const windowEnd = new Date(now + 3 * 3600000).toISOString();
  const appointment = createGateAppointment({ containerId: 'CMAU-6001722', truckNo: 'TEST-WINDOW-01', driver: '原司机', type: 'pickup', windowStart, windowEnd, lane: 'north' });
  const container = containers.find(item => item.id === 'CMAU-6001722')!;
  const originalContainerStatus = container.status;
  const auditCountBefore = auditEvents.length;

  try {
    assert.throws(
      () => editGateAppointment(appointment.id, { windowStart: new Date(now + 4 * 3600000).toISOString(), status: 'checked-in', driver: '不应保存' }),
      /预约结束时间必须晚于开始时间/
    );
    assert.throws(
      () => editGateAppointment(appointment.id, { windowEnd: new Date(now + 3600000).toISOString(), status: 'completed' }),
      /预约结束时间必须晚于开始时间/
    );

    const stored = appointments.find(item => item.id === appointment.id)!;
    assert.equal(stored.windowStart, windowStart);
    assert.equal(stored.windowEnd, windowEnd);
    assert.equal(stored.status, 'booked');
    assert.equal(stored.driver, '原司机');
    assert.equal(container.status, originalContainerStatus);
    assert.equal(container.appointmentId, appointment.id);
    assert.equal(auditEvents.length, auditCountBefore);
  } finally {
    deleteGateAppointment(appointment.id);
  }
});

test('conflict engine flags invalid windows without producing reverse-window overlaps', async () => {
  const { appointments, gateConflicts } = await import('./domain.js');
  const now = Date.now();
  const invalid = {
    id: 'APT-INVALID-TEST', containerId: 'CMAU-6001722', truckNo: 'TEST-INVALID-TRUCK', driver: '测试',
    windowStart: new Date(now + 3 * 3600000).toISOString(), windowEnd: new Date(now + 2 * 3600000).toISOString(),
    lane: 'north' as const, type: 'pickup' as const, status: 'booked' as const, sealVerified: false, weightVerified: false
  };
  appointments.unshift(invalid);
  try {
    const conflicts = gateConflicts();
    assert.ok(conflicts.some(item => item.appointmentId === 'APT-INVALID-TEST' && item.reason.includes('结束时间必须晚于开始时间')));
    assert.ok(!conflicts.some(item => item.reason.includes('TEST-INVALID-TRUCK') && item.reason.includes('时间窗口重叠')));
  } finally {
    appointments.splice(appointments.indexOf(invalid), 1);
  }
});
