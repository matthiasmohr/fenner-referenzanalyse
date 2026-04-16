# Hoffmann Referenzbereich-Analyse

Werkzeug zur Schätzung von Referenzintervallen aus Routinelabordaten nach dem **Hoffmann-Verfahren** (Hoffmann RG, 1963).

---

## Was ist das Hoffmann-Verfahren?

Klassisch ermittelt man Referenzbereiche, indem man eine gesunde Referenzpopulation rekrutiert, deren Messwerte bestimmt und daraus das 2,5.–97,5. Perzentil berechnet. Das ist aufwändig.

Das **Hoffmann-Verfahren** nutzt stattdessen bereits vorhandene Routinelabordaten — also die Gesamtheit aller Messwerte, die im Laboralltag anfallen, inklusive Patienten mit pathologischen Werten. Der Trick: In dieser Mischung aus gesunden und kranken Probanden bildet die gesunde Referenzpopulation einen **normalverteilten Kern**. Dieser lässt sich statistisch von den pathologischen Ausreißern trennen.

> Hoffmann RG. *Statistics in the Practice of Medicine.*
> JAMA 185(11):864–873, 1963.

---

## Wie funktioniert es — Schritt für Schritt

### 1. Wahrscheinlichkeitsnetz (Hoffmann-Plot)

Alle Messwerte werden sortiert und auf sogenanntem **Normalwahrscheinlichkeitspapier** aufgetragen:

- **X-Achse:** Der Messwert selbst
- **Y-Achse:** Das zugehörige **Normalquantil (z-Wert)**, berechnet aus der kumulierten Rang-Position des Wertes

Die Rang-Position wird nach der **Blom-Formel** berechnet:

```
p_i = (i − 0,375) / (n + 0,25)
```

Der z-Wert ergibt sich daraus durch die **Umkehrfunktion der Normalverteilung** (Probit-Transformation):

```
z_i = Φ⁻¹(p_i)
```

### 2. Was sieht man im Plot?

Wenn ein Teil der Daten **normalverteilt** ist (die gesunden Probanden), erscheinen diese Punkte im Wahrscheinlichkeitsnetz als **gerade Linie**. Pathologische Werte — Patienten mit Hypo- oder Hypernatriämie, stark erhöhten Entzündungswerten usw. — weichen davon ab und **knicken** an den Rändern weg:

```
z  │         · · (Hypernatriämie — knickt nach oben ab)
   │       /
   │      /  ← gerader Abschnitt = Referenzpopulation
   │     /
   │ · · (Hyponatriämie — knickt nach unten ab)
   └────────────────── Messwert
```

### 3. Lineare Regression im geraden Abschnitt

Durch den geraden Abschnitt wird eine **Regressionsgerade** gelegt:

```
z = a + b · x
```

Aus Steigung `b` und Achsenabschnitt `a` lassen sich unmittelbar die Parameter der zugrunde liegenden Normalverteilung ableiten:

| Größe | Formel |
|---|---|
| Mittelwert μ | `−a / b` |
| Standardabweichung σ | `1 / b` |
| Untere Referenzgrenze (2,5. Pz.) | `(−1,96 − a) / b` |
| Obere Referenzgrenze (97,5. Pz.) | `( 1,96 − a) / b` |

### 4. Auto-Detektion des linearen Abschnitts

Das kritische und ursprünglich **visuelle** Element des Verfahrens — das Identifizieren des geraden Abschnitts — wird hier analytisch durch einen **iterativen Trimm-Algorithmus** gelöst:

1. Starte mit dem mittleren 90 % der Daten (grobe Entfernung extremer Ausreißer)
2. Berechne die lineare Regression und das Bestimmtheitsmaß **R²**
3. Prüfe: Verbessert sich R², wenn der linke Randpunkt entfernt wird? Oder wenn der rechte entfernt wird?
4. Entferne den Randpunkt, der R² stärker verbessert
5. Wiederhole, bis R² ≥ 0,9985 oder weniger als 30 % der Daten übrig sind

Das ist die rechnerische Entsprechung von: *„Ich lege visuell eine Gerade durch den geraden Teil der Kurve."* Der Algorithmus stellt dabei keine Annahmen über Perzentil-Grenzen auf — er findet den linearen Abschnitt selbst.

### 5. Manuelle Nachkorrektur per Drag

Nach der Auto-Detektion kann der identifizierte Abschnitt **interaktiv verfeinert** werden: Die orangefarbenen Grenzlinien im Plot sind ziehbar. Die Regression und alle Kennzahlen aktualisieren sich sofort.

---

## Benutzung

