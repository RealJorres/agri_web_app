/**
 * Builds a SYNTHETIC workbook with the same layout and defects as the PAO's 2023 file (brief §3), so
 * the workbook adapter is tested without real personal data. Every name is fake ("Sample..."), and
 * contact numbers use the 0900-000-xxxx test range. The stages are parameters, which is what proves
 * that another crop imports with no code change.
 */
import ExcelJS from 'exceljs'

type Count = number | string | null

export interface Row {
  name: string
  barangay: string
  counts?: Count[]
  farmLocation?: string
  association?: string
  contact?: number | string
  variety?: string
  datePlanted?: number | string
  source?: string
  remarks?: string
}

export interface Sheet {
  title: string
  town: string
  rows: Row[]
  below?: Row[]
  /** Stage index -> a defective formula for the TOTAL row. */
  totalOverrides?: Record<number, string>
}

export const STAGE_LABELS = ['SEEDLING', 'VEGETATIVE', 'FLOWERING', 'FRUITING']
const FIRST_DATA_ROW = 13
const FIRST_STAGE_COLUMN = 10 // J

export const CACAO_SHEETS: Sheet[] = [
  {
    title: 'BOAC',
    town: 'Boac',
    rows: [
      {
        name: 'Juan A. Samplecruz',
        barangay: 'Synthetic Alpha',
        counts: [10, 200, 50, 100],
        variety: 'UF18 & BR25',
        datePlanted: '2016, 2018,2021 & 2022',
        source: 'DA-RFO',
        contact: 9000000001,
        association: 'Sample Boac FA',
        remarks: '8 kilos harvest',
      },
      {
        name: 'Maria Sampleyes',
        barangay: 'Synthetic Alpha',
        counts: [0, 300, 0, 0],
        variety: 'BR 25',
        datePlanted: 2019,
        source: 'DA- RFO',
        association: 'None Member',
      },
      {
        name: 'Pedro Samplelos',
        barangay: 'Synthetic Beta, Boac',
        counts: [null, 100, 25, 75],
        variety: 'CriolIo',
        datePlanted: 2017,
        source: 'Own Produce',
        remarks: '3 kls.',
      },
      {
        name: 'Rosa Sampleduo',
        barangay: 'Synthetic Beta',
        counts: [5, 0, 0, 10],
        farmLocation: 'Synthetic Gamma',
      },
      {
        name: 'Rosa Sampleduo',
        barangay: 'Synthetic Beta',
        counts: [0, 0, 0, 20],
        farmLocation: 'Synthetic Beta',
      },
      { name: 'Ana Samplenone', barangay: 'Synthetic Gamma' }, // named, no trees counted
    ],
  },
  {
    title: 'BUENAVISTA',
    town: 'Buenavista',
    rows: [
      {
        name: 'Jose Samplebv',
        barangay: 'Synthetic Delta',
        counts: [100, 50, 0, 30],
        variety: 'KI & K18',
        datePlanted: '2017& 2019',
        source: 'PS',
        association: 'Sample BV Coop, Other Sample FA',
      },
      {
        name: 'Lito Samplebv',
        barangay: 'Synthetic Delta',
        counts: [0, 25, 5, 0],
        variety: 'W10 &  Criollo',
        source: 'DA/PCA/Own Produced',
        remarks: '1 sack',
      },
    ],
  },
  {
    title: 'MOGPOG',
    town: 'Mogpog',
    rows: [
      {
        name: 'Nena Samplemog',
        barangay: 'Synthetic Lamesa, Mogpog',
        counts: [3, 4, 5, 6],
        datePlanted: 'unknown',
        remarks: '6 kilos dried',
      },
      {
        name: 'Tony Samplemog',
        barangay: 'Synthetic Lamesa',
        counts: [7, 8, 9, 10],
        source: 'PCA',
        remarks: '1 kilo every other month',
      },
      { name: 'Lina Samplemog', barangay: 'Synthetic Ino', counts: [1, 1, 1, 1] },
    ],
    totalOverrides: { 2: 'SUM(L13)' },
  },
  {
    title: 'GASAN',
    town: 'Gasan',
    rows: [
      {
        name: 'Carlos Samplegas',
        barangay: 'Synthetic Tabionan',
        counts: [20, 40, 60, 80],
        farmLocation: 'Pulong Parang/Masalukot',
        association: 'Mat. Sample Gasan FA',
        variety: 'BR25&UF18',
      },
      {
        name: 'Elena Samplegas',
        barangay: 'Synthetic Tabionan',
        counts: [0, 0, 0, 15],
        association: 'Mat Sample Gasan FA',
        remarks: '325 trees died in May 2023, 80 now',
      },
    ],
  },
  {
    title: 'SANTA CRUZ',
    town: 'Santa Cruz',
    rows: [
      {
        name: 'Ramon Samplesc',
        barangay: 'Synthetic Maharlika',
        counts: [10, 10500, 30, 40],
        variety: 'BR25 ',
      },
      { name: 'Liza Samplesc', barangay: 'Synthetic Maharlika', counts: [2, 2, 2, 2] },
      { name: 'Rico Samplesc', barangay: 'Synthetic Matalaba', counts: [3, 3, 3, 3] },
      // The SUM ranges below stop at row 15 for J, K, L, so these three rows are skipped.
      { name: 'Dina Samplesc', barangay: 'Synthetic Matalaba', counts: [100, 150, 170, 5] },
      { name: 'Eric Samplesc', barangay: 'Synthetic Matalaba', counts: [60, 100, 100, 5] },
      { name: 'Gina Samplesc', barangay: 'Synthetic Matalaba', counts: [60, 100, 100, 5] },
    ],
    totalOverrides: { 0: 'SUM(J13:J15)', 1: 'SUM(K13:K15)', 2: 'SUM(L13:L15)' },
    below: [
      { name: 'Late Sampleentry', barangay: 'Synthetic Matalaba', counts: [0, 12, 0, 0] }, // a draft
      { name: 'Prepared by: Sample Officer', barangay: '' }, // name only, for the review list
    ],
  },
  {
    title: 'TORRIJOS',
    town: 'Torrijos',
    rows: [
      {
        name: 'Tess Sampletor',
        barangay: 'Synthetic Poctoy',
        counts: ['1,200', 30, 0, 0],
        datePlanted: 42736,
      },
      { name: 'Juan A. Samplecruz', barangay: 'Synthetic Poctoy', counts: [0, 0, 0, 1] }, // same name
      { name: 'Nora Samplenobrgy', barangay: '', counts: [0, 10, 0, 5] }, // BARANGAY empty
      {
        name: 'Ben Samplefarmloc',
        barangay: '',
        counts: [0, 0, 0, 7],
        farmLocation: 'Synthetic Poctoy',
      },
    ],
  },
]

