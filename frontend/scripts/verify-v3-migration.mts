// 验证 v2 → v3 升级：旧库观测行没有 voided / corrections，打开后被迁移补齐
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

// 用独立的全新 IndexedDB（import db.ts 之前完成挂载；db.ts 无顶层 indexedDB 访问）
;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
;(globalThis as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange

async function buildV2Database(): Promise<void> {
  // 直接用 indexedDB 原生 API 建一个 v2 结构的 Dexie 库（与 db.ts 的 DB_NAME 相同）
  const open = indexedDB.open('gbtaildam', 2)
  await new Promise<void>((resolve, reject) => {
    open.onupgradeneeded = () => {
      const idb = open.result
      const obs = idb.createObjectStore('observations', { keyPath: 'id' })
      obs.createIndex('pointId', 'pointId')
      obs.createIndex('date', 'date')
      idb.createObjectStore('points', { keyPath: 'id' })
      idb.createObjectStore('alarms', { keyPath: 'id' })
      idb.createObjectStore('dams', { keyPath: 'id' })
      idb.createObjectStore('sections', { keyPath: 'id' })
      idb.createObjectStore('pools', { keyPath: 'id' })
      obs.put({
        id: 'ob-legacy',
        pointId: 'pt-x',
        date: '2024-01-01',
        reading: 5,
        cumulative: 5,
        dailyRate: 0,
        observer: '旧观测员',
        createdAt: 1,
        updatedAt: 1,
        revision: 2
        // 故意没有 voided / corrections
      })
    }
    open.onsuccess = () => {
      open.result.close()
      resolve()
    }
    open.onerror = () => reject(open.error)
  })
}

async function main(): Promise<void> {
  await buildV2Database()

  const { db } = await import('../src/utils/db.ts')
  await db.open()

  const row = await db.observations.get('ob-legacy')
  if (!row) throw new Error('迁移后旧观测行丢失')
  const checks: Array<[boolean, string]> = [
    [row.voided === false, '旧观测行迁移后 voided=false'],
    [Array.isArray(row.corrections) && row.corrections.length === 0, '旧观测行迁移后 corrections=[]'],
    [row.reading === 5 && row.observer === '旧观测员', '迁移不破坏原有字段']
  ]
  let failed = 0
  checks.forEach(([ok, label]) => {
    console.log(`${ok ? '✓' : '✗'} ${label}`)
    if (!ok) failed += 1
  })
  if (failed > 0) process.exitCode = 1
  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
