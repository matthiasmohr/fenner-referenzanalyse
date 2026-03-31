#!/usr/bin/env node
// ── Batch-PDF-Erzeugung für Hoffmann-Referenzanalyse ─────────────────
//
// Liest eine CSV-Datei mit Analyten und deren Messwerten ein und erzeugt
// für jeden Analyten ein PDF über die Hoffmann-Analyse.
//
// Installation (einmalig):
//   npm install puppeteer
//
// CSV-Format (Semikolon-getrennt, da Dezimalkomma möglich):
//   name;unit;log;values
//   Natrium;mmol/L;0;135;137;140;142;138;...
//   CRP;mg/L;1;0.5;1.2;3.4;0.8;...
//
//   Spalte 1: Analytname
//   Spalte 2: Einheit
//   Spalte 3: Log-Transformation (0 oder 1)
//   Spalte 4+: Messwerte (alle weiteren Spalten = Werte)
//
// Alternativ: JSON-Format (siehe unten)
//
// Aufruf:
//   node batch.mjs eingabe.csv                    # CSV-Datei
//   node batch.mjs eingabe.json                   # JSON-Datei
//   node batch.mjs eingabe.csv --outdir=reports   # Ausgabeverzeichnis
//
// Ausgabe: Ein PDF pro Analyt im Verzeichnis ./output/ (oder --outdir)
//
// JSON-Format:
//   [
//     { "name": "Natrium", "unit": "mmol/L", "log": false, "values": [135, 137, ...] },
//     { "name": "CRP",     "unit": "mg/L",   "log": true,  "values": [0.5, 1.2, ...] }
//   ]

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CSV parsen ───────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  const analytes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    // Erste Zeile mit "name" überspringen (Header)
    if (i === 0 && line.toLowerCase().startsWith('name')) continue;

    const parts = line.split(';');
    if (parts.length < 4) {
      console.warn(`Zeile ${i + 1} übersprungen (zu wenige Spalten): ${line.substring(0, 60)}...`);
      continue;
    }

    const name = parts[0].trim();
    const unit = parts[1].trim();
    const log  = parts[2].trim() === '1';
    const values = parts.slice(3)
      .map(v => v.trim().replace(',', '.'))
      .filter(v => v !== '')
      .map(Number)
      .filter(v => !isNaN(v) && isFinite(v));

    if (values.length < 20) {
      console.warn(`"${name}": Nur ${values.length} gültige Werte — übersprungen (min. 20)`);
      continue;
    }

    analytes.push({ name, unit, log, values });
  }

  return analytes;
}

// ── JSON parsen ──────────────────────────────────────────────────────
function parseJSON(text) {
  const data = JSON.parse(text);
  return data.filter(a => {
    if (!a.values || a.values.length < 20) {
      console.warn(`"${a.name}": Nur ${a.values?.length || 0} Werte — übersprungen`);
      return false;
    }
    return true;
  }).map(a => ({
    name: a.name || 'Analyt',
    unit: a.unit || '',
    log: !!a.log,
    values: a.values.map(Number).filter(v => !isNaN(v) && isFinite(v))
  }));
}

// ── Hauptprogramm ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const inputFile = args.find(a => !a.startsWith('--'));
  const outdirArg = args.find(a => a.startsWith('--outdir='));
  const outdir = outdirArg ? outdirArg.split('=')[1] : 'output';

  if (!inputFile) {
    console.error('Aufruf: node batch.mjs <eingabe.csv|eingabe.json> [--outdir=output]');
    console.error('');
    console.error('CSV-Format (Semikolon-getrennt):');
    console.error('  name;unit;log;wert1;wert2;wert3;...');
    console.error('  Natrium;mmol/L;0;135;137;140;142;...');
    console.error('  CRP;mg/L;1;0.5;1.2;3.4;...');
    console.error('');
    console.error('JSON-Format:');
    console.error('  [{"name":"Natrium","unit":"mmol/L","log":false,"values":[135,137,...]}]');
    process.exit(1);
  }

  const text = fs.readFileSync(inputFile, 'utf-8');
  const isJSON = inputFile.toLowerCase().endsWith('.json');
  const analytes = isJSON ? parseJSON(text) : parseCSV(text);

  if (analytes.length === 0) {
    console.error('Keine gültigen Analyten in der Eingabedatei gefunden.');
    process.exit(1);
  }

  console.log(`${analytes.length} Analyt(en) geladen. Starte Batch-Verarbeitung...\n`);

  // Ausgabeverzeichnis erstellen
  const outPath = path.resolve(outdir);
  fs.mkdirSync(outPath, { recursive: true });

  // HTML-Datei-Pfad
  const htmlPath = path.resolve(__dirname, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error(`index.html nicht gefunden: ${htmlPath}`);
    process.exit(1);
  }
  const fileUrl = `file://${htmlPath}`;

  // Browser starten
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let success = 0;
  let failed = 0;

  for (let i = 0; i < analytes.length; i++) {
    const a = analytes[i];
    const tag = `[${i + 1}/${analytes.length}]`;
    process.stdout.write(`${tag} ${a.name} (${a.values.length} Werte)... `);

    try {
      const page = await browser.newPage();

      // URL mit Parametern bauen
      const params = new URLSearchParams({
        name: a.name,
        unit: a.unit,
        log: a.log ? '1' : '0',
        data: a.values.join(',')
      });
      const url = `${fileUrl}?${params.toString()}`;

      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Warten bis Analyse fertig (resultsSection sichtbar)
      await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: 10000 });

      // Kurz warten damit Charts vollständig gerendert sind
      await new Promise(r => setTimeout(r, 800));

      // PDF erzeugen
      const safeName = a.name.replace(/[^a-zA-Z0-9äöüÄÖÜß_\-]/g, '_');
      const pdfPath = path.join(outPath, `${safeName}.pdf`);

      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
      });

      console.log(`✓ → ${pdfPath}`);
      success++;

      await page.close();
    } catch (err) {
      console.log(`✗ Fehler: ${err.message}`);
      failed++;
    }
  }

  await browser.close();

  console.log(`\n── Fertig ──────────────────────────`);
  console.log(`  Erfolgreich: ${success}`);
  if (failed > 0) console.log(`  Fehlgeschlagen: ${failed}`);
  console.log(`  Ausgabe: ${outPath}/`);
}

main().catch(err => {
  console.error('Fataler Fehler:', err);
  process.exit(1);
});
