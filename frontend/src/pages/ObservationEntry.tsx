/**
 * /observations 位移 / 浸润线观测录入
 * 按日期与测点类型成组录入读数，录入即与阈值比对并给出预警级别，可直接生成预警单。
 * 读数录错时走修正流程：编辑或作废前必须填写修正原因，保存后按日期顺序重算该测点
 * 全部观测（作废行不参与），并按最新结果同步未闭环预警的级别与触发值；已闭环预警不动。
 * 消费 Observation、Point、Alarm；复用 <FilterBar>、<AlarmTag>、<EmptyPanel>、<StatBadge>、<CorrectionTrace>。
 */
import { useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag
} from 'antd'
import type { TableColumnsType } from 'antd'
import AlarmTag from '@/components/common/AlarmTag'
import CorrectionTrace from '@/components/common/CorrectionTrace'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { usePointStore } from '@/stores/pointStore'
import { useAlarmStore } from '@/stores/alarmStore'
import { useAlarmLevel } from '@/hooks/useAlarmLevel'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createObservation,
  db,
  editObservation,
  voidObservation,
  type AlarmSyncResult,
  type ObservationRow
} from '@/utils/db'
import { exportObservationCsv } from '@/utils/export'
import { POINT_TYPES, type Point, type PointType } from '@/types/point'
import type { ObservationFormValues } from '@/types/observation'

interface VoidFormValues {
  reason: string
  operator: string
}

/** 拼装预警同步结果的提示后缀 */
function alarmSyncText(sync: AlarmSyncResult): string {
  const parts: string[] = []
  if (sync.updated > 0) parts.push(`${sync.updated} 张未闭环预警的级别/触发值已同步`)
  if (sync.removed > 0) parts.push(`${sync.removed} 张已失去依据的未闭环预警已撤销`)
  return parts.length > 0 ? `；${parts.join('，')}（已闭环预警保持原样）` : '；未闭环预警无需调整（已闭环保持原样）'
}

