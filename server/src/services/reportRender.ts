/** Lays report content out as .xlsx or .pdf, with no data access. */
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

import { logger } from '../lib/logger.js'

import type {
  MunicipalContent,
  ReportCommon,
  SummaryContent,
} from '../selectors/report.selectors.js'

const DRAFT_NOTE = 'DRAFT - the round is still open; figures may change.'
const FALLBACK_SIGNATORIES = ['Prepared by:', 'Submitted by:', 'Noted:'].map((caption) => ({
  caption,
  name: '',
  title: '',
}))

const group = (value: number) => value.toLocaleString('en-US')

function signatoriesOf(content: ReportCommon) {
  return content.signatories.length > 0 ? content.signatories : FALLBACK_SIGNATORIES
}

// --- Excel

const BOX: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF999999' } },
  left: { style: 'thin', color: { argb: 'FF999999' } },
  bottom: { style: 'thin', color: { argb: 'FF999999' } },
  right: { style: 'thin', color: { argb: 'FF999999' } },
}

function writeLetterhead(
  sheet: ExcelJS.Worksheet,
  content: ReportCommon,
  width: number,
  title: string,
): number {
  let row = 1
  const line = (text: string, font: Partial<ExcelJS.Font>) => {
    const cell = sheet.getCell(row, 1)
    cell.value = text
    cell.font = font
    cell.alignment = { horizontal: 'center' }
    sheet.mergeCells(row, 1, row, width)
    row += 1
  }
  content.letterhead.forEach((text, index) => {
    line(text, { bold: index < 3 })
  })
  row += 1
  for (const text of [content.program_line, title, `as of ${content.round.as_of}`]) {
    if (text) line(text, { bold: true })
  }
  if (!content.final) {
    const cell = sheet.getCell(row, 1)
    cell.value = DRAFT_NOTE
    cell.font = { bold: true, color: { argb: 'FFB8322F' } }
    row += 1
  }
  return row + 1
}

function writeSignatures(
  sheet: ExcelJS.Worksheet,
  content: ReportCommon,
  start: number,
  width: number,
): void {
  const blocks = signatoriesOf(content)
  const span = Math.max(1, Math.floor(width / Math.max(1, blocks.length)))
  const row = start + 2
  blocks.forEach((block, index) => {
    const column = 1 + index * span
    sheet.getCell(row, column).value = block.caption
    const name = sheet.getCell(row + 2, column)
    name.value = block.name || '______________________'
    name.font = { bold: true }
    sheet.getCell(row + 3, column).value = block.title
  })
}