const asNumber = (value: Count | undefined): number => {
  if (typeof value === 'number') return value
  return typeof value === 'string' ? Number(value.replaceAll(',', '')) : 0
}

export interface Truth {
  namedRows: number
  rowsWithTrees: number
  trueTotals: Record<string, number[]>
  workbookTotals: Record<string, number[]>
  belowWithBarangay: number
  nameOnly: number
  provinceTotal: number
}

export function truthOf(sheets: Sheet[], stageCount: number): Truth {
  const trueTotals: Record<string, number[]> = {}
  const workbookTotals: Record<string, number[]> = {}
  for (const sheet of sheets) {
    const totals = Array.from({ length: stageCount }, (_, stage) =>
      sheet.rows.reduce((sum, row) => sum + asNumber(row.counts?.[stage]), 0),
    )
    trueTotals[sheet.town] = totals
    workbookTotals[sheet.town] = totals.map((total, stage) => {
      const override = sheet.totalOverrides?.[stage]
      if (override === undefined) return total
      const [start, end] = override.slice(4, -1).split(':')
      const first = Number((start ?? '').slice(1)) - FIRST_DATA_ROW
      const last = Number((end ?? start ?? '').slice(1)) - FIRST_DATA_ROW
      return sheet.rows
        .slice(first, last + 1)
        .reduce((sum, row) => sum + asNumber(row.counts?.[stage]), 0)
    })
  }
  const rows = sheets.flatMap((sheet) => sheet.rows)
  const below = sheets.flatMap((sheet) => sheet.below ?? [])
  return {
    namedRows: rows.length,
    rowsWithTrees: rows.filter((row) => row.counts?.some((count) => asNumber(count) > 0)).length,
    trueTotals,
    workbookTotals,
    belowWithBarangay: below.filter((row) => row.barangay).length,
    nameOnly: below.filter((row) => !row.barangay).length,
    provinceTotal: Object.values(trueTotals)
      .flat()
      .reduce((sum, total) => sum + total, 0),
  }
}

function letter(index: number): string {
  return String.fromCharCode(64 + index)
}

