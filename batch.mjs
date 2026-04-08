#!/usr/bin/env node
// ── Batch-PDF-Erzeugung für Hoffmann-Referenzanalyse ─────────────────
//
// Verarbeitet einen SQL-Export (eine große CSV mit allen Analyten gemischt)
// und erzeugt für jeden Analyten ein PDF.
//
// Installation (einmalig):
//   npm install puppeteer
//
// ── SQL-Export-Format ────────────────────────────────────────────────
// Semikolon-getrennte CSV, erste Zeile = Header.
// Pflicht-Spalten: kuerzel, strerg
// Alle anderen Spalten (auftid, labordatum, geschlecht, ...) werden ignoriert.
//
//   auftid;labordatum;geschlecht;alter_jahre;alter_tage;verfahrennr;kuerzel;strerg
//   10001;2024-01-15;m;45;16436;1;Na;140,2
//   10002;2024-01-15;w;62;22645;1;Na;138,7
//   10003;2024-01-15;m;38;13880;2;CRP;1,4
//
// ── Konfig-Format (optional) ─────────────────────────────────────────
// Semikolon-getrennte CSV, erste Zeile = Header.
// Fehlende Analyten: name=kuerzel, unit='', log=0 (linear)
//
//   kuerzel;name;unit;log
//   Na;Natrium;mmol/L;0
//   K;Kalium;mmol/L;0
//   CRP;C-reaktives Protein;mg/L;1
//   TSH;Thyreoidea-stim. Hormon;mU/L;1
//
// ── Aufruf ───────────────────────────────────────────────────────────
//   node batch.mjs export.csv
//   node batch.mjs export.csv --config=analyten.csv
//   node batch.mjs export.csv --config=analyten.csv --outdir=reports

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Hilfsfunktion: Separator automatisch erkennen + Header parsen ────
function detectSeparator(line) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  for (const c of line) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseHeader(line) {
  // BOM entfernen, Separator erkennen, alles lowercase
  const clean = line.replace(/^\uFEFF/, '').trim();
  const sep = detectSeparator(clean);
  return { headers: clean.split(sep).map(h => h.trim().toLowerCase()), sep };
}

// ── Konfig-Datei laden ───────────────────────────────────────────────
// Gibt Map zurück: kuerzel → { name, unit, log }
function loadConfig(configFile) {
  const config = new Map();
  if (!configFile) return config;

  if (!fs.existsSync(configFile)) {
    if (configArg) {
      // Explizit angegeben aber nicht gefunden → Fehler
      console.error(`Konfig-Datei nicht gefunden: ${configFile}`);
      process.exit(1);
    }
    // Standard-Pfad nicht vorhanden → ohne Konfig weitermachen
    console.log('Konfig:  (keine gefunden — Kürzel als Name, linear, keine Einheit)\n');
    return config;
  }

  const lines = fs.readFileSync(configFile, 'utf-8').trim().split('\n');
  const { headers, sep: configSep } = parseHeader(lines[0]);

  const iKuerzel = headers.indexOf('kuerzel');
  const iName    = headers.indexOf('name');
  const iUnit    = headers.indexOf('unit');
  const iLog     = headers.indexOf('log');

  if (iKuerzel === -1) {
    console.error('Konfig-Datei: Spalte "kuerzel" fehlt.');
    process.exit(1);
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(configSep);
    const kuerzel = parts[iKuerzel]?.trim();
    if (!kuerzel) continue;
    config.set(kuerzel, {
      name: iName  >= 0 ? parts[iName]?.trim()  || kuerzel : kuerzel,
      unit: iUnit  >= 0 ? parts[iUnit]?.trim()  || ''      : '',
      log:  iLog   >= 0 ? parts[iLog]?.trim() === '1'      : false,
    });
  }

  console.log(`Konfig geladen: ${config.size} Analyt(en) konfiguriert.`);
  return config;
}

