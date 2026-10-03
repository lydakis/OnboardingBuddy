// Builds fixtures/rosters/october-new-hires.xlsx from the CSV fixture (synthetic data).
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';

const rows = readFileSync(new URL('../fixtures/rosters/october-new-hires.csv', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split(','));
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('October hires');
for (const r of rows) ws.addRow(r);
ws.getRow(4).font = { bold: true };
await wb.xlsx.writeFile(new URL('../fixtures/rosters/october-new-hires.xlsx', import.meta.url).pathname);
console.log('wrote fixtures/rosters/october-new-hires.xlsx');