/** Builds the workbook. A different crop passes its own sheets, stage labels and heading. */
export async function buildWorkbook(
  sheets: Sheet[] = CACAO_SHEETS,
  stageLabels: string[] = STAGE_LABELS,
  summaryLabels: string[] = ['GROWING', 'VEGETATIVE', 'FLOWERING', 'FRUITING'],
  cropName = 'CACAO',
): Promise<Buffer> {
  const stageCount = stageLabels.length
  const stageColumn = (stage: number) => FIRST_STAGE_COLUMN + stage
  const remarksColumn = FIRST_STAGE_COLUMN + stageCount
  const truth = truthOf(sheets, stageCount)
  const workbook = new ExcelJS.Workbook()

  const writeRow = (sheet: ExcelJS.Worksheet, r: number, number: number | null, row: Row) => {
    const set = (column: number, value: ExcelJS.CellValue) => {
      if (value !== undefined && value !== null && value !== '') {
        sheet.getCell(r, column).value = value
      }
    }
    set(1, number)
    set(2, row.name)
    set(3, row.barangay)
    set(4, row.farmLocation)
    set(5, row.association)
    set(6, row.contact)
    set(7, row.variety)
    set(8, row.datePlanted)
    set(9, row.source)
    row.counts?.forEach((count, stage) => {
      set(stageColumn(stage), count)
    })
    set(remarksColumn, row.remarks)
  }

  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.title)
    sheet.getCell('A1').value = 'Republic of the Philippines'
    sheet.getCell('A2').value = 'Province of Marinduque'
    sheet.getCell('A3').value = 'PROVINCIAL AGRICULTURE OFFICE'
    sheet.getCell('A9').value =
      `INITIAL ${cropName} POPULATION DATA IN THE MUNICIPALITY OF ${spec.town.toUpperCase()}`
    sheet.getCell('A10').value = 'as of July, 2023'
    for (let r = 1; r <= 10; r += 1) sheet.mergeCells(r, 1, r, remarksColumn)
    const headers = [
      'NO.',
      'NAME OF FARMER',
      'BARANGAY',
      'FARM LOCATION',
      'NAME OF ASSOCIATION',
      'CONTACT NO.',
      'VARIETY',
      'DATE PLANTED',
      'SOURCE OF PLANTING MATERIALS',
    ]
    headers.forEach((header, index) => {
      sheet.getCell(11, index + 1).value = header
    })
    sheet.getCell(11, FIRST_STAGE_COLUMN).value = `STATUS/NO. OF ${cropName} PLANTED`
    sheet.mergeCells(11, FIRST_STAGE_COLUMN, 11, FIRST_STAGE_COLUMN + stageCount - 1)
    sheet.getCell(11, remarksColumn).value = 'REMARKS'
    stageLabels.forEach((label, stage) => {
      sheet.getCell(12, stageColumn(stage)).value = label
    })
    let r = FIRST_DATA_ROW
    spec.rows.forEach((row, index) => {
      writeRow(sheet, r, index + 1, row)
      r += 1
    })
    const last = r - 1
    sheet.getCell(r, 2).value = 'TOTAL'
    stageLabels.forEach((_, stage) => {
      const column = letter(stageColumn(stage))
      const formula =
        spec.totalOverrides?.[stage] ??
        `SUM(${column}${String(FIRST_DATA_ROW)}:${column}${String(last)})`
      sheet.getCell(r, stageColumn(stage)).value = { formula }
    })
    r += 2
    for (const row of spec.below ?? []) {
      writeRow(sheet, r, null, row)
      r += 1
    }
  }

  const summary = workbook.addWorksheet('SUMMARY')
  summary.getCell('A3').value = `SUMMARY OF ${cropName} POPULATION (synthetic)`
  summary.getCell('C5').value = 'AREA BY STAGE (ha)'
  summary.getCell(5, 3 + stageCount).value = 'PLANT POPULATION BY STAGE'
  summary.getCell('A6').value = 'MUNICIPALITY'
  summary.getCell('B6').value = 'NO. OF FARMERS'
  summaryLabels.forEach((label, offset) => {
    summary.getCell(6, 3 + offset).value = label
    summary.getCell(6, 3 + stageCount + offset).value = label
  })
  sheets.forEach((spec, index) => {
    const row = 7 + index
    summary.getCell(row, 1).value = `${spec.town.toUpperCase()}, MARINDUQUE` // as in the real file
    summary.getCell(row, 2).value = spec.rows.length
    summaryLabels.forEach((_, stage) => {
      const trees = truth.workbookTotals[spec.town]?.[stage] ?? 0
      summary.getCell(row, 3 + stage).value = Math.round((trees / 625) * 100) / 100
      summary.getCell(row, 3 + stageCount + stage).value = trees
    })
  })
  summary.getCell('A22').value = 'Prepared by:'
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