export default function ObservationEntry() {
  const { message } = AntdApp.useApp()
  const damStore = useDamStore()
  const pointStore = usePointStore()
  const alarmStore = useAlarmStore()
  const alarmLevel = useAlarmLevel()
  const observationTable = useIdbTable<ObservationRow>(db.observations, { sortByUpdatedAt: false })

  const [form] = Form.useForm<ObservationFormValues>()
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [voidTarget, setVoidTarget] = useState<ObservationRow | null>(null)
  const [voidOpen, setVoidOpen] = useState(false)
  const [voidForm] = Form.useForm<VoidFormValues>()

  const filter = pointStore.filter
  const filterSelects = useMemo(
    () => [
      {
        key: 'damId',
        label: '坝体',
        multiple: false,
        options: damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))
      },
      { key: 'types', label: '测点类型', options: POINT_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [damStore.dams]
  )

  const model: FilterModel = { keyword: filter.keyword, damId: filter.damId, types: filter.types }

  const onModelChange = (next: FilterModel): void => {
    pointStore.patchFilter({
      keyword: String(next.keyword ?? ''),
      damId: typeof next.damId === 'string' ? next.damId : '',
      types: (Array.isArray(next.types) ? next.types : []) as PointType[]
    })
  }

  const candidates = pointStore.points.filter((point) => {
    if (filter.damId && point.damId !== filter.damId) return false
    if (filter.types.length > 0 && !filter.types.includes(point.type)) return false
    const text = filter.keyword.trim().toLowerCase()
    if (text.length === 0) return true
    return point.code.toLowerCase().includes(text)
  })

  const activePointId = pointStore.selectedIds[0] ?? null
  const activePoint = activePointId ? pointStore.points.find((point) => point.id === activePointId) ?? null : null

  const observationsOfActive = useMemo(
    () =>
      observationTable.rows
        .filter((row) => row.pointId === activePointId)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt),
    [observationTable.rows, activePointId]
  )

  const draftReading = Form.useWatch('reading', form)
  const draftDate = Form.useWatch('date', form)
  const preview =
    activePoint && typeof draftReading === 'number'
      ? alarmLevel.evaluate(activePoint, draftReading)
      : null

  const openCreate = (): void => {
    if (!activePoint) {
      message.warning('请先在左侧选择一个测点')
      return
    }
    setEditingId(null)
    const latest = observationTable.rows
      .filter((row) => row.pointId === activePoint.id && !row.voided)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    form.setFieldsValue({
      pointId: activePoint.id,
      date: new Date().toISOString().slice(0, 10),
      reading: latest ? latest.reading : activePoint.initialValue,
      observer: '',
      correctionReason: ''
    })
    setOpen(true)
  }

  const openEdit = (row: ObservationRow): void => {
    if (row.voided) {
      message.warning('已作废的观测记录不能编辑')
      return
    }
    setEditingId(row.id)
    form.setFieldsValue({
      pointId: row.pointId,
      date: row.date,
      reading: row.reading,
      observer: row.observer,
      correctionReason: ''
    })
    setOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    // pointId 由隐藏字段注册进表单；这里再兜底一次，并给出可读提示，避免写库失败时无任何反馈
    const pointId = values.pointId ?? activePoint?.id ?? ''
    if (!pointId) {
      message.error('未选择测点，无法保存观测记录')
      return
    }
    const now = Date.now()
    try {
      if (editingId) {
        const result = await editObservation(editingId, {
          reading: Number(values.reading) || 0,
          reason: String(values.correctionReason ?? ''),
          operator: values.observer.trim() || '未署名',
          date: values.date,
          observer: values.observer.trim() || '未署名'
        })
        message.success(`观测记录已修正，该测点全部观测已按日期重算${alarmSyncText(result.alarms)}`)
      } else {
        const result = await createObservation({
          id: `ob_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          pointId,
          date: values.date,
          reading: Number(values.reading) || 0,
          observer: values.observer.trim() || '未署名',
          createdAt: now,
          updatedAt: now
        })
        message.success(`观测已录入，累计量与日速率已自动计算${alarmSyncText(result.alarms)}`)
      }
    } catch (error) {
      message.error(`观测保存失败：${error instanceof Error ? error.message : '未知错误'}`)
      return
    }
    setOpen(false)
  }

  const openVoid = (row: ObservationRow): void => {
    if (row.voided) return
    setVoidTarget(row)
    voidForm.setFieldsValue({ reason: '', operator: row.observer })
    setVoidOpen(true)
  }

  const submitVoid = async (): Promise<void> => {
    const values = await voidForm.validateFields().catch(() => null)
    if (!values || !voidTarget) return
    try {
      const sync = await voidObservation(voidTarget.id, {
        reason: values.reason,
        operator: values.operator.trim() || '未署名'
      })
      message.success(`观测记录已作废，该测点全部观测已按日期重算${alarmSyncText(sync)}`)
    } catch (error) {
      message.error(`作废失败：${error instanceof Error ? error.message : '未知错误'}`)
      return
    }
    setVoidOpen(false)
    setVoidTarget(null)
  }

  const generateAlarm = async (): Promise<void> => {
    if (!activePoint) {
      message.info('请先在左侧选择一个测点')
      return
    }
    if (editingId) {
      message.info('编辑修正模式下不直接生成预警单；保存后系统会自动同步未闭环预警')
      return
    }
    if (!preview) {
      message.info('请先点击「录入观测」并填写读数，越限后可生成预警单')
      return
    }
    if (preview.level === null) {
      message.info('当前读数未越限，无需生成预警单')
      return
    }
    const result = alarmLevel.buildDraft(activePoint, draftDate || new Date().toISOString().slice(0, 10), Number(draftReading))
    if (!result) return
    await alarmStore.createAlarm({ ...result.draft, measure: result.basis })
    message.success(`已生成${result.draft.level}色预警单`)
  }

  const exportCsv = (): void => {
    if (observationTable.rows.length === 0) {
      message.warning('暂无观测记录可导出')
      return
    }
    const filename = exportObservationCsv(damStore.dams, damStore.sections, pointStore.points, observationTable.rows)
    message.success(`已导出观测台账 ${filename}（含修正原因及修改前后读数）`)
  }

  const columns: TableColumnsType<ObservationRow> = [
    { title: '日期', dataIndex: 'date', width: 110 },
    {
      title: '读数',
      dataIndex: 'reading',
      width: 110,
      render: (value: number, record) => (
        <span style={{ textDecoration: record.voided ? 'line-through' : undefined, color: record.voided ? '#8c8c8c' : undefined }}>
          {value.toFixed(3)}
        </span>
      )
    },
    {
      title: '累计变化',
      dataIndex: 'cumulative',
      width: 120,
      render: (value: number, record) => (
        <span
          style={{
            color: record.voided ? '#8c8c8c' : value >= 0 ? '#b03a2e' : '#2f7a4f',
            textDecoration: record.voided ? 'line-through' : undefined
          }}
        >
          {value.toFixed(3)}
        </span>
      )
    },
    {
      title: '日速率',
      dataIndex: 'dailyRate',
      width: 110,
      render: (value: number, record) => (
        <span style={{ color: record.voided ? '#8c8c8c' : undefined, textDecoration: record.voided ? 'line-through' : undefined }}>
          {value.toFixed(4)}
        </span>
      )
    },
    {
      title: '状态',
      width: 90,
      render: (_value, record) => (record.voided ? <Tag color="default">已作废</Tag> : <Tag color="green">有效</Tag>)
    },
    {
      title: '判定',
      width: 140,
      render: (_value, record) => {
        if (record.voided) return <span className="muted">不参与判定</span>
        const point = pointStore.points.find((item) => item.id === record.pointId)
        if (!point) return <span className="muted">测点已删除</span>
        const level = alarmLevel.evaluate(point, record.reading).level
        return level ? <AlarmTag level={level} size="small" /> : <Tag color="green">正常</Tag>
      }
    },
    { title: '观测人', dataIndex: 'observer', width: 90 },
    {
      title: '修正留痕',
      width: 180,
      render: (_value, record) => <CorrectionTrace row={record} trigger="click" />
    },
    {
      title: '操作',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="link" size="small" disabled={record.voided} onClick={() => openEdit(record)}>
            编辑修正
          </Button>
          <Button type="link" size="small" danger disabled={record.voided} onClick={() => openVoid(record)}>
            作废
          </Button>
        </Space>
      )
    }
  ]

  const activeCount = observationTable.rows.filter((row) => !row.voided).length
  const voidedCount = observationTable.rows.length - activeCount
  const observedPoints = new Set(
    observationTable.rows.filter((row) => !row.voided).map((row) => row.pointId)
  ).size

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">位移 / 浸润线观测录入</h2>
          <p className="page-head__desc">
            选定测点后按日期录入读数，系统自动与初值比对算累计量与日速率；读数录错可编辑或作废（必填修正原因），保存后全量重算并同步未闭环预警。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={exportCsv}>导出观测台账 CSV</Button>
          <Button type="primary" disabled={!activePoint} onClick={openCreate}>
            录入观测
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="有效观测" value={activeCount} suffix="条" tone="primary" />
        <StatBadge label="已作废" value={voidedCount} suffix="条" tone="info" />
        <StatBadge label="已观测测点" value={observedPoints} suffix="个" tone="info" />
        <StatBadge label="待处置预警" value={alarmStore.counts()['待处置']} suffix="张" tone="danger" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索测点编号"
        onModelChange={onModelChange}
      />

      <div className="grid-two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3 className="panel-title">测点列表（{candidates.length}）</h3>
          {candidates.length === 0 ? (
            <EmptyPanel title="没有可录入的测点" description="先到测点配置页布设测点与阈值。" compact />
          ) : (
            candidates.map((point: Point) => {
              const own = observationTable.rows
                .filter((row) => row.pointId === point.id && !row.voided)
                .sort((a, b) => b.date.localeCompare(a.date))
              const latest = own[0]
              const total = observationTable.rows.filter((row) => row.pointId === point.id).length
              const level = latest ? alarmLevel.evaluate(point, latest.reading).level : null
              return (
                <div
                  key={point.id}
                  className={`card-list-item${point.id === activePointId ? ' is-active' : ''}`}
                  onClick={() => pointStore.setSelectedIds([point.id])}
                >
                  <div className="card-list-item__head">
                    <span>{point.code}</span>
                    {level ? <AlarmTag level={level} size="small" /> : <Tag color="green">正常</Tag>}
                  </div>
                  <div className="card-list-item__meta">
                    <span>{point.type}</span>
                    <span>· 阈值 {point.threshold} {point.unit}</span>
                    <span>
                      · 观测 {own.length} 次{total !== own.length ? `（含作废 ${total - own.length}）` : ''}
                    </span>
                  </div>
                  <div className="card-list-item__meta">
                    <span>最新：{latest ? `${latest.date} ${latest.reading.toFixed(3)} ${point.unit}` : '暂无有效观测'}</span>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="panel">
          {activePoint ? (
            <>
              <div className="panel-head">
                <h3 className="panel-title" style={{ margin: 0 }}>
                  {activePoint.code} · 观测明细
                  <span className="muted">
                    {' '}
                    {activePoint.type} · 初值 {activePoint.initialValue} {activePoint.unit} · 阈值 {activePoint.threshold}{' '}
                    {activePoint.unit}
                  </span>
                </h3>
                <Space>
                  <Button size="small" onClick={exportCsv}>
                    导出 CSV
                  </Button>
                  <Button size="small" type="primary" onClick={openCreate}>
                    录入观测
                  </Button>
                </Space>
              </div>
              {observationsOfActive.length === 0 ? (
                <EmptyPanel
                  title="该测点暂无观测记录"
                  description="点击「录入观测」登记第一条读数。"
                  actionText="录入观测"
                  onAction={openCreate}
                  compact
                />
              ) : (
                <Table<ObservationRow>
                  rowKey="id"
                  size="small"
                  bordered
                  dataSource={observationsOfActive}
                  columns={columns}
                  pagination={false}
                  rowClassName={(record) => (record.voided ? 'observation-row--voided' : '')}
                  scroll={{ x: 1080 }}
                />
              )}
            </>
          ) : (
            <EmptyPanel title="尚未选择测点" description="在左侧测点列表中选择一个测点后即可录入观测读数。" compact />
          )}
        </div>
      </div>

      <Modal
        open={open}
        title={editingId ? '编辑修正观测记录' : `录入观测${activePoint ? ` · ${activePoint.code}` : ''}`}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>取消</Button>
            {/* 读数草稿只在弹窗内存在，因此越限生成预警单必须与读数同屏可用；修正模式下改由保存后自动同步 */}
            <Button onClick={generateAlarm} disabled={!!editingId || !preview || preview.level === null}>
              生成预警单
            </Button>
            <Button type="primary" onClick={submit}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          {/* 隐藏字段：把当前测点注册进表单，保证 validateFields() 能取回 pointId */}
          <Form.Item name="pointId" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="date" label="观测日期" rules={[{ required: true, message: '请填写观测日期' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="reading" label="读数" rules={[{ required: true, message: '请填写读数' }]}>
            <InputNumber step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="observer" label="观测人" rules={[{ required: true, message: '请填写观测人' }]}>
            <Input placeholder="如 刘振国" />
          </Form.Item>
          {editingId ? (
            <Form.Item
              name="correctionReason"
              label="修正原因"
              rules={[{ required: true, message: '编辑修正前必须填写修正原因' }]}
              tooltip="将与修改前后读数一起留痕，重开页面与导出台账均可查看"
            >
              <Input.TextArea rows={2} placeholder="如 现场复测发现原始读数誊写错误，按复测值更正" />
            </Form.Item>
          ) : null}
          {preview ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="muted">
                累计变化 {preview.cumulative.toFixed(3)} · 占阈值 {(preview.ratio * 100).toFixed(1)}%
              </span>
              {preview.level ? <AlarmTag level={preview.level} /> : <Tag color="green">正常</Tag>}
            </div>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={voidOpen}
        title="作废观测记录"
        onCancel={() => {
          setVoidOpen(false)
          setVoidTarget(null)
        }}
        onOk={submitVoid}
        okText="确认作废"
        cancelText="取消"
        destroyOnClose
      >
        {voidTarget ? (
          <Form form={voidForm} layout="vertical">
            <p className="muted" style={{ marginTop: 0 }}>
              {voidTarget.date} 读数 <strong>{voidTarget.reading.toFixed(3)}</strong> 作废后将保留留痕，
              但不再参与累计变化、日速率重算与预警判定；未闭环预警会按最新结果同步，已闭环预警保持原样。
            </p>
            <Form.Item
              name="reason"
              label="修正原因"
              rules={[{ required: true, message: '作废前必须填写修正原因' }]}
            >
              <Input.TextArea rows={3} placeholder="如 该日读数录错且现场无法复测，经观测员核实后作废" />
            </Form.Item>
            <Form.Item name="operator" label="修正人" rules={[{ required: true, message: '请填写修正人' }]}>
              <Input placeholder="如 刘振国" />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </div>
  )
}
