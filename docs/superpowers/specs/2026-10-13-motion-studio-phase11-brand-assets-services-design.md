# Motion Studio — Fase 11: Brand, asset e servizi esterni — Specifica

> **Fonti:**
> - programma `docs/superpowers/specs/2026-10-08-motion-studio-redesign-design.md` §2 (riga della Fase 11) e §6.4 (punti 10, 12, 13 del test visivo rimandati qui);
> - `docs/visual-test-2026-10-08.md`, punti 10, 12, 13 (font del sito, ricerca Google Fonts);
> - richieste dell'utente del 2026-10-09: effetti sonori e musica con ElevenLabs; scelta dei servizi esterni nel brief, richiamabili dalla chat; verifica delle chiavi e dei permessi al salvataggio;
> - decisione 90 del registro (endpoint di prova delle chiavi "da pianificare").
>
> **Decisioni prese in autonomia** dall'orchestratore (l'utente dorme e ha chiesto di procedere): voci 290–297 del registro. L'utente le rivede alla fine.

## 1. Perché

Oggi:
- i font del sito non vengono trovati: `WebFetch` trasforma l'HTML in testo e perde i CSS;
- aggiungere un font a mano obbliga a scrivere il nome e caricare il file negli Assets;
- l'analisi del brand mostra solo frasi libere, senza fasi;
- la libreria non riproduce audio e video, non mostra durate e non permette di rinominare;
- l'agente può fare voce e immagini, ma non musica né effetti sonori;
- i servizi a pagamento sono tutti o niente: il brief non dice quali usare;
- una chiave salvata non viene verificata, e l'utente scopre i permessi mancanti solo quando un turno fallisce.

## 2. Font

### 2.1 Ricerca Google Fonts dall'interfaccia

- Nella sezione Fonts del brand, "Add font" apre un pannello con un campo di ricerca sul catalogo di Google Fonts: nome, categoria (sans, serif, display, handwriting, mono), pesi disponibili, variabile sì/no.
- **Catalogo:** il core scarica `https://fonts.google.com/metadata/fonts` con `safeFetch`, lo valida, ne tiene solo i campi utili e lo mette in cache nella cartella di configurazione per 7 giorni. Se il catalogo non è raggiungibile o cambia forma, la ricerca degrada a "nome esatto": l'utente scrive la famiglia e il core la risolve con l'API `css2`, come fa già `fonts_fetch`.
- **Anteprima:** il core scarica un sottoinsieme minimo del font (`css2?…&text=<campione>`), lo mette in cache e lo serve alla UI dal proprio origin. La UI non carica mai risorse da Google.
- **Aggiunta:** si scelgono famiglia, pesi e corsivo; il core scarica i file (stessa logica di `fonts_fetch`) in `assets/fonts/`, li registra nella libreria con origine `google-fonts` e licenza OFL/Apache come attribuzione, e il brand riceve la voce font con il file collegato.

### 2.2 Font dai CSS del sito

