import 'fake-indexeddb/auto'
import { assert } from 'node:console'
import {
  db,
  initDatabase,
  createObservation,
  editObservation,
  voidObservation
} from '../src/utils/db.ts'

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`✗ ${label}\n  expected ${e}\n  actual   ${a}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${label}`)
  }
}

async function main(): Promise<void> {
  await initDatabase()

  // pt-1: 初值 0，阈值 25；播种读数 8.2(04-10) / 15.4(05-10) / 27.4(06-09)
  // 对应预警 al-1：橙，触发值 27.4，状态 待处置（未闭环，应被同步）
  let rows = (await db.observations.where('pointId').equals('pt-1').toArray()).sort((a, b) =>
    a.date.localeCompare(b.date)
  )
  assertEq(rows.length, 3, '播种 3 条 pt-1 观测')
  assertEq(rows[2].cumulative, 27.4, '播种累计量正确')
  assertEq(rows[2].dailyRate, 0.4, '播种日速率正确（27.4-15.4)/30')

  const alarmBefore = await db.alarms.get('al-1')
  assertEq([alarmBefore?.level, alarmBefore?.triggerValue, alarmBefore?.state], ['橙', 27.4, '待处置'], '初始未闭环橙预警')
  const closedBefore = await db.alarms.get('al-4')
  assertEq([closedBefore?.level, closedBefore?.state], ['黄', '已闭环'], '存在已闭环黄预警（应保持原样）')

  // 场景 1：编辑修正最早一条 8.2 → 10.2
  const edited = await editObservation(rows[0].id, {
    reading: 10.2,
    reason: '现场复测发现誊写错误',
    operator: '刘振国'
  })
  assertEq(edited.row.corrections.length, 1, '编辑后留存 1 条修正记录')
  assertEq(
    [edited.row.corrections[0].action, edited.row.corrections[0].readingBefore, edited.row.corrections[0].readingAfter, edited.row.corrections[0].reason],
    ['编辑', 8.2, 10.2, '现场复测发现誊写错误'],
    '修正记录含原因与修改前后读数'
  )

  rows = (await db.observations.where('pointId').equals('pt-1').toArray()).sort((a, b) => a.date.localeCompare(b.date))
  // 10.2(04-10) / 15.4(05-10) / 27.4(06-09)
  assertEq(rows[0].cumulative, 10.2, '首行累计量按新读数重算')
  assertEq(rows[0].dailyRate, 0, '首行日速率为 0')
  assertEq(rows[1].dailyRate, Number((Math.abs(15.4 - 10.2) / 30).toFixed(4)), '后续行日速率级联重算（05-10）')
  assertEq(rows[2].dailyRate, 0.4, '后续行日速率级联重算（06-09 仍为 0.4）')
  assertEq(rows[2].cumulative, 27.4, '未改行累计量不变')

  // 场景 2：编辑 27.4 → 22.0（不再越限），未闭环橙预警应撤销；已闭环不动
  await editObservation(rows[2].id, { reading: 22, reason: '仪器零点漂移，按校准值修正', operator: '陈文' })
  const alarmAfter = await db.alarms.get('al-1')
  assertEq(alarmAfter, undefined, '触发日修正后不再越限：未闭环预警撤销')
  const closedAfter = await db.alarms.get('al-4')
  assertEq([closedAfter?.level, closedAfter?.triggerValue, closedAfter?.state], ['黄', 27.9, '已闭环'], '已闭环预警保持原样')

  // 场景 3：把 22.0 改成 33.0（红级，ratio=1.32），不自动新建预警（与手动生成习惯一致）
  rows = (await db.observations.where('pointId').equals('pt-1').toArray()).sort((a, b) => a.date.localeCompare(b.date))
  const sync3 = await editObservation(rows[2].id, { reading: 33, reason: '再次复核确认', operator: '陈文' })
  assertEq([sync3.alarms.updated, sync3.alarms.removed], [0, 0], '无未闭环预警时无需同步')
  assertEq(rows[0].id && (await db.observations.get(rows[0].id))?.corrections.length, 1, '无关行修正记录未被追加')
  const last = await db.observations.get(rows[2].id)
  assertEq(last?.corrections.length, 2, '同一行两次修正全部留存')

  // 场景 4：新建一个未闭环预警再改读数，验证级别/触发值同步
  await db.alarms.put({
    id: 'al-test',
    pointId: 'pt-1',
    damId: 'dam-1',
    level: '红',
    triggerValue: 33,
    triggerDate: '2024-06-09',
    state: '待处置',
    handler: '',
    measure: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 2
  })
  await editObservation(rows[2].id, { reading: 26, reason: '终值核定', operator: '陈文' })
  const synced = await db.alarms.get('al-test')
  assertEq([synced?.level, synced?.triggerValue], ['橙', 26], '未闭环预警按最新结果同步级别与触发值')

  // 场景 5：作废中间行 05-10，验证软删除 + 级联重算 + 留痕 + 预警撤销
  rows = (await db.observations.where('pointId').equals('pt-1').toArray()).sort((a, b) => a.date.localeCompare(b.date))
  const target = rows[1] // 2024-05-10 读数 15.4
  const sync5 = await voidObservation(target.id, { reason: '当日记录录错无法复测', operator: '王丽' })
  const voidedRow = await db.observations.get(target.id)
  assertEq(voidedRow?.voided, true, '作废标记已写入（软删除，行仍在）')
  assertEq(
    [voidedRow?.corrections[0].action, voidedRow?.corrections[0].readingBefore, voidedRow?.corrections[0].readingAfter],
    ['作废', 15.4, null],
    '作废留痕记录修改前读数，修改后为空'
  )
  rows = (await db.observations.where('pointId').equals('pt-1').toArray()).sort((a, b) => a.date.localeCompare(b.date))
  const active = rows.filter((r) => !r.voided)
  assertEq(active.length, 2, '作废后有效观测剩 2 条')
  // 序列 10.2(04-10) / 26(06-09)：06-09 的日速率按 04-10 为上次重算
  const june = active.find((r) => r.date === '2024-06-09')
  assertEq(june?.dailyRate, Number((Math.abs(26 - 10.2) / 60).toFixed(4)), '作废行被跳过后日速率跨接重算')
  // 06-09 累计 26 仍越橙限（阈值25，ratio 1.04）
  const alarmPostVoid = await db.alarms.get('al-test')
  assertEq([alarmPostVoid?.level, alarmPostVoid?.triggerValue], ['橙', 26], '作废其他日期不影响 06-09 预警同步结果')

  // 场景 6：作废触发日 06-09 本身 → 未闭环预警失去依据被撤销；已闭环仍不动
  const sync6 = await voidObservation(june!.id, { reason: '整条观测作废', operator: '王丽' })
  assertEq(sync6.removed >= 1, true, '作废触发日后未闭环预警撤销')
  assertEq((await db.alarms.get('al-test')) ?? undefined, undefined, 'al-test 已撤销')
  const closedFinal = await db.alarms.get('al-4')
  assertEq(closedFinal?.state, '已闭环', '已闭环预警自始至终未改动')

  // 场景 7：无原因修正必须被拒绝
  let rejected = false
  try {
    await editObservation((await db.observations.get(rows[0].id))!.id, { reading: 11, reason: '   ', operator: 'x' })
  } catch {
    rejected = true
  }
  assertEq(rejected, true, '编辑修正不填原因被拒绝')
  let rejectedVoid = false
  try {
    await voidObservation((await db.observations.get(rows[0].id))!.id, { reason: '', operator: 'x' })
  } catch {
    rejectedVoid = true
  }
  assertEq(rejectedVoid, true, '作废不填原因被拒绝')

  // 场景 8：新录入也走同一重算闭环
  const created = await createObservation({
    id: 'ob-new',
    pointId: 'pt-1',
    date: '2024-07-09',
    reading: 40,
    observer: '赵鹏',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  assertEq(created.row.voided, false, '新录入默认有效')
  const prev = (await db.observations.where('pointId').equals('pt-1').toArray())
    .filter((r) => !r.voided)
    .sort((a, b) => a.date.localeCompare(b.date))
  assertEq(prev[prev.length - 1].dailyRate, Number((Math.abs(40 - 10.2) / 90).toFixed(4)), '新录入日速率按上一条有效观测计算')

  console.log('\n完成')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

// 引用 assert 避免未使用告警（node:console 的断言不可用，仅占位）
void assert
