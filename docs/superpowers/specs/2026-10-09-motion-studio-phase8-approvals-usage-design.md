# Motion Studio — Fase 8: Approvazioni e consumi — Specifica

> Programma: `docs/superpowers/specs/2026-10-08-motion-studio-redesign-design.md` §2. Punti del test visivo: 3, 5, 7, 8, 24, 27, 30 (`docs/visual-test-2026-10-08.md`), più le richieste "Consumo di token e costi" e "Traduttore dei comandi".

## 1. Perché

Il problema più sentito nel test visivo è il **punto 30**, a priorità massima. Una creatività ha chiesto 5 o più conferme (installazione di pacchetti, render, controllo del render, manifest) e un'analisi del brand ne ha chieste 4. L'utente ha chiesto: "dovrò approvarli OGNI volta?".

Due cause:
- Claude Code chiede conferma anche in sandbox per i comandi composti: prefissi di variabili, `time`, pipe, `;`, `rm -rf`, `pkill` (punto 24);
- i lavori brand e di descrizione hanno `autoAllowBashIfSandboxed: false` (punti 5, 7 e 8).

Quando una richiesta arriva, poi, la scheda mostra il comando grezzo senza dire cosa fa (punto 3).

Infine, i consumi sono invisibili: il core legge solo `total_cost_usd` e non lo usa da nessuna parte.

## 2. Obiettivi

1. **Approvazione automatica dei comandi in sandbox**, attiva di default: si chiede all'utente solo ciò che esce dal perimetro.
2. **Spiegazione dei comandi** deterministica, in linguaggio chiaro, nelle schede di approvazione e nei dettagli dell'attività.
3. **Token e costo** per lavoro, versione, creatività, progetto e settimana, con un contatore in tempo reale.
4. **Output leggeri** (punto 27): indicazioni di codifica all'agente e un avviso quando un file supera il peso ragionevole per il canale.

## 3. Approvazione automatica

### 3.1 Prerequisito di sicurezza (verifica dal vivo, bloccante)

Approvare in automatico non riduce la sicurezza **solo se** un comando approvato dal nostro `approve` gira comunque nella sandbox. Prima di qualsiasi altro lavoro su questa parte si verifica dal vivo con Claude Code vero, modello Haiku, config, workspace e progetto temporanei, che:
- un comando Bash che passa da `approve` e viene approvato:
  - **non** riesce a scrivere in una cartella temporanea fuori dal progetto, creata apposta e scelta fuori dall'elenco delle scritture consentite dalla sandbox;
  - **non** riesce a raggiungere un dominio fuori dall'elenco;
- con `dangerouslyDisableSandbox: true` nell'input, il comando gira comunque in sandbox (`allowUnsandboxedCommands: false`);
- i comandi composti del punto 24 (`time …`, `VAR=… cmd`, pipe, `;`) passano davvero da `approve`. Si annota la forma esatta dell'input ricevuto, compresi `description` e altri campi.

Se una di queste verifiche fallisce, l'approvazione automatica **non** si implementa: l'esecutore si ferma e riferisce all'orchestratore.

### 3.2 Comportamento

- **Impostazione** di workspace `autoApproveSandboxed: boolean`, default `true`. Oggi non esistono impostazioni per singolo progetto. Sta in Project settings → Agent and approvals, insieme alle altre impostazioni condivise ("Shared by every project"), con il testo del prototipo:
  - titolo: "Approve sandboxed commands automatically";
  - descrizione: "Commands that stay inside this project, with no internet, run without asking. You still decide on files outside the project, paid services and new websites."
- **Quando è attiva** e il lavoro gira in sandbox (`sandboxMode: 'auto'` e sandbox disponibile):
  - `autoAllowBashIfSandboxed: true` per **tutti** i tipi di lavoro: creatività, brand, descrizione, console;
  - `approve` risponde `allow` senza chiedere all'utente quando sono vere **tutte** queste condizioni:
    - `tool_name === 'Bash'`;
    - il lavoro è registrato come in sandbox: il flag si aggiunge alla registrazione del bridge;
    - `input.dangerouslyDisableSandbox !== true`.
  - Restano invariati e continuano a chiedere: Edit/Write/Read fuori dal progetto, WebFetch, provider a pagamento, strumenti sconosciuti. La rete fuori dall'elenco è già negata dalla sandbox senza passare da `approve`.
