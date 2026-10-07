'use strict';
// Run: node tests/invoice-diesel-report.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A worksheet model tests report logic without browser/dependency installation.
// The optional second pass verifies the actual vendored ExcelJS serialization.
class Row {
  constructor(number) { this.number = number; this.cells = new Map(); }
  getCell(column) { if (!this.cells.has(column)) this.cells.set(column, { value: null }); return this.cells.get(column); }
  set values(values) { values.forEach((value, index) => { this.getCell(index + 1).value = value; }); }
  eachCell(options, fn) { fn = fn || options; [...this.cells].sort((a, b) => a[0] - b[0]).forEach(([column, cell]) => fn(cell, column)); }
}
class Sheet {
  constructor(name) { this.name = name; this.rows = new Map(); this.columns = new Map(); this.merges = []; }
  getRow(number) { if (!this.rows.has(number)) this.rows.set(number, new Row(number)); return this.rows.get(number); }
  getCell(address) { const [, letters, number] = /^([A-Z]+)(\d+)$/.exec(address); let column = 0; for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64; return this.getRow(Number(number)).getCell(column); }
  getColumn(number) { if (!this.columns.has(number)) this.columns.set(number, {}); return this.columns.get(number); }
  addRow(values) { const number = Math.max(0, ...this.rows.keys()) + 1; const row = this.getRow(number); row.values = values; return row; }
  eachRow(fn) { [...this.rows].sort((a, b) => a[0] - b[0]).forEach(([number, row]) => fn(row, number)); }
  mergeCells(range) { this.merges.push(range); }
}
class Workbook {
  constructor() { this.worksheets = []; }
  addWorksheet(name) { const sheet = new Sheet(name); this.worksheets.push(sheet); return sheet; }
  getWorksheet(name) { return this.worksheets.find(sheet => sheet.name === name); }
}
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '../control-tower.js'), 'utf8');
const start = source.indexOf('function reportNumber(');
const end = source.indexOf('\nasync function exportInvoiceExcel');
assert.ok(start >= 0, 'Report helpers must exist');
const context = vm.createContext({
  Intl, Date, console,
  hasPrice: order => order.customer_price != null && order.customer_price !== '' && Number.isFinite(Number(order.customer_price)),
  normalizeCustomer: value => String(value || '').trim().toLowerCase(),
  osloDate: value => value ? new Date(value).toISOString().slice(0, 10) : '',
  dateCell: value => value ? new Date(value) : null
});
// Use the same realm as the real ExcelJS library (which tests arrays with instanceof).
const helpers = new Function(...Object.keys(context), source.slice(start, end >= 0 ? end : undefined) + '; return { buildInvoiceWorkbook, customerReportPricing, sumReportAmounts };');
Object.assign(context, helpers(...Object.values(context)));
const fixtures = [
  { order_number: 1, customer: 'Testkunde', carrier_price: 35000, customer_base_price: 40000, customer_diesel_percent: 9, customer_diesel_amount: 3600, customer_price: 43600, carrier_invoice_received: true },
  { order_number: 2, customer: 'Testkunde', carrier_price: 40000, customer_base_price: '46500.00', customer_diesel_percent: '8.75', customer_diesel_amount: '4068.75', customer_price: '50568.75' },
  { order_number: 3, customer: 'Eldre kunde', carrier_price: 30000, customer_base_price: null, customer_diesel_percent: 0, customer_diesel_amount: 0, customer_price: 40000, customer_invoice_sent: true },
  { order_number: 4, customer: 'Ukjent pris', carrier_price: null, customer_base_price: null, customer_diesel_percent: 0, customer_diesel_amount: 0, customer_price: null },
  { order_number: 5, customer: 'Nullpris', carrier_price: 0, customer_base_price: 0, customer_diesel_percent: 0, customer_diesel_amount: 0, customer_price: 0 },
  { order_number: 6, customer: 'Avrunding', carrier_price: 0, customer_base_price: 0.05, customer_diesel_percent: 10, customer_diesel_amount: 0.01, customer_price: 0.06 },
  { order_number: 7, customer: 'Uten tillegg', carrier_price: 23000, customer_base_price: 25000, customer_diesel_percent: 0, customer_diesel_amount: 0, customer_price: 25000 }
];
const snapshot = JSON.stringify(fixtures);
assert.equal(context.customerReportPricing({ customer_price: 100, customer_diesel_percent: 9 }).diesel, null, 'Missing breakdown must not be invented');
assert.equal(context.sumReportAmounts([0.1, 0.2, 0.01]), 0.31);
function checkWorkbook(ExcelJS) {
  const workbook = context.buildInvoiceWorkbook(ExcelJS, fixtures, [{ name: 'Testkunde', org_number: '123456789', invoice_email: 'test@example.invalid' }], { month: '', scope: 'all' });
  const sheet = workbook.getWorksheet('Fakturagrunnlag');
  const values = row => [12, 13, 14, 15, 16, 17].map(column => sheet.getRow(row).getCell(column).value);
  assert.deepEqual(values(5), [35000, 40000, 0.09, 3600, 43600, 'Til fakturering']);
  assert.deepEqual(values(6), [40000, 46500, 0.0875, 4068.75, 50568.75, 'Venter transportørfaktura']);
  assert.deepEqual(values(7), [30000, 40000, 0, 0, 40000, 'Fakturert']);
  assert.deepEqual(values(8), [null, null, 0, 0, null, 'Venter transportørfaktura']);
  assert.deepEqual(values(9), [0, 0, 0, 0, 0, 'Venter transportørfaktura']);
  assert.equal(sheet.getCell('O10').value, 0.01);
  assert.equal(sheet.getCell('P10').value, 0.06);
  assert.equal(sheet.getCell('N5').numFmt, '0.00%');
  assert.equal(sheet.getCell('O5').numFmt, '#,##0.00 "NOK"');
  assert.equal(sheet.getCell('N4').value, 'Dieseltillegg (%)');
  assert.equal(sheet.getCell('O4').value, 'Dieseltillegg (NOK)');
  assert.ok(sheet.getCell('P4').value.includes('total inkl. diesel'));
  assert.ok(sheet.getCell('M7').note);
  assert.equal(sheet.getCell('M8').fill.fgColor.argb, 'FFFFE6A3');
  assert.equal(sheet.getCell('P8').fill.fgColor.argb, 'FFFFE6A3');
  for (const [cell, formula, result] of [
    ['L13', 'SUBTOTAL(109,L5:L11)', 128000],
    ['M14', 'SUBTOTAL(109,M5:M11)', 151500.05],
    ['O15', 'SUBTOTAL(109,O5:O11)', 7668.76],
    ['P16', 'SUBTOTAL(109,P5:P11)', 159168.81]
  ]) { assert.equal(sheet.getCell(cell).value.formula, formula); assert.equal(sheet.getCell(cell).value.result, result); }
  for (let row = 13; row <= 16; row++) assert.equal(sheet.getCell('N' + row).value, null, 'Percentages must not be totalled');
  assert.equal(sheet.autoFilter.to.column, 17);
  assert.equal(sheet.autoFilter.to.row, 11);
  assert.equal(sheet.views[0].ySplit, 4);
  assert.equal(workbook.getWorksheet('Kundedetaljer').getCell('B2').value, '123456789');
  const empty = context.buildInvoiceWorkbook(ExcelJS, [], [], { month: '', scope: 'all' }).getWorksheet('Fakturagrunnlag');
  assert.equal(empty.getCell('P9').value, 0, 'Empty selection must not create a backwards subtotal range');
  assert.equal(JSON.stringify(fixtures), snapshot, 'Export must never modify order data or invoice flags');
  return workbook;
}
checkWorkbook({ Workbook });
console.log('PASS: 17 columns, diesel amounts, percentage format, legacy/missing/zero prices, rounding, 4 subtotals, filters and unchanged source data');
const vendor = path.join(__dirname, '../vendor/exceljs-4.4.0.min.js');
if (fs.existsSync(vendor)) {
  const ExcelJS = require(vendor);
  const workbook = checkWorkbook(ExcelJS);
  workbook.xlsx.writeBuffer().then(async bytes => {
    const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(bytes);
    const sheet = loaded.getWorksheet('Fakturagrunnlag');
    assert.equal(sheet.getCell('O5').value, 3600);
    assert.equal(sheet.getCell('P16').value.result, 159168.81);
    assert.equal(sheet.getCell('N5').numFmt, '0.00%');
    console.log('PASS: actual ExcelJS workbook serialization and reload');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