async function bytesOf(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

const headerStyle = (cell: ExcelJS.Cell) => {
  cell.font = { bold: true }
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  cell.border = BOX
}

export function summaryTitle(content: { commodity: string }): string {
  const crop = content.commodity.toUpperCase()
  return `SUMMARY OF ${crop} POPULATION DATA IN THE PROVINCE OF MARINDUQUE`
}

export function municipalTitle(content: { commodity: string; municipality: string }): string {
  const crop = content.commodity.toUpperCase()
  return `${crop} POPULATION DATA IN THE MUNICIPALITY OF ${content.municipality.toUpperCase()}`
}

export async function summaryXlsx(content: SummaryContent): Promise<Buffer> {
  const n = content.stages.length
  const width = 2 + (n + 1) * 2 // municipality, farmers, area x n + total, trees x n + total
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('SUMMARY', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  let row = writeLetterhead(sheet, content, width, summaryTitle(content))

  // Two header rows, like the 2023 sheet.
  const headers: [number, number, string][] = [
    [1, 1, 'MUNICIPALITY / PROVINCE'],
    [2, 2, 'NO. OF FARMERS'],
    [3, 2 + n, 'AREA PLANTED (HA.)'],
    [3 + n, 3 + n, 'TOTAL AREA (HA.)'],
    [4 + n, 3 + 2 * n, 'PLANT POPULATION'],
    [4 + 2 * n, 4 + 2 * n, 'TOTAL PLANT POPULATION'],
  ]
  for (const [start, end, text] of headers) {
    sheet.getCell(row, start).value = text
    if (end > start) sheet.mergeCells(row, start, row, end)
    else sheet.mergeCells(row, start, row + 1, start)
  }
  content.stages.forEach((label, index) => {
    sheet.getCell(row + 1, 3 + index).value = label.toUpperCase()
    sheet.getCell(row + 1, 4 + n + index).value = label.toUpperCase()
  })
  for (const r of [row, row + 1]) {
    for (let c = 1; c <= width; c += 1) headerStyle(sheet.getCell(r, c))
  }
  row += 2

  const write = (values: (string | number | null)[], bold = false) => {
    values.forEach((value, index) => {
      const cell = sheet.getCell(row, index + 1)
      cell.value = value
      cell.border = BOX
      cell.font = { bold }
    })
    row += 1
  }
  const area = (value: string | null) => (value === null ? null : Number(value))
  const line = (label: string, data: SummaryContent['total'], bold = false) => {
    write(
      [
        label,
        data.farmers,
        ...data.area.map(area),
        area(data.area_total),
        ...data.trees,
        data.trees_total,
      ],
      bold,
    )
    for (let c = 3; c <= 3 + n; c += 1) sheet.getCell(row - 1, c).numFmt = '0.000'
    for (let c = 4 + n; c <= width; c += 1) sheet.getCell(row - 1, c).numFmt = '#,##0'
  }
  for (const data of content.rows) {
    line(`${data.municipality.toUpperCase()}, MARINDUQUE`, data)
  }
  line('TOTAL', content.total, true)
  if (content.density_note) {
    sheet.getCell(row + 1, 1).value = `NOTE: ${content.density_note}`
    row += 1
  }
  writeSignatures(sheet, content, row, width)
  sheet.getColumn(1).width = 28
  for (let c = 2; c <= width; c += 1) sheet.getColumn(c).width = 13
  return bytesOf(workbook)
}

const MUNICIPAL_COLUMNS = [
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

export async function municipalListXlsx(content: MunicipalContent): Promise<Buffer> {
  const columns = [
    ...MUNICIPAL_COLUMNS,
    ...content.stages.map((label) => label.toUpperCase()),
    'REMARKS',
  ]
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(content.municipality.toUpperCase().slice(0, 31) || 'LIST', {
    pageSetup: { orientation: 'landscape' },
  })
  let row = writeLetterhead(sheet, content, columns.length, municipalTitle(content))
  columns.forEach((text, index) => {
    const cell = sheet.getCell(row, index + 1)
    cell.value = text
    headerStyle(cell)
  })
  row += 1
  for (const data of content.rows) {
    const values = [
      data.no,
      data.name,
      data.barangay,
      data.farm_location,
      data.association,
      data.contact,
      data.variety,
      data.planted,
      data.source,
      ...data.counts,
      data.remarks,
    ]
    values.forEach((value, index) => {
      const cell = sheet.getCell(row, index + 1)
      cell.value = value
      cell.border = BOX
    })
    row += 1
  }
  const label = sheet.getCell(row, 2)
  label.value = 'TOTAL'
  label.font = { bold: true }
  content.totals.forEach((total, index) => {
    const cell = sheet.getCell(row, 10 + index)
    cell.value = total
    cell.font = { bold: true }
    cell.numFmt = '#,##0'
  })
  writeSignatures(sheet, content, row + 1, columns.length)
  ;[6, 28, 18, 18, 24, 15, 14, 14, 18].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width
  })
  return bytesOf(workbook)
}

// --- PDF: fixed metadata, so the same content gives the same file (ADR-0019).

const MARGIN = 34
/** A4 landscape's usable width, in points. */
const PAGE_WIDTH = 774
const FONT = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const CELL_PADDING = 3

interface Column {
  width: number
  align?: 'left' | 'right' | 'center'
}

interface HeaderCell {
  text: string
  column: number
  columns?: number
  rows?: number
}

interface Table {
  columns: Column[]
  /** Header rows, repeated on each new page. */
  header: HeaderCell[][]
  rows: { cells: string[]; bold?: boolean }[]
  fontSize: number
}

function drawTable(doc: PDFKit.PDFDocument, table: Table): void {
  const left = MARGIN
  const widthOf = (from: number, count: number) =>
    table.columns.slice(from, from + count).reduce((sum, column) => sum + column.width, 0)
  const xOf = (column: number) => left + widthOf(0, column)
  const bottom = () => doc.page.height - MARGIN - 14
  const size = table.fontSize
  doc.lineWidth(0.5).strokeColor('#888888')

  const cell = (
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    align: string,
  ) => {
    doc.rect(x, y, width, height).stroke()
    doc.fillColor('#111111').text(text, x + CELL_PADDING, y + CELL_PADDING, {
      width: width - 2 * CELL_PADDING,
      align: align as 'left',
      lineBreak: true,
    })
  }

  const drawHeader = () => {
    const rowHeights = table.header.map((cells) => {
      doc.font(BOLD).fontSize(size)
      const tallest = cells
        .filter((item) => (item.rows ?? 1) === 1)
        .map((item) =>
          doc.heightOfString(item.text, {
            width: widthOf(item.column, item.columns ?? 1) - 2 * CELL_PADDING,
          }),
        )
      return Math.max(size, ...tallest) + 2 * CELL_PADDING
    })
    // A tall spanning label such as "Municipality / Province" stretches the header's last row.
    table.header.forEach((cells, rowIndex) => {
      for (const item of cells) {
        const span = item.rows ?? 1
        if (span === 1) continue
        const needed =
          doc.heightOfString(item.text, {
            width: widthOf(item.column, item.columns ?? 1) - 2 * CELL_PADDING,
          }) +
          2 * CELL_PADDING
        const have = rowHeights.slice(rowIndex, rowIndex + span).reduce((a, b) => a + b, 0)
        const last = rowIndex + span - 1
        if (needed > have) rowHeights[last] = (rowHeights[last] ?? 0) + needed - have
      }
    })
    let y = doc.y
    table.header.forEach((cells, rowIndex) => {
      for (const item of cells) {
        const span = item.rows ?? 1
        const height = rowHeights.slice(rowIndex, rowIndex + span).reduce((a, b) => a + b, 0)
        const width = widthOf(item.column, item.columns ?? 1)
        doc.rect(xOf(item.column), y, width, height).fillAndStroke('#EEF2F7', '#888888')
        cell(item.text, xOf(item.column), y, width, height, 'center')
      }
      y += rowHeights[rowIndex] ?? 0
    })
    doc.y = y
  }

  drawHeader()
  for (const row of table.rows) {
    doc.font(row.bold ? BOLD : FONT).fontSize(size)
    const height =
      Math.max(
        size,
        ...row.cells.map((text, index) =>
          doc.heightOfString(text || ' ', {
            width: (table.columns[index]?.width ?? 0) - 2 * CELL_PADDING,
          }),
        ),
      ) +
      2 * CELL_PADDING
    if (doc.y + height > bottom()) {
      doc.addPage()
      drawHeader()
      doc.font(row.bold ? BOLD : FONT).fontSize(size)
    }
    const y = doc.y
    row.cells.forEach((text, index) => {
      const column = table.columns[index]
      cell(text, xOf(index), y, column?.width ?? 0, height, column?.align ?? 'left')
    })
    doc.y = y + height
  }
}

function drawSignatures(doc: PDFKit.PDFDocument, content: ReportCommon): void {
  const blocks = signatoriesOf(content)
  const usable = doc.page.width - 2 * MARGIN
  const gap = 24
  const width = (usable - gap * (blocks.length - 1)) / blocks.length
  if (doc.y + 80 > doc.page.height - MARGIN - 14) doc.addPage()
  const top = doc.y + 24
  blocks.forEach((block, index) => {
    const x = MARGIN + index * (width + gap)
    doc.font(FONT).fontSize(9).fillColor('#111111')
    doc.text(block.caption, x, top, { width })
    const lineY = top + 42
    doc
      .moveTo(x, lineY)
      .lineTo(x + width, lineY)
      .strokeColor('#111111')
      .lineWidth(0.5)
      .stroke()
    doc.font(BOLD).text(block.name, x, lineY + 3, { width })
    doc.font(FONT).text(block.title, x, doc.y, { width })
  })
}

async function renderPdf(
  content: ReportCommon,
  title: string,
  logo: Buffer | null,
  body: (doc: PDFKit.PDFDocument) => void,
): Promise<Buffer> {
  const fixedDate = new Date(`${content.round.as_of}T00:00:00.000Z`)
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: title,
      Creator: 'Marinduque Agri Data Management System',
      Producer: 'agri-dms',
      CreationDate: fixedDate,
      ModDate: fixedDate,
    },
  })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    doc.on('error', reject)
  })

  const pageWidth = doc.page.width - 2 * MARGIN
  const centered = (text: string, font: string, size: number) => {
    doc.font(font).fontSize(size).fillColor('#111111').text(text, MARGIN, doc.y, {
      width: pageWidth,
      align: 'center',
    })
  }
  if (logo) {
    // A damaged logo file must not stop an official report, so it is left off instead.
    try {
      doc.image(logo, doc.page.width / 2 - 28, doc.y, { height: 56 })
      doc.y += 60
    } catch {
      logger.warn('reports.logo_unreadable')
    }
  }
  content.letterhead.forEach((line, index) => {
    centered(line, index < 4 ? BOLD : FONT, 9)
  })
  doc.moveDown(0.4)
  if (content.program_line) centered(content.program_line, BOLD, 9)
  doc.moveDown(0.4)
  centered(title, BOLD, 11)
  centered(`as of ${content.round.as_of}`, FONT, 9)
  doc.moveDown(0.4)
  if (!content.final) {
    const y = doc.y
    doc.font(BOLD).fontSize(9).fillColor('#B8322F')
    doc.text(DRAFT_NOTE, MARGIN, y + 4, { width: pageWidth, align: 'center' })
    doc.rect(MARGIN, y, pageWidth, 18).strokeColor('#B8322F').lineWidth(0.75).stroke()
    doc.y = y + 24
  }
  body(doc)
  drawSignatures(doc, content)

  const { start, count } = doc.bufferedPageRange()
  for (let page = start; page < start + count; page += 1) {
    doc.switchToPage(page)
    // Writing in the bottom margin would otherwise start a new page.
    const { bottom } = doc.page.margins
    doc.page.margins.bottom = 0
    doc.font(FONT).fontSize(8).fillColor('#555555')
    doc.text(
      `Page ${String(page - start + 1)} of ${String(count)}`,
      MARGIN,
      doc.page.height - MARGIN + 8,
      { width: pageWidth, align: 'right', lineBreak: false },
    )
    doc.page.margins.bottom = bottom
  }
  doc.end()
  return finished
}

