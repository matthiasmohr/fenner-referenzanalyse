#!/usr/bin/env node
// ── Batch-PDF-Erzeugung für Hoffmann-Referenzanalyse ─────────────────
//
// Installation (einmalig):
//   npm install puppeteer
//
// ── SQL-Export-Format ────────────────────────────────────────────────
// Semikolon-getrennte CSV, erste Zeile = Header.
// Pflicht-Spalten: kuerzel, strerg
// Optional:        geschlecht (m/w), alter_tage, messplatz_kuerzel
//
//   auftid;labordatum;geschlecht;alter_jahre;alter_tage;verfahrennr;kuerzel;strerg;messplatz_kuerzel
//   10001;2024-01-15;m;45;16436;1;Na;140,2;COBAS1
//
// ── Konfig-Format (input/analyten.csv) ───────────────────────────────
// Jede Zeile = eine Analyse = ein PDF.
// Mehrere Zeilen mit gleichem kuerzel = mehrere Gruppen-PDFs.
//
// Pflicht:  kuerzel
// Optional: name, unit, log, geschlecht, alter_tage_von, alter_tage_bis
//
//   kuerzel;name;unit;log;geschlecht;alter_tage_von;alter_tage_bis
//   Na;Natrium;mmol/L;0;;;
//   Hb;Hämoglobin Männer;g/dL;0;m;;
//   Hb;Hämoglobin Frauen;g/dL;0;w;;
//   CRP;CRP Neugeborene <28d;mg/L;1;;0;27
//   CRP;CRP Säuglinge 28d-1J;mg/L;1;;28;364
//   CRP;CRP Erwachsene;mg/L;1;;6570;
//
//   geschlecht:     m | w | leer = alle
//   alter_tage_von: Untergrenze in Tagen (inklusiv), leer = kein Limit
//   alter_tage_bis: Obergrenze in Tagen (inklusiv), leer = kein Limit
//
// ── Aufruf ───────────────────────────────────────────────────────────
//   node batch.mjs                                    # input/export.csv + input/analyten.csv
//   node batch.mjs export.csv
//   node batch.mjs export.csv --config=analyten.csv
//   node batch.mjs export.csv --config=analyten.csv --outdir=reports

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Hilfsfunktionen ──────────────────────────────────────────────────

function detectSeparator(line) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  for (const c of line) if (c in counts) counts[c]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseHeader(line) {
  const clean = line.replace(/^\uFEFF/, '').trim();
  const sep = detectSeparator(clean);
  return { headers: clean.split(sep).map(h => h.trim().toLowerCase()), sep };
}

// Alter in Tagen → lesbarer String (für Anzeigenamen)
function formatAlterTage(tage) {
  if (tage == null) return null;
  if (tage < 28)   return `${tage} Tage`;
  if (tage < 365)  return `${Math.round(tage / 30.44)} Monate (${tage}d)`;
  const jahre = tage / 365.25;
  return jahre % 1 < 0.05 || jahre % 1 > 0.95
    ? `${Math.round(jahre)} Jahre`
    : `${jahre.toFixed(1)} Jahre`;
}

// Altersbereich → Suffix für Dateinamen (immer Tage)
function alterSuffix(von, bis) {
  if (von == null && bis == null) return '';
  const v = von != null ? `${von}d` : '0d';
  const b = bis != null ? `${bis}d` : 'plus';
  return `_${v}-${b}`;
}

// Altersbereich → lesbarer String für Anzeigenamen
function formatAlterRange(von, bis) {
  const vStr = von != null ? formatAlterTage(von) : null;
  const bStr = bis != null ? formatAlterTage(bis) : null;
  if (!vStr && !bStr) return '';
  if (!vStr) return `bis ${bStr}`;
  if (!bStr) return `ab ${vStr}`;
  return `${vStr} – ${bStr}`;
}

