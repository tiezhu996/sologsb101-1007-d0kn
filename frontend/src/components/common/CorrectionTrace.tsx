/**
 * <CorrectionTrace> 观测修正留痕
 * 展示最近一次修正（动作、原因、修改前后读数、修正人、时间），
 * 气泡内列出全部修正记录。明细与导出共用同一份 corrections 数据。
 */
import { Popover, Tag } from 'antd'
import type { ObservationRow } from '@/utils/db'
import { formatCorrectedAt, latestCorrection } from '@/types/observation'

export interface CorrectionTraceProps {
  row: ObservationRow
  /** 气泡触发方式，表格内默认 hover */
  trigger?: 'hover' | 'click'
}

const ACTION_COLOR: Record<string, string> = { 编辑: 'orange', 作废: 'default' }

function describeReading(value: number | null): string {
  return value === null ? '已作废' : value.toFixed(3)
}

export function correctionSummaryText(row: ObservationRow): string {
  const latest = latestCorrection(row)
  if (!latest) return ''
  return `${latest.action}：${describeReading(latest.readingBefore)} → ${describeReading(latest.readingAfter)}，原因「${latest.reason}」（${latest.operator} ${formatCorrectedAt(latest.correctedAt)}）`
}

export default function CorrectionTrace({ row, trigger = 'hover' }: CorrectionTraceProps) {
  const corrections = row.corrections ?? []
  const latest = latestCorrection(row)
  if (!latest) return <span className="muted">—</span>

  const content = (
    <div style={{ maxWidth: 300 }}>
      {corrections.map((item, index) => (
        <div key={`${item.correctedAt}-${index}`} style={{ paddingBottom: index === corrections.length - 1 ? 0 : 10 }}>
          <div style={{ marginBottom: 4 }}>
            <Tag color={ACTION_COLOR[item.action] ?? 'default'}>{item.action}</Tag>
            <span className="muted" style={{ fontSize: 12 }}>
              {formatCorrectedAt(item.correctedAt)} · {item.operator}
            </span>
          </div>
          <div>
            读数：<span style={{ textDecoration: 'line-through' }}>{describeReading(item.readingBefore)}</span>
            {' → '}
            <strong>{describeReading(item.readingAfter)}</strong>
          </div>
          <div style={{ marginTop: 2 }}>修正原因：{item.reason}</div>
        </div>
      ))}
    </div>
  )

  return (
    <Popover title={`修正记录（共 ${corrections.length} 次）`} content={content} trigger={trigger}>
      <span style={{ cursor: 'pointer', color: latest.action === '作废' ? '#8c8c8c' : '#d46b08' }}>
        <Tag color={ACTION_COLOR[latest.action] ?? 'default'}>{latest.action}</Tag>
        <span style={{ fontSize: 12 }}>
          {describeReading(latest.readingBefore)} → {describeReading(latest.readingAfter)}
        </span>
        {corrections.length > 1 ? <span className="muted"> ×{corrections.length}</span> : null}
      </span>
    </Popover>
  )
}