// ── SQL-Export einlesen und nach kuerzel gruppieren ──────────────────
function loadExport(exportFile) {
  const text = fs.readFileSync(exportFile, 'utf-8');
  const lines = text.trim().split('\n');

  const { headers, sep: exportSep } = parseHeader(lines[0]);
  const iKuerzel = headers.indexOf('kuerzel');
  const iStrerg  = headers.indexOf('strerg');

  if (iKuerzel === -1) { console.error(`Export: Spalte "kuerzel" fehlt. Gefundene Spalten: ${headers.join(', ')}`); process.exit(1); }
  if (iStrerg  === -1) { console.error(`Export: Spalte "strerg" fehlt. Gefundene Spalten: ${headers.join(', ')}`);  process.exit(1); }

  const grouped = new Map(); // kuerzel → number[]
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(exportSep);
    const kuerzel = parts[iKuerzel]?.trim();
    const raw     = parts[iStrerg]?.trim().replace(',', '.');
    if (!kuerzel || !raw) continue;

    const v = Number(raw);
    if (!isFinite(v) || isNaN(v)) { skipped++; continue; }

    if (!grouped.has(kuerzel)) grouped.set(kuerzel, []);
    grouped.get(kuerzel).push(v);
  }

  if (skipped > 0) console.warn(`${skipped} Zeilen mit ungültigem strerg übersprungen.`);
  return grouped;
}

// ── Hauptprogramm ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const inputArg    = args.find(a => !a.startsWith('--'));
  const configArg   = args.find(a => a.startsWith('--config='));
  const outdirArg   = args.find(a => a.startsWith('--outdir='));
  const outdir      = outdirArg ? outdirArg.split('=')[1] : 'output';

  // Eingabedateien standardmäßig im input/-Ordner suchen
  const inputFile  = inputArg
    ? path.resolve(inputArg)
    : path.resolve(__dirname, 'input', 'export.csv');

  const configFile = configArg
    ? path.resolve(configArg.split('=')[1])
    : path.resolve(__dirname, 'input', 'analyten.csv');

  console.log(`Export:  ${inputFile}`);
  console.log(`Konfig:  ${configFile}`);

  if (!fs.existsSync(inputFile)) {
    console.error(`\nExport-Datei nicht gefunden: ${inputFile}`);
    console.error('Entweder Datei unter input/export.csv ablegen oder Pfad als Argument übergeben:');
    console.error('  node batch.mjs pfad/zur/export.csv [--config=pfad/zur/analyten.csv]');
    process.exit(1);
  }

  const config  = loadConfig(configFile);
  const grouped = loadExport(inputFile);

  // Analyten zusammenstellen
  const analytes = [];
  for (const [kuerzel, values] of grouped) {
    const cfg = config.get(kuerzel) || { name: kuerzel, unit: '', log: false };
    // Anzeigename: "Klartext-Name (Kürzel)" — oder nur Kürzel wenn Name == Kürzel
    const displayName = cfg.name !== kuerzel
      ? `${cfg.name} (${kuerzel})`
      : kuerzel;

    if (values.length < 20) {
      console.warn(`"${displayName}": Nur ${values.length} Werte — übersprungen (min. 20)`);
      continue;
    }
    analytes.push({ kuerzel, displayName, unit: cfg.unit, log: cfg.log, values });
  }

  // Alphabetisch sortieren
  analytes.sort((a, b) => a.kuerzel.localeCompare(b.kuerzel));

  if (analytes.length === 0) {
    console.error('Keine gültigen Analyten gefunden (alle < 20 Werte?).');
    process.exit(1);
  }

  console.log(`\n${analytes.length} Analyt(en) zur Verarbeitung. Starte Batch...\n`);

  // Ausgabeverzeichnis
  const outPath = path.resolve(outdir);
  fs.mkdirSync(outPath, { recursive: true });

  // HTML-Datei
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

  let success = 0, failed = 0;

  for (let i = 0; i < analytes.length; i++) {
    const a = analytes[i];
    const tag = `[${i + 1}/${analytes.length}]`;
    process.stdout.write(`${tag} ${a.displayName} (${a.values.length} Werte)... `);

    try {
      const page = await browser.newPage();

      const params = new URLSearchParams({
        name: a.displayName,
        unit: a.unit,
        log:  a.log ? '1' : '0',
        data: a.values.join(',')
      });

      await page.goto(`${fileUrl}?${params.toString()}`, {
        waitUntil: 'networkidle0', timeout: 30000
      });
      await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 800));

      const safeName = a.kuerzel.replace(/[^a-zA-Z0-9äöüÄÖÜß_\-]/g, '_');
      const pdfPath  = path.join(outPath, `${safeName}.pdf`);
      const htmlOut  = path.join(outPath, `${safeName}.html`);

      // PDF erzeugen
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
      });

      // HTML speichern (Originaldaten sind im #originalData-div eingebettet,
      // beim Öffnen wird die Analyse automatisch daraus neu gestartet)
      const htmlContent = await page.content();
      fs.writeFileSync(htmlOut, htmlContent, 'utf-8');

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
