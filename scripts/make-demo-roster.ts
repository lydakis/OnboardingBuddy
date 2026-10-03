// Builds fixtures/rosters/fleetwing-new-hires-demo.xlsx: a messy, synthetic roster for live demos.
import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Week of Oct 12');
ws.addRow(['Fleetwing Express (fictional) — Dayton hub']);
ws.addRow(['Accepted offers, please onboard ASAP', '', '', '', 'Prepared by: HR ops']);
ws.addRow([]);
ws.addRow(['Hub', 'Contact email', 'Employee', 'Shift', 'Start', 'Comments']);
ws.addRow(['DAY-1', 'aisha.bello@example.net', 'Aisha Bello', 'Early', '2026-10-12', 'Ex-warehouse lead']);
ws.addRow(['DAY-1', 'Ben.Kowalski@Example.net', 'Kowalski, Ben', 'Late', '2026-10-12', '']);
ws.addRow(['DAY-2', '', 'Carmen Diaz', 'Day', '2026-10-14', 'waiting on personal email']);
ws.addRow(['DAY-2', 'dev.patel@example.net', 'Dev Patel', 'Day', '2026-10-14', 'Has CDL-B']);
ws.addRow(['DAY-2', 'aisha.bello@example.net', 'Aisha Bello', 'Early', '2026-10-12', 'duplicate entry from recruiter']);
ws.addRow([]);
ws.addRow(['Total: 5 rows (4 unique people)']);
ws.getRow(4).font = { bold: true };
ws.columns.forEach((c) => (c.width = 24));
await wb.xlsx.writeFile(new URL('../fixtures/rosters/fleetwing-new-hires-demo.xlsx', import.meta.url).pathname);
console.log('wrote fixtures/rosters/fleetwing-new-hires-demo.xlsx');