// ── Konfig-Datei laden ───────────────────────────────────────────────
// Gibt Array von Einträgen zurück (mehrere pro kuerzel möglich)
function loadConfig(configFile, configArgGiven) {
  if (!fs.existsSync(configFile)) {
    if (configArgGiven) {
      console.error(`Konfig-Datei nicht gefunden: ${configFile}`);
      process.exit(1);
    }
    console.log('Konfig:  (keine gefunden — Kürzel als Name, linear, keine Filter)\n');
    return null; // null = keine Konfig
  }

  const lines = fs.readFileSync(configFile, 'utf-8').trim().split('\n');
  const { headers, sep } = parseHeader(lines[0]);

  const iKuerzel  = headers.indexOf('kuerzel');
  const iName     = headers.indexOf('name');
  const iUnit     = headers.indexOf('unit');
  const iLog      = headers.indexOf('log');
  const iGeschl   = headers.indexOf('geschlecht');

  // alter_tage_von / alter_tage_bis (Tage) oder alter_von / alter_bis (Jahre)
  let iAlterVon = headers.indexOf('alter_tage_von');
  let iAlterBis = headers.indexOf('alter_tage_bis');
  let alterInJahren = false;
  if (iAlterVon === -1 && iAlterBis === -1) {
    iAlterVon = headers.indexOf('alter_von');
    iAlterBis = headers.indexOf('alter_bis');
    if (iAlterVon >= 0 || iAlterBis >= 0) {
      alterInJahren = true;
      console.log('Konfig: Spalten "alter_von"/"alter_bis" erkannt → Werte als Jahre, Umrechnung in Tage (×365).');
    }
  }

  if (iKuerzel === -1) {
    console.error('Konfig-Datei: Spalte "kuerzel" fehlt.');
    process.exit(1);
  }

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split(sep);

    const kuerzel    = p[iKuerzel]?.trim();
    if (!kuerzel) continue;

    const name       = iName     >= 0 ? p[iName]?.trim()     || kuerzel : kuerzel;
    const unit       = iUnit     >= 0 ? p[iUnit]?.trim()     || ''      : '';
    const log        = iLog      >= 0 ? p[iLog]?.trim() === '1'         : false;
    const geschlecht = iGeschl   >= 0 ? p[iGeschl]?.trim()  || ''      : '';
    const vonRaw     = iAlterVon >= 0 ? p[iAlterVon]?.trim() || ''      : '';
    const bisRaw     = iAlterBis >= 0 ? p[iAlterBis]?.trim() || ''      : '';
    const vonNum     = vonRaw !== '' ? parseInt(vonRaw, 10) : null;
    const bisNum     = bisRaw !== '' ? parseInt(bisRaw, 10) : null;
    const alterVon   = vonNum != null && alterInJahren ? vonNum * 365 : vonNum;
    const alterBis   = bisNum != null && alterInJahren ? bisNum * 365 : bisNum;

    entries.push({ kuerzel, name, unit, log, geschlecht, alterVon, alterBis });
  }

  console.log(`Konfig geladen: ${entries.length} Einträge (${new Set(entries.map(e=>e.kuerzel)).size} Analyt(en)).`);
  return entries;
}