export function summaryPdf(content: SummaryContent, logo: Buffer | null = null): Promise<Buffer> {
  const n = content.stages.length
  const number = { align: 'right' } as const
  // The stage columns share what is left of A4 landscape's usable width.
  const stageWidth = (PAGE_WIDTH - 118 - 44 - 44 - 50) / (2 * n)
  const columns: Column[] = [
    { width: 118 },
    { width: 44, ...number },
    ...Array.from({ length: n }, () => ({ width: stageWidth, ...number })),
    { width: 44, ...number },
    ...Array.from({ length: n }, () => ({ width: stageWidth, ...number })),
    { width: 50, ...number },
  ]
  const header: HeaderCell[][] = [
    [
      { text: 'Municipality / Province', column: 0, rows: 2 },
      { text: 'No. of farmers', column: 1, rows: 2 },
      { text: 'Area planted (ha)', column: 2, columns: n },
      { text: 'Total area (ha)', column: 2 + n, rows: 2 },
      { text: 'Plant population', column: 3 + n, columns: n },
      { text: 'Total plant population', column: 3 + 2 * n, rows: 2 },
    ],
    content.stages.flatMap((label, index) => [
      { text: label, column: 2 + index },
      { text: label, column: 3 + n + index },
    ]),
  ]
  const line = (label: string, data: SummaryContent['total'], bold = false) => ({
    cells: [
      label,
      group(data.farmers),
      ...data.area.map((value) => value ?? ''),
      data.area_total ?? '',
      ...data.trees.map(group),
      group(data.trees_total),
    ],
    bold,
  })
  const title = summaryTitle(content)
  return renderPdf(content, title, logo, (doc) => {
    drawTable(doc, {
      columns,
      header,
      fontSize: 8,
      rows: [
        ...content.rows.map((row) => line(`${row.municipality.toUpperCase()}, MARINDUQUE`, row)),
        line('TOTAL', content.total, true),
      ],
    })
    if (content.density_note) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#111111')
      doc.text(`NOTE: ${content.density_note}`, MARGIN, doc.y + 6)
    }
  })
}