- **Quando è disattivata:** `autoAllowBashIfSandboxed: false` per tutti i tipi, e ogni Bash fuori dalle regole "Always" chiede conferma. È ciò che dice il prototipo: "Every command will ask for your OK".
- **Senza sandbox** (`sandboxMode: 'off'` o sandbox non disponibile): l'impostazione non ha effetto. L'interruttore appare disattivato con il motivo "Needs agent isolation", e si torna al comportamento attuale.
- **Trasparenza.** Ogni comando approvato in automatico produce un evento dell'agente `auto_approved { toolName, command, explanation }`:
  - registrato nella conversazione, nel log del brand e nei log dei job come gli altri eventi;
  - visibile in "Activity details" con la spiegazione (§4);
  - nella conversazione, il riepilogo di fine turno dice quanti comandi sono stati approvati in automatico: "8 commands ran automatically in the sandbox", con il link ad Activity details.
- Si annota nel registro delle decisioni che i lavori brand, pur leggendo pagine web non fidate, ora eseguono Bash senza conferma. Il motivo per cui resta accettabile: sandbox senza rete, scrittura limitata al progetto, file di configurazione protetti.

## 4. Spiegazione dei comandi

### 4.1 Modulo

Il modulo `packages/shared/src/explain/` è puro TypeScript, senza dipendenze e deterministico, quindi lo usano sia il core sia il web.

```ts
explainTool(toolName: string, input: unknown, ctx: { projectDir: string; workDir?: string; home: string }): Explanation
interface Explanation {
  summary: Phrase[];            // one phrase per simple command, in order (max 6, then "and N more steps")
  indicators: Indicator[];      // de-duplicated, sorted by risk
  risk: 'low' | 'medium' | 'high';
  parsed: boolean;              // false when the command could not be analyzed reliably
}
interface Phrase { key: string; params: Record<string, string | number> }   // rendered from the i18n catalogs
interface Indicator { id: IndicatorId; risk: 'low' | 'medium' | 'high'; params?: Record<string, string> }
```

### 4.2 Analisi di Bash

Un tokenizzatore shell **prudente**:
- gestisce virgolette singole e doppie, escape, `;`, `&&`, `||`, `|`, `&`, redirezioni (`>`, `>>`, `2>&1`, `<`), prefissi `VAR=val`, `time`, `cd dir &&`, `env`, `nohup`, `sudo`;
- produce una lista di comandi semplici `{ argv, redirects, env }`;
- se incontra `$(…)`, backtick, heredoc, `eval`, `bash -c`/`sh -c` o virgolette sbilanciate, imposta `parsed: false`, aggiunge l'indicatore `complex` (rischio medio) e mostra la frase generica "Runs a complex shell command". Non tenta mai di indovinare.

### 4.3 Dizionario

Per ogni comando noto ci sono una frase e gli indicatori. Almeno questi:
- **file:** `ls`, `cat`, `head`, `tail`, `file`, `wc`, `mkdir`, `cp`, `mv`, `rm`, `touch`, `chmod`, `ln`, `find`, `du`, `tar`, `unzip`, `zip`;
- **media:** `ffmpeg`, `ffprobe`, `sips`, `convert`/`magick`, `cwebp`, `dwebp`, `rsvg-convert`, `optipng`, `pngquant`, `gifsicle`;
- **Python:** `python`/`python3` (script, `-c`, `-m pip`, `-m venv`), `pip`/`pip3`;
- **Node:** `node`, `npm`/`npx`/`pnpm`/`yarn` (install/run/exec);
- **rete:** `curl`, `wget`, `git` (clone/status/diff/add/commit), `brew`, `apt`/`apt-get`;
- **processi:** `kill`, `pkill`, `killall`, `sleep`, `echo`/`printf`, `jq`, `sed`, `awk`, `grep`, `sort`, `xargs`;
- **sistema:** `open`, `sudo`, `time`.

Esempi di frase:
- `pip install pillow numpy` → "Installs Python packages: pillow, numpy";
- `rm -rf .venv` → "Deletes .venv".

I comandi non riconosciuti producono "Runs `<cmd>`" più l'indicatore `unknown-command` (rischio medio).

### 4.4 Indicatori

