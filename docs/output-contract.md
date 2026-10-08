# Contratto di output

Il contratto descrive cosa l'agente deve consegnare al termine di ogni turno di una creatività e come Motion Studio lo controlla. Il testo che l'agente legge sta in `.studio/context.md` di ogni progetto (generato da `packages/core/src/project-template.ts`); il controllo è in `packages/core/src/creatives/output-contract.ts`, lo schema del manifest in `packages/shared/src/creative.ts`.

## Struttura delle cartelle

```
<progetto>/creatives/<data-titolo>/
  work/                 spazio di lavoro dell'agente: sorgenti, script, dipendenze locali
  outputs/v1/           consegna della versione 1
    <id-preset>.<ext>   un file per ogni formato richiesto
    manifest.json
    .previews/          poster dei video generati da Motion Studio (non scrivere qui)
  outputs/v2/ ...
```

Ogni turno scrive in una cartella `outputs/vN/` nuova (la cartella esatta è indicata nella richiesta all'agente). I file si chiamano `<id-preset>.<estensione>`, per esempio `instagram-reel-9x16.mp4`; gli id vengono dal catalogo formati del workspace (`.studio/presets/formats.json`, modificabile dall'interfaccia).

## manifest.json

```json
{
  "schemaVersion": 1,
  "files": [
    { "format": "instagram-reel-9x16", "file": "instagram-reel-9x16.mp4", "width": 1080, "height": 1920, "durationSec": 15 },
    { "format": "instagram-image-1x1", "file": "instagram-image-1x1.png", "width": 1080, "height": 1080 }
  ],
  "tools": ["remotion"],
  "renderCommand": "npx remotion render Main ../outputs/v1/instagram-reel-9x16.mp4"
}
```

- `schemaVersion`: sempre `1`.
- `files[]`: `format` (id del preset), `file` (solo il nome, senza sottocartelle né `/` o `\`; `.` e `..` non ammessi), `width` e `height` (interi positivi), `durationSec` (numero positivo, facoltativo: solo per i video).
- `tools`: elenco di stringhe, predefinito vuoto.
- `renderCommand`: facoltativo; il comando da eseguire in `work/` per rigenerare gli output. Viene riportato in una riga (senza caratteri di controllo, massimo 300 caratteri) quando si aggiungono formati.

Un manifest corrotto non viene mai riscritto da Motion Studio.

## Regole di validazione

Dopo ogni turno `validateOutputs` controlla ogni formato richiesto nel brief. I messaggi sono quelli che l'agente riceve (e che compaiono nella versione come "problemi"):

| Situazione | Messaggio |
|---|---|
| Manifest assente | `manifest.json mancante in <cartella>` |
| Manifest illeggibile o non conforme allo schema | `manifest.json non valido: <dettaglio>` |
| Id non presente nel catalogo | `Preset sconosciuto: <id> (non è nel catalogo formati)` |
| Formato non nel manifest | `Manca il formato <canale> · <nome> (<id>)` |
| File indicato assente o non regolare (un link simbolico non vale) | `File non trovato per <id>: <file>` |
| Estensione non ammessa dal preset | `<file>: estensione .<ext> non ammessa per <id> (ammesse: …)` |
| File oltre il peso massimo del preset | `<file>: <x> MB, massimo <y> MB` |
| Con ffmpeg/ffprobe: file non leggibile | `<file>: file non leggibile come media` |
| Risoluzione diversa dal preset | `<file>: risoluzione <w>×<h>, attesa <W>×<H>` |
| Video senza durata rilevabile | `<file>: non sembra un video` |
| Durata oltre il massimo del preset | `<file>: durata <d>s oltre il massimo di <m>s` |
| Durata lontana da quella del brief (scarto oltre il maggiore tra 1 s e il 10%) | `<file>: durata <d>s, richiesta circa <t>s` |

Con ffprobe disponibile larghezza, altezza e durata sono quelle misurate (non quelle dichiarate) e l'output risulta "verificato"; per i video viene anche estratto un poster in `.previews/<file>.jpg`. Senza ffprobe si usano i valori del manifest e l'output è mostrato come "non verificato". Per le immagini la durata è sempre ignorata.

## Tentativi di correzione

Se ci sono problemi, Motion Studio riavvia l'agente (nella stessa sessione) con l'elenco dei problemi e chiede di riconsegnare nella stessa cartella aggiornando il manifest. I tentativi sono al massimo 3 in totale (il primo turno più due correzioni). Fanno eccezione i problemi di soli preset sconosciuti: l'agente non può risolverli, quindi non si ritenta. Al termine la versione viene salvata come **completa** (nessun problema) o **incompleta** (problemi rimasti, elencati nella versione), sempre con un commit git.

## Strumento MCP `validate_output`

Nei turni di creatività l'agente può chiamare `validate_output` (server MCP `studio`, senza parametri) per eseguire lo stesso controllo sulla versione corrente prima di chiudere il turno; restituisce `outputs` e `problems`, ma non salva nulla e non conta come tentativo. Fuori dalle creatività risponde "Validazione disponibile solo nelle creatività".

## Esportazione

Gli output di una versione si copiano con **Esporta…** con i nomi `<slug>-<formato>-vN.<ext>`, senza sovrascrivere e rifiutando le cartelle dentro il workspace. I file non esportabili sono segnalati come saltati. Vedi il README.