export function municipalListPdf(
  content: MunicipalContent,
  logo: Buffer | null = null,
): Promise<Buffer> {
  const n = content.stages.length
  const number = { align: 'right' } as const
  const fixed = [22, 96, 54, 54, 70, 52, 40, 36, 54]
  const remaining = PAGE_WIDTH - fixed.reduce((a, b) => a + b, 0)
  // Wide enough for a label such as "Vegetative" on one line, with the rest left for remarks.
  const stageWidth = Math.min(46, (remaining - 60) / Math.max(1, n))
  const columns: Column[] = [
    ...fixed.map((width, index) => ({ width, ...(index === 0 ? number : {}) })),
    ...Array.from({ length: n }, () => ({ width: stageWidth, ...number })),
    { width: remaining - stageWidth * n },
  ]
  const labels = [
    'No.',
    'Name of farmer',
    'Barangay',
    'Farm location',
    'Association',
    'Contact no.',
    'Variety',
    'Date planted',
    'Source',
    ...content.stages,
    'Remarks',
  ]
  const title = municipalTitle(content)
  return renderPdf(content, title, logo, (doc) => {
    drawTable(doc, {
      columns,
      header: [labels.map((text, column) => ({ text, column }))],
      fontSize: 7,
      rows: [
        ...content.rows.map((row) => ({
          cells: [
            String(row.no),
            row.name,
            row.barangay,
            row.farm_location,
            row.association,
            row.contact,
            row.variety,
            row.planted,
            row.source,
            ...row.counts.map((count) => (count === null ? '' : group(count))),
            row.remarks,
          ],
        })),
        {
          bold: true,
          cells: [
            '',
            'TOTAL',
            ...Array.from({ length: 7 }, () => ''),
            ...content.totals.map(group),
            '',
          ],
        },
      ],
    })
  })
}