// ── SQL-Export einlesen ──────────────────────────────────────────────
// Gibt Array von Zeilen zurück: { kuerzel, wert, geschlecht, alterTage, messplatz }
function loadExport(exportFile) {
  const text  = fs.readFileSync(exportFile, 'utf-8');
  const lines = text.trim().split('\n');

  const { headers, sep } = parseHeader(lines[0]);
  const iKuerzel   = headers.indexOf('kuerzel');
  const iStrerg    = headers.indexOf('strerg');
  const iGeschl    = headers.indexOf('geschlecht');
  const iAlterTage = headers.indexOf('alter_tage');
  const iMessplatz = headers.indexOf('messplatz_kuerzel');

  if (iKuerzel === -1) { console.error(`Export: Spalte "kuerzel" fehlt. Spalten: ${headers.join(', ')}`); process.exit(1); }
  if (iStrerg  === -1) { console.error(`Export: Spalte "strerg" fehlt.  Spalten: ${headers.join(', ')}`); process.exit(1); }

  if (iGeschl    === -1) console.warn('Export: Spalte "geschlecht" fehlt — Geschlechts-Filter nicht möglich.');
  if (iAlterTage === -1) console.warn('Export: Spalte "alter_tage" fehlt — Alters-Filter nicht möglich.');
  if (iMessplatz >= 0)   console.log('Export: Spalte "messplatz_kuerzel" erkannt — Aufteilung nach Gerät.');

  const rows = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split(sep);

    const kuerzel = p[iKuerzel]?.trim();
    const raw     = p[iStrerg]?.trim().replace(',', '.');
    if (!kuerzel || !raw) continue;

    const wert = Number(raw);
    if (!isFinite(wert) || isNaN(wert)) { skipped++; continue; }

    const geschlecht = iGeschl    >= 0 ? p[iGeschl]?.trim().toLowerCase()    || '' : '';
    const alterTage  = iAlterTage >= 0 ? parseInt(p[iAlterTage]?.trim(), 10) : null;
    const messplatz  = iMessplatz >= 0 ? p[iMessplatz]?.trim()               || '' : '';

    rows.push({ kuerzel, wert, geschlecht, alterTage, messplatz });
  }

  const nAnalyten = new Set(rows.map(r => r.kuerzel)).size;
  const nGeraete  = iMessplatz >= 0 ? new Set(rows.map(r => r.messplatz).filter(Boolean)).size : 0;
  console.log(`Export geladen: ${rows.length} Zeilen, ${nAnalyten} Analyt(en)${nGeraete ? `, ${nGeraete} Gerät(e)` : ''}.${skipped ? ` (${skipped} ungültige Werte ignoriert)` : ''}`);
  return rows;
}

// ── Zeilen nach Gruppe filtern ───────────────────────────────────────
function filterRows(rows, kuerzel, geschlecht, alterVon, alterBis, messplatz) {
  return rows
    .filter(r => {
      if (r.kuerzel !== kuerzel) return false;
      if (geschlecht && geschlecht !== '*' && r.geschlecht && r.geschlecht !== geschlecht) return false;
      if (alterVon != null && r.alterTage != null && r.alterTage < alterVon) return false;
      if (alterBis != null && r.alterTage != null && r.alterTage > alterBis) return false;
      if (messplatz && r.messplatz && r.messplatz !== messplatz) return false;
      return true;
    })
    .map(r => r.wert);
}

// Alle Messplätze für ein Kürzel ermitteln
function getMessplaetze(rows, kuerzel) {
  const set = new Set();
  for (const r of rows) {
    if (r.kuerzel === kuerzel && r.messplatz) set.add(r.messplatz);
  }
  return [...set].sort();
}

