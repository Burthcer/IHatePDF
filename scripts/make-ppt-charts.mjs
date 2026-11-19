// Chart test deck (pptxgenjs writes standard chart parts); PowerPoint's own PDF of it is the reference:
//   node scripts/make-ppt-charts.mjs && (open in PowerPoint, SaveCopyAs pdf via scripts/ref-pdf.ps1)
import PptxGenJS from 'pptxgenjs';
const p = new PptxGenJS();
const labels = ['Q1', 'Q2', 'Q3', 'Q4'];
const data = [{ name: 'North', labels, values: [12, 19, 8, 15] }, { name: 'South', labels, values: [7, 11, 14, 9] }];
let s = p.addSlide(); s.addText('Clustered columns', { x: 0.5, y: 0.2, w: 9, h: 0.5, fontSize: 20 });
s.addChart(p.charts.BAR, data, { x: 0.5, y: 0.8, w: 9, h: 4.5, barDir: 'col', showLegend: true, legendPos: 'b', showTitle: true, title: 'Sales by quarter', showValue: true });
s = p.addSlide(); s.addChart(p.charts.BAR, data, { x: 0.5, y: 0.5, w: 9, h: 4.8, barDir: 'bar', barGrouping: 'stacked', showLegend: true, legendPos: 'r' });
s = p.addSlide(); s.addChart(p.charts.LINE, data, { x: 0.5, y: 0.5, w: 9, h: 4.8, showLegend: true, legendPos: 'b', lineDataSymbol: 'circle', chartColors: ['C0392B', '2980B9'] });
s = p.addSlide(); s.addChart(p.charts.PIE, [{ name: 'Share', labels: ['A', 'B', 'C', 'D'], values: [40, 25, 20, 15] }], { x: 1, y: 0.5, w: 8, h: 4.8, showLegend: true, legendPos: 'r', showPercent: true, showTitle: true, title: 'Market share' });
s = p.addSlide(); s.addChart(p.charts.AREA, data, { x: 0.5, y: 0.5, w: 9, h: 4.8, showLegend: true, legendPos: 'b' });
await p.writeFile({ fileName: 'test-fixtures/pptx-real/charts.pptx' });
