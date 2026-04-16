select
    --v.kuerzel || '-' || m.kuerzel AS kuerzelmitmessplatz,
    --e.auftid,
    la.labordatum,
    g.geschlecht,
    floor(months_between(la.labordatum, la.gebdat) / 12) as alter_jahre,
    (la.labordatum - la.gebdat) as alter_tage,
    --e.verfahrennr,
    v.kuerzel,
    v.bezeichnung,
    v.dimension,
    e.strerg
    --m.kuerzel as messplatz_kuerzel,
    --lb.kuerzel as laborbereich_kuerzel

from ergebnisse e
left join verfahren v on e.verfahrennr=v.verfahrennr and e.labordatum >= v.versionab and e.labordatum <= v.versionbis
left join labauft la on e.auftid = la.auftid
left join geschlechter g on la.geschlechtnr = g.geschlechtnr
left join auftunt au on e.untid = au.untid
left join messplaetze m on au.messplatznr = m.messplatznr and e.labordatum >= m.versionab and e.labordatum <= m.versionbis
left join laborbereiche lb on m.laborbereichnr = lb.laborbereichnr

where 1=1
--and e.verfahrennr=549 
and v.kuerzel in ('AP', 'AMY', 'BILI', 'CK', 'FE', 'FERR', 'GGT', 'GOT', 'HS', 'HST', 'LACT', 'LDH', 'MG', 'NA', 'K', 'CL', 'PO4', 'GES', 'TRAF')
and lb.kuerzel in ('EIL', 'AKK')
and e.ergebnistypid=1 --Messwert
and e.jahr in (2025, 2026)
and la.speziesnr=254 --Mensch
and la.storniert=0 --Testaufträge oder stornierte Ergebnisse sind raus
and g.spracheid=1 --Sprache deutsch

order by e.auftid
;