// ── Hauptprogramm ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const inputArg   = args.find(a => !a.startsWith('--'));
  const configArg  = args.find(a => a.startsWith('--config='));
  const outdirArg  = args.find(a => a.startsWith('--outdir='));
  const outdir     = outdirArg ? outdirArg.split('=')[1] : 'output';

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
    console.error('Datei unter input/export.csv ablegen oder Pfad als Argument übergeben.');
    process.exit(1);
  }

  const configEntries = loadConfig(configFile, !!configArg);
  const exportRows    = loadExport(inputFile);

  // ── Analysen zusammenstellen ─────────────────────────────────────
  const jobs = [];

  // Gibt es Messplatz-Daten im Export?
  const hatMessplaetze = exportRows.some(r => r.messplatz);

  // Hilfsfunktion: Jobs für ein Kürzel + Konfig-Eintrag + Messplatz-Liste erzeugen
  function createJobs(entry, messplaetze) {
    const baseName = entry.name !== entry.kuerzel
      ? `${entry.name} (${entry.kuerzel})`
      : entry.kuerzel;

    const gruppenTeile = [];
    if (entry.geschlecht && entry.geschlecht !== '*')
      gruppenTeile.push(entry.geschlecht === 'm' ? 'Männer' : entry.geschlecht === 'w' ? 'Frauen' : entry.geschlecht);
    const alterStr = formatAlterRange(entry.alterVon, entry.alterBis);
    if (alterStr) gruppenTeile.push(alterStr);

    const geschlSuffix = (entry.geschlecht && entry.geschlecht !== '*') ? `_${entry.geschlecht}` : '';
    const alterSfx = alterSuffix(entry.alterVon, entry.alterBis);
    const kuerzelSafe = entry.kuerzel.replace(/[^a-zA-Z0-9äöüÄÖÜß_\-]/g, '_');

    for (const mp of messplaetze) {
      const values = filterRows(exportRows, entry.kuerzel, entry.geschlecht, entry.alterVon, entry.alterBis, mp);

      const teile = [...gruppenTeile];
      if (mp) teile.push(`Gerät ${mp}`);

      const displayName = teile.length
        ? `${baseName} — ${teile.join(', ')}`
        : baseName;

      const mpSuffix = mp ? `_${mp.replace(/[^a-zA-Z0-9äöüÄÖÜß_\-]/g, '_')}` : '';
      const safeName = kuerzelSafe + geschlSuffix + alterSfx + mpSuffix;

      jobs.push({ displayName, safeName, unit: entry.unit, log: entry.log, values });
    }
  }

  if (configEntries) {
    for (const entry of configEntries) {
      // Pro Konfig-Zeile: über alle Messplätze aufteilen (oder [''] wenn keine)
      const messplaetze = hatMessplaetze
        ? getMessplaetze(exportRows, entry.kuerzel)
        : [''];
      createJobs(entry, messplaetze);
    }
  } else {
    // Keine Konfig: alle Kürzel ohne Filter
    const kuerzels = [...new Set(exportRows.map(r => r.kuerzel))].sort();
    for (const kuerzel of kuerzels) {
      const entry = { kuerzel, name: kuerzel, unit: '', log: false, geschlecht: '', alterVon: null, alterBis: null };
      const messplaetze = hatMessplaetze
        ? getMessplaetze(exportRows, kuerzel)
        : [''];
      createJobs(entry, messplaetze);
    }
  }

  // Zu wenige Werte aussortieren
  const valid = [];
  for (const job of jobs) {
    if (job.values.length < 20) {
      console.warn(`"${job.displayName}": Nur ${job.values.length} Werte — übersprungen (min. 20)`);
    } else {
      valid.push(job);
    }
  }

  if (valid.length === 0) {
    console.error('\nKeine Analysen mit ausreichend Werten (≥ 20) gefunden.');
    process.exit(1);
  }

  console.log(`\n${valid.length} Analyse(n) zur Verarbeitung. Starte Batch...\n`);

  // ── Ausgabe ───────────────────────────────────────────────────────
  const outPath  = path.resolve(outdir);
  fs.mkdirSync(outPath, { recursive: true });

  const htmlPath = path.resolve(__dirname, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error(`index.html nicht gefunden: ${htmlPath}`);
    process.exit(1);
  }
  const fileUrl = `file://${htmlPath}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let success = 0, failed = 0;

  for (let i = 0; i < valid.length; i++) {
    const a   = valid[i];
    const tag = `[${i + 1}/${valid.length}]`;
    process.stdout.write(`${tag} ${a.displayName} (n=${a.values.length})... `);

    try {
      const page = await browser.newPage();

      const params = new URLSearchParams({
        name: a.displayName,
        unit: a.unit,
        log:  a.log ? '1' : '0',
        data: a.values.join(',')
      });

      await page.goto(`${fileUrl}?${params.toString()}`, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 800));

      const pdfPath = path.join(outPath, `${a.safeName}.pdf`);
      const htmlOut = path.join(outPath, `${a.safeName}.html`);

      await page.pdf({
        path: pdfPath, format: 'A4', printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
      });

      const htmlContent = await page.content();
      fs.writeFileSync(htmlOut, htmlContent, 'utf-8');

      console.log(`✓ → ${a.safeName}.pdf`);
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
