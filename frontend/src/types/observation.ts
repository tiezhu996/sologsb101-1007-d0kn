/** 观测：某测点某日的读数记录 */
export interface Observation {
  id: string
  pointId: string
  /** 观测日期 YYYY-MM-DD */
  date: string
  /** 读数（作废行保留作废前最后一次读数，仅作历史留存） */
  reading: number
  /** 累计变化（读数 − 初值）；作废行不参与重算，保留作废时快照 */
  cumulative: number
  /** 日速率（与上一次观测的差值 ÷ 间隔天数）；作废行不参与重算，保留作废时快照 */
  dailyRate: number
  observer: string
  /** 是否已作废（读数录错后软删除：行保留、不参与重算与预警判定） */
  voided: boolean
  /** 历次修正记录（编辑 / 作废按时间先后追加，最近一次在末尾） */
  corrections: CorrectionRecord[]
  createdAt: number
  updatedAt: number
}

/** 修正动作：编辑读数或作废记录 */
export type CorrectionAction = '编辑' | '作废'

/** 一次修正留痕：修正原因、修改前后读数、修正人与时间 */
export interface CorrectionRecord {
  action: CorrectionAction
  /** 修正原因（必填） */
  reason: string
  /** 修改前读数 */
  readingBefore: number
  /** 修改后读数；作废时为 null */
  readingAfter: number | null
  /** 修正人 */
  operator: string
  /** 修正时间（毫秒时间戳） */
  correctedAt: number
}

export interface ObservationDraft {
  pointId: string
  date: string
  reading: number
  observer: string
}

/** 录入 / 编辑弹窗表单：仅编辑时需要填写修正原因 */
export interface ObservationFormValues extends ObservationDraft {
  /** 编辑或作废前必填的修正原因 */
  correctionReason?: string
}

export const EMPTY_OBSERVATION_DRAFT: ObservationDraft = {
  pointId: '',
  date: '',
  reading: 0,
  observer: ''
}

/** 单测点观测序列取点 */
export interface TrendPoint {
  seq: number
  date: string
  reading: number
  cumulative: number
  dailyRate: number
}

/** 观测录入页的成组录入行 */
export interface ObservationBatchRow {
  pointId: string
  date: string
  reading: number
  observer: string
}

/** 取一条观测的最近一次修正记录（无则 null） */
export function latestCorrection(row: Pick<Observation, 'corrections'>): CorrectionRecord | null {
  return row.corrections.length > 0 ? row.corrections[row.corrections.length - 1] : null
}

/** 毫秒时间戳格式化为 YYYY-MM-DD HH:mm */
export function formatCorrectedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—'
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