- Nuovo strumento del core per l'analisi del brand, `inspect_site_fonts(url)`:
  - scarica la pagina con `safeFetch` (https, http solo se l'URL della fonte è http), al massimo 2 MB;
  - segue `<link rel=stylesheet>`, `@import` e `<style>` inline, fino a 20 fogli di stile da 2 MB ciascuno, solo sullo stesso sito o su CDN di font noti;
  - estrae le dichiarazioni `font-family` con i selettori che le usano (body, h1–h6, button…), le regole `@font-face` con i loro `src`, e i link a Google Fonts e Adobe Fonts;
  - risponde con un elenco strutturato: famiglia, ruoli probabili (heading/body), pesi usati, provenienza (`google`, `self-hosted`, `adobe`, `system`).
- Il prompt dell'analisi dice all'agente di usarlo per primo e poi:
  - famiglie Google: `fonts_fetch`;
  - font self-hosted: `download_file` in `assets/fonts/`, con la licenza sconosciuta segnalata nella proposta;
  - Adobe Fonts e font di sistema: solo il nome, senza file.

## 3. Analisi del brand: avanzamento

- `report_progress` accetta un campo facoltativo `phase` tra `reading`, `fonts`, `colors`, `logos`, `tone`, `writing`. Il core emette da solo `queued` e `done`.
- La UI mostra un passo per fase, con la fase corrente animata e le frasi dell'agente sotto. Nessuna percentuale inventata.
- Se l'agente non manda fasi, la UI si comporta come oggi.

## 4. Libreria degli asset

- **Riproduzione:** audio e video si ascoltano e si guardano nel pannello di dettaglio (player del kit UI, non controlli nativi). Le card audio mostrano una forma d'onda statica calcolata dal core con ffmpeg alla registrazione.
- **Metadati:** alla registrazione il core legge con il probe esistente durata, dimensioni e peso; le card li mostrano.
- **Rinomina:** nuova route di rinomina confinata in `assets/`, che aggiorna anche brand e riferimenti nel brief. Non tocca le versioni già salvate: le composizioni hanno copie proprie.
- **Ordinamento:** per data, nome, tipo e durata.
- **Origini:** si aggiunge `google-fonts`. I file generati portano `provider` e `model` come campi propri, non più solo come tag.
- **Genera dalla libreria:** un pulsante "Generate" apre un dialog per immagine, voce, effetto sonoro o musica. Lo esegue il core, senza agente. Prima di generare mostra il servizio e una stima del costo quando il servizio la rende nota, e chiede conferma con la stessa regola "Always" per progetto degli strumenti dell'agente.

## 5. Effetti sonori e musica (ElevenLabs)

- **Nuovi strumenti per l'agente,** con le regole della voce:
  - `sound_effect(prompt, durationSec?, loop?)`: endpoint ElevenLabs sound generation, durata da 0,5 a 30 s;
  - `music(prompt, durationSec, instrumental?)`: endpoint ElevenLabs music, durata da 10 a 300 s.
- Ogni uso chiede conferma (regole `provider:sfx-elevenlabs` e `provider:music-elevenlabs`, con "Always" per progetto). I file vanno in `assets/audio/`, con descrizione (il prompt), durata, loop, provider e modello.
- **Voci:** il core elenca le voci ElevenLabs dell'account (`GET /v2/voices`). L'utente può scegliere la voce del brand nelle impostazioni del brand, invece della "prima voce" arbitraria di oggi. Anche l'agente può elencarle, con un nuovo strumento gratuito `list_voices`.
- **Stile sonoro del brand:** nuova sezione del brand kit `sound` con:
  - genere;
  - energia (bassa, media, alta);
  - strumenti;
  - cose da evitare;
  - voce preferita (provider e id).

  Il prompt la passa all'agente, perché musica ed effetti restino coerenti.

## 6. Servizi esterni nel brief

- Il brief guadagna `services`: per **immagini**, **voce**, **musica** ed **effetti sonori** si sceglie una tra queste opzioni:
  - `auto`: l'agente decide tra i servizi configurati (comportamento di oggi);
  - un servizio preciso (immagini: `openai`, `stock`; voce: `openai`, `elevenlabs`; musica ed effetti: `elevenlabs`);
  - `none`: vietato per questa creatività.
- Valore predefinito: `auto` per tutto. Le creatività esistenti restano invariate.
- Il prompt riporta la scelta. Il **core la fa rispettare**: uno strumento vietato risponde con un rifiuto tradotto che l'agente riferisce, e uno strumento con un servizio diverso da quello scelto usa quello scelto.
- **Dalla chat, in qualsiasi momento:** un chip "Services" nel composer apre lo stesso selettore e salva il brief. Il turno successivo usa la nuova scelta. Se scrivere "usa ElevenLabs per la voce" basta all'agente, ma il brief dice `none`, l'agente risponde che il servizio è disattivato e indica il chip. L'agente non cambia mai il brief da solo.
- I servizi senza chiave sono mostrati disattivati, con il link alle impostazioni.

## 7. Verifica delle chiavi e dei permessi

- Al salvataggio di una chiave, e con un pulsante "Test" in ogni riga, il core prova la chiave con chiamate di sola lettura e senza costo. Il risultato è per **capacità**:

| Servizio | Prova | Capacità riportate |
|---|---|---|
| OpenAI | `GET /v1/models`, poi `GET /v1/models/<modello>` per i modelli usati | chiave valida; immagini (gpt-image); voce (TTS) |
| ElevenLabs | `GET /v1/user` | chiave valida; lettura account |
| ElevenLabs | `GET /v2/voices?page_size=1` | elenco voci |
| ElevenLabs | — | sintesi vocale, effetti sonori, musica: "non verificabile senza generare" |
| Pexels | `GET /v1/search?query=test&per_page=1` | ricerca |
| Unsplash | `GET /search/photos?query=test&per_page=1` | ricerca |

- Gli esiti possibili sono: `ok`, `missing` (401/403 su quella prova: permesso mancante, con il nome del permesso da attivare), `unverified` e `error` (rete, 5xx).
- Per le chiavi ElevenLabs con permessi ristretti, la UI elenca i permessi da attivare per ogni funzione di Motion Studio. La tabella sta nella documentazione e nel catalogo.
- Il primo uso reale di una capacità `unverified` aggiorna l'esito: un 401/403 la segna `missing`, un successo la segna `ok`. L'esito sta solo in memoria nel core e non si salva mai su disco con la chiave.
- La chiave non compare mai in log, eventi o risposte. Si applicano le regole esistenti (`redact`, `cleanSecret`).

## 8. Fuori perimetro

- Altri provider di musica o immagini (Suno, Stability, Runway…): la struttura li permette, ma non si aggiungono in questa fase.
- Generazione video da provider esterni.
- Varianti, localizzazione e pacchetti App Store (Fase 12); interazione con l'agente mentre lavora (Fase 13).
- Font Adobe: solo il nome, nessun download.

## 9. Verifica

- Test unitari e di route con `fetch` finto per ogni chiamata ai provider: nessuna chiamata reale nei test.
- Parser dei CSS: fixture ostili (fogli enormi, `@import` ricorsivi, redirect verso indirizzi privati, URL `data:`) con letture limitate.
- Verifica dal vivo con un core usa e getta: ricerca e aggiunta di un Google Font, analisi di un sito reale con `inspect_site_fonts` (haiku), dialog Generate e rifiuto di un servizio `none`, sempre con un vault in memoria e senza chiavi reali. Le chiamate ElevenLabs reali restano non provate, come per i provider esistenti (`docs/providers.md`), salvo che l'utente lo chieda con le sue chiavi.