| id | rischio | quando |
|---|---|---|
| `deletes-files` | medio, **alto** se fuori dal progetto o con un percorso ricorsivo verso la home o la radice | rm, find -delete |
| `installs-packages` | medio | pip/npm/pnpm/yarn/brew/apt install |
| `uses-network` | medio | curl, wget, git clone/pull/push, install di pacchetti |
| `kills-processes` | medio | kill, pkill, killall |
| `writes-outside-project` | alto | argomenti di destinazione o redirezioni fuori dal progetto |
| `reads-outside-project` | medio | argomenti di lettura fuori dal progetto e fuori dalla cartella temporanea |
| `runs-code` | basso | python/node che eseguono uno script del progetto |
| `elevated` | alto | sudo |
| `changes-git` | medio | git commit/reset/checkout/push |
| `complex` | medio | `parsed: false` |
| `unknown-command` | medio | comando fuori dal dizionario |
| `outside-sandbox` | alto | `dangerouslyDisableSandbox: true` |

**Percorsi.** Un percorso relativo si risolve rispetto alla cartella di lavoro dell'agente (da verificare: la cwd del processo `claude`) e si classifica come `work` (cartella `work/` della creatività), `project`, `tmp` o `outside`. `~` e `$HOME` vengono espansi.

### 4.5 Strumenti diversi da Bash

- Edit/Write → "Edits `<file>`" con `writes-outside-project` se il file è fuori dal progetto;
- Read → "Reads `<file>`";
- WebFetch → "Opens `<host>`" con `uses-network`;
- provider → frase del provider (esistente);
- altro → "Uses `<tool>`".

### 4.6 Nella scheda di approvazione

Dall'alto verso il basso:
1. la frase o le frasi di riepilogo come titolo, che sostituisce "Run a command";
2. le chip degli indicatori colorate per rischio (basso neutro, medio warn, alto rosso con icona). Il colore non è l'unico segnale: c'è anche un'icona o un prefisso testuale;
3. se l'input contiene `description`, il **motivo dichiarato dall'agente** come citazione in grigio: "The agent says: …", al massimo 300 caratteri. Non sostituisce mai le righe 1 e 2;
4. "Show command" (Fase 7, invariato).

Il core calcola la spiegazione e la aggiunge ad `ApprovalRequest` (`explanation`, `agentReason`). Il web la mostra con i cataloghi, così cambiare lingua aggiorna i testi.

**Fuori perimetro:** riassunto tramite un modello piccolo (Haiku) per i comandi sconosciuti; si valuterà in futuro.

## 5. Token e costi

### 5.1 Lettura

`claude-stream-parser` legge:
- dall'evento `result`: `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `modelUsage` (per modello: token e `costUSD`), `total_cost_usd`, `duration_ms`, `num_turns`;
- dagli eventi `assistant`: `message.usage`, per il contatore in tempo reale. Lo stesso `message.id` può ripetersi su più eventi, quindi si tiene l'ultimo valore per id.

Le forme esatte si verificano su un output reale in stream-json di Claude Code, catturato con Haiku nella verifica del §3.1, e si aggiunge un campione anonimizzato ai fixture.

### 5.2 Eventi e registro

- Nuovo `AgentEvent` `usage { live: boolean; tokens: TokenCounts; costUsd: number | null; models?: ModelUsage[] }`:
  - `live: true` durante il lavoro, con stima progressiva;
  - `live: false` alla fine, con i valori dell'evento `result`.
- `TokenCounts = { input; output; cacheRead; cacheWrite }`. Il **totale mostrato** è `input + output + cacheWrite`. `cacheRead` si mostra a parte in "Details", perché le letture dalla cache costano molto meno e gonfierebbero il numero.
- **Registro per progetto:** `<project>/.studio/usage.jsonl`, in sola aggiunta e protetto dall'agente come il resto di `.studio/`. Una riga per esecuzione di `claude`:

  ```json
  { "at": "…", "jobId": "…", "kind": "creative|brand-analysis|describe|console", "creativeSlug": "…|null", "version": 3, "attempt": 1, "tokens": {…}, "costUsd": 0.42, "models": […], "durationMs": 81234, "outcome": "ok|error|cancelled" }
  ```

  Le righe malformate si saltano in lettura.
- `VersionEntry.usage?: { tokens; costUsd }`: somma dei tentativi della versione (giro di correzione compreso). `BrandProposal.usage?` è uguale. I campi sono facoltativi, quindi i file vecchi restano validi.
- Un lavoro annullato o fallito registra comunque quanto consumato fin lì, se il `result` è arrivato. Altrimenti registra l'ultima stima live con `estimated: true`.

### 5.3 Abbonamento o API