1. **Daten eingeben:** Messwerte einfügen (Komma, Semikolon, Zeilenumbruch oder Leerzeichen als Trennzeichen)
2. **Analyt und Einheit** benennen (z.B. „Natrium", „mmol/L")
3. **Log-Transformation** aktivieren bei rechtsschiefen Analyten (TSH, CRP, Ferritin, Triglyzeride …)
4. **„Analyse starten"** — Auto-Detektion läuft automatisch
5. Grenzlinien im Plot bei Bedarf per Drag nachkorrigieren
6. **„Protokoll drucken"** für die Dokumentation

### Qualitätskriterium R²

| R² | Bewertung |
|---|---|
| ≥ 0,99 | Sehr gute Linearität — Ergebnis zuverlässig |
| 0,95–0,99 | Akzeptabel — ggf. Grenzlinien nachkorrigieren |
| < 0,95 | Schlechte Linearität — bimodale Verteilung prüfen, Log-Transformation erwägen |

### Mindestdatenmenge

Laut CLSI EP28-A3c werden für die indirekte Methode mindestens **120 Messwerte** empfohlen. Das Werkzeug gibt eine Warnung aus, wenn weniger Daten vorliegen.

---

## Batch-Verarbeitung (`batch.mjs`)

Der Batch-Job erzeugt automatisch PDFs (und HTML-Dateien) für alle Analyten aus einem SQL-Export.

### Voraussetzung (einmalig)

```bash
npm install
```

### Aufruf

```bash
# Standardpfade: input/export.csv + input/analyten.csv → output/
node batch.mjs

# Eigene Export-Datei
node batch.mjs export.csv

# Eigene Export- und Konfig-Datei
node batch.mjs export.csv --config=analyten.csv

# Ausgabeverzeichnis festlegen
node batch.mjs export.csv --config=analyten.csv --outdir=reports
```

| Argument | Beschreibung | Standard |
|---|---|---|
| `[export.csv]` | Pfad zur CSV-Exportdatei aus dem LIS | `input/export.csv` |
| `--config=<Datei>` | Pfad zur Analyten-Konfiguration | `input/analyten.csv` |
| `--outdir=<Verzeichnis>` | Ausgabeverzeichnis für PDFs und HTML | `output/` |

### Eingabedateien

**Export-CSV** (Pflicht-Spalten: `kuerzel`, `strerg`):
```
auftid;labordatum;geschlecht;alter_jahre;alter_tage;verfahrennr;kuerzel;strerg;messplatz_kuerzel
10001;2024-01-15;m;45;16436;1;Na;140,2;COBAS1
```

**Analyten-Konfiguration** (`input/analyten.csv`, optional):
```
kuerzel;name;unit;log;geschlecht;alter_tage_von;alter_tage_bis
Na;Natrium;mmol/L;0;;;
Hb;Hämoglobin Männer;g/dL;0;m;;
CRP;CRP Erwachsene;mg/L;1;;6570;
```

Ohne Konfig-Datei werden alle Kürzel aus dem Export ohne Filter und ohne Einheit verarbeitet.

### Ausgabe

Für jeden Analyten (je Geschlecht, Altersgruppe und Gerät) entstehen im Ausgabeverzeichnis:
- `<kuerzel>[_m|_w][_<alter>d-<alter>d][_<gerät>].pdf`
- gleichnamige `.html`-Datei

Analyten mit weniger als 20 Messwerten werden übersprungen.

---

## Technische Hinweise

- **Keine Installation, keine Abhängigkeiten** — reines HTML/JavaScript, läuft im Browser
- **Keine Datenspeicherung** — alle Berechnungen erfolgen lokal im Browser, es werden keine Daten übertragen
- **Probit-Transformation:** Numerische Näherung nach Peter Acklam (Fehler < 1,15 × 10⁻⁹)
- **Diagramme:** Chart.js 4.4 + chartjs-plugin-annotation 3.0
- **Drucken:** Browserdruckfunktion, druckoptimiertes CSS

---

## Abgrenzung und Grenzen des Verfahrens

- Das Hoffmann-Verfahren ist eine **indirekte** Methode. Es setzt voraus, dass ein wesentlicher Anteil der Routinedaten von gesunden Probanden stammt.
- Bei stark pathologisch geprägten Kollektiven (z.B. reines Intensivpatienten-Kollektiv) ist das Verfahren **nicht geeignet**.
- Bimodale oder multimodale Verteilungen (z.B. geschlechtsspezifische Unterschiede ohne Trennung) können zu falschen Ergebnissen führen.
- Das Ergebnis sollte mit **bekannten Referenzbereichen** aus der Literatur plausibilisiert werden.