`doctor` (o `auth status --json`) ricava il metodo di accesso, abbonamento Claude o chiave API. La verifica avviene sui **nomi dei campi**, senza stampare valori personali come email od organizzazione.
- **Abbonamento:** "This counts toward your Claude plan. At API prices it would be about $X."
- **Chiave API:** "$X".
- **Metodo sconosciuto:** "Estimated at API prices: $X".

Il costo è sempre secondario rispetto ai token.

### 5.4 Interfaccia

Le parti del prototipo da portare sono `Tokens` in `app.js`, il footer del centro attività e la `UsageCard` in `settings.js`.

- **Barra in alto:** pulsante ghost mono "38.2k tokens" con i token di **oggi** dell'intero workspace, che apre Settings → Usage. Si aggiorna dal vivo con gli eventi `usage`. Con zero si legge "0 tokens", senza nasconderlo.
- **Centro attività:**
  - footer "Today · 38.2k tokens" con il link Usage;
  - le righe Running mostrano i token live;
  - le righe Done mostrano i token del lavoro.
- **Creatività:**
  - nella chat, la card della versione mostra "38k tokens · $0.42" con un tooltip che scompone i valori;
  - il menu delle versioni mostra i token per versione;
  - la barra della creatività mostra un contatore live durante il lavoro;
  - il totale della creatività sta nella scheda Brief o nel menu.
- **Brand:** la card dell'analisi e l'elenco "Analyses" mostrano i token per analisi.
- **Settings → Usage** (nuova sezione, rotta `#/settings/usage`):
  - barre degli ultimi 7 giorni con oggi in accento;
  - totale della settimana;
  - ripartizione per progetto e per tipo di lavoro (creatività, brand, descrizioni);
  - riga abbonamento/API (§5.3);
  - "Tracked since <data del primo record>". Non si ricostruiscono i consumi passati.
- **New creative:** "Similar creatives used about N–M k tokens", solo se ci sono almeno 3 prime generazioni registrate nel workspace, calcolato come mediana e quartili. Altrimenti la riga non c'è.

### 5.5 API

`GET /api/usage?from=<iso>&to=<iso>&project=<slug>` restituisce:
- i totali;
- `byDay[]`;
- `byProject[]`;
- `byKind[]`;
- `trackedSince`;
- `billing: 'subscription' | 'api' | 'unknown'`.

Il calcolo avviene dai registri dei progetti, con una cache in memoria invalidata dalle nuove righe.

## 6. Output leggeri (punto 27)

- **Catalogo dei formati:** campo facoltativo `maxFileMB` per i formati video (valori ragionevoli per canale, documentati con la fonte o con il motivo) e `targetBitrate` come indicazione.
- **Prompt di consegna:** indicazioni di codifica:
  - video H.264 `yuv420p`, CRF 18–23, `+faststart`, AAC 128k se c'è audio;
  - immagini PNG ottimizzate o JPEG di qualità 85–90.
- **Validazione:** un file sopra `maxFileMB` produce un **avviso** (non un problema bloccante, quindi niente giro di correzione e niente token in più). L'avviso compare sulla tavola e nella card della versione: "Large file: 78 MB (recommended ≤ 8 MB for Instagram)". Lo stesso dato si salva negli output della versione.

## 7. Fuori perimetro

- Riassunto dei comandi sconosciuti con un modello.
- Strumento MCP `validate_brand_proposal` (punto 8): con l'approvazione automatica non serve più.
- Ricostruzione dei consumi passati.
- Limiti di spesa o budget.

## 8. Verifica

- La verifica dal vivo del §3.1 si documenta in `docs/decisions-log.md` con i risultati, senza dati personali.
- Test unitari estesi per il tokenizzatore e il dizionario:
  - una tabella di almeno 80 comandi reali, compresi tutti quelli del test visivo;
  - casi ostili, cioè comandi costruiti per ingannare la spiegazione.
- Test del core:
  - auto-allow solo con le tre condizioni;
  - impostazione disattivata;
  - assenza di sandbox;
  - `dangerouslyDisableSandbox`;
  - evento `auto_approved`;
  - registro dei consumi, con righe malformate e lavori annullati;
  - API usage.
- Prova dal vivo finale con Haiku: una creatività piccola e un'analisi del brand su un sito di esempio. Si contano le approvazioni chieste: l'obiettivo è **zero** per i comandi in sandbox, con i consumi registrati.
