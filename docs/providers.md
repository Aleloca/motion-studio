# Provider

I provider sono servizi esterni che l'agente usa tramite strumenti MCP del server `studio`. L'agente non vede mai le chiavi: chiede a Motion Studio (il core) di chiamare il provider; il core legge la chiave, fa la chiamata e salva il risultato in `assets/`, registrandolo in `assets/assets.json`.

> Stato di verifica: i provider sono coperti da test con `fetch` simulato. Immagini, voce e stock non sono stati provati dal vivo con chiavi reali: i dettagli qui sotto descrivono il codice, non una garanzia sul comportamento dei servizi (modelli, prezzi e API cambiano).

## Dove stanno le chiavi
- Nel portachiavi del sistema (`@napi-rs/keyring`, servizio "Motion Studio", una voce per provider; su Linux Secret Service), impostate da **Impostazioni**.
- Oppure nelle variabili d'ambiente, che hanno la precedenza: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`.
- Le chiavi non finiscono nei file del progetto. Le variabili sono rimosse dall'ambiente dell'agente e del suo server MCP; i messaggi di errore dei provider sono ripuliti dalle chiavi (`redact`).
- Una chiave mancante produce l'errore "Configura la chiave <Provider> nelle Impostazioni di Motion Studio"; nella richiesta all'agente gli strumenti non configurati compaiono come "non configurato".

## Costi e conferme
`generate_image` e `tts` sono a pagamento: se l'opzione **Chiedi conferma prima di usare provider a pagamento** è attiva nelle Impostazioni (predefinito), ogni chiamata compare come richiesta nella pagina del lavoro (*Consenti una volta*, *Sempre per questo progetto*, *Nega*; senza risposta in 10 minuti viene negata). "Sempre" salva la regola `provider:openai-images`, `provider:tts-openai` o `provider:tts-elevenlabs` in `<progetto>/.studio/permissions.json`. La ricerca e il download di stock e i font non chiedono conferma (non sono a pagamento).

## Immagini: OpenAI gpt-image-2 (`generate_image`)
- Chiave: `OPENAI_API_KEY`. Modello `gpt-image-2`, uscita PNG.
- Parametri: `prompt`, `width`, `height`, `quality` (`low|medium|high|auto`), `background` (`transparent|opaque|auto`), `references` (fino a 16 immagini del progetto, png/jpg/webp, per la modifica), `name`.
- Le dimensioni vengono portate al formato supportato più vicino (multipli di 16, proporzioni tra 1:3 e 3:1, tra circa 0,65 e 8,3 megapixel, lato massimo 3840); se cambiano, la risposta lo segnala.
- Il file va in `assets/generated/`, con origine "generato" e tag `gpt-image-2`.

## Voce fuori campo: OpenAI TTS ed ElevenLabs (`tts`)
- Chiavi: `OPENAI_API_KEY` (modello `gpt-4o-mini-tts`, voce predefinita `marin`, testo fino a 4096 caratteri, istruzioni di tono facoltative) oppure `ELEVENLABS_API_KEY` (modello `eleven_multilingual_v2`, testo fino a 5000 caratteri; senza voce indicata usa la prima della lista dell'account).
- Se il provider non è indicato usa OpenAI quando la chiave c'è, altrimenti ElevenLabs.
- Formati `mp3` (predefinito) e `wav`; file in `assets/audio/`, con attribuzione "Voce generata con AI (<Provider>)".

## Foto e video stock: Pexels e Unsplash (`stock_search`, `stock_download`)
- Chiavi: `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`. Unsplash offre solo foto; i video vanno cercati su Pexels.
- Ricerca: `query`, `kind` (`photo|video`), `orientation`, `limit` (1–20). Download per `id`: file in `assets/stock/`.
- Attribuzione: ogni download registra il testo richiesto dal servizio (es. "Foto di <autore> su Pexels") nel campo `attribution` di `assets/assets.json`; per Unsplash il download notifica anche l'evento di download e il link sorgente contiene i parametri `utm`. Conserva l'attribuzione dove la licenza la richiede.
- Limite di 200 MB per file. Per i video Pexels sceglie l'mp4 più grande fino a 1920 px di larghezza.

## Font: Google Fonts (`fonts_fetch`)
- Nessuna chiave. Parametri: `family`, `weights` (multipli di 100, predefiniti 400 e 700), `italic`. File in `assets/fonts/`.
- Accetta solo file serviti da `fonts.gstatic.com`. Licenza OFL o Apache 2.0 (la risposta lo ricorda).

## Download dall'esterno: `download_file` (analisi brand)
Solo per l'analisi brand, la cui sandbox non ha rete: scarica un logo, un'immagine o un font da un sito in `assets/brand/` o `assets/fonts/` (estensioni di immagine e font, massimo 50 MB). Tutti i download di URL forniti dall'esterno (anche quelli dei provider) passano da `safe-fetch.ts`: indirizzi privati, locali o riservati sono rifiutati controllando gli IP risolti a ogni redirect, e la connessione avviene proprio verso l'indirizzo controllato. I provider accettano solo https.

## Come aggiungere un provider
1. **Modulo** in `packages/core/src/providers/<nome>.ts`: funzioni pure che ricevono `HttpDeps & { apiKey }` (`fetch`, `transport`, `lookup`) e usano `requestJson`/`requestBytes` di `http.ts` con `secrets: [apiKey]` (errori puliti dalle chiavi, limiti di dimensione). Per scaricare URL restituiti dal servizio usa `safeDownload`.
2. **Chiave**: aggiungi l'id in `PROVIDER_IDS` (`packages/shared`) e la variabile in `PROVIDER_ENV` (`secrets/vault.ts`); le variabili in `PROVIDER_ENV` vengono tolte automaticamente dall'ambiente dell'agente. Aggiungi la voce nelle Impostazioni della web app.
3. **Strumento bridge** in `packages/core/src/bridge/provider-tools.ts`: un handler in `providerTools` (valida gli argomenti, `allowed(c, '<tool>')`, `keyOf`, `confirmPaid` se costa, `saveGeneratedFile` e `register` per salvare e registrare l'asset) e una riga in `availableTools`.
4. **Autorizzazione per tipo di lavoro**: aggiungi il nome in `MCP_TOOLS` (`agent/launcher.ts`) per i lavori che possono usarlo.
5. **Schema MCP** in `packages/mcp-studio/src/server.mjs` (elenco `TOOLS`, con descrizione in italiano).
6. **Test** con `fetch` iniettato (vedi `openai-images.test.ts`, `stock.test.ts`, `provider-tools.test.ts`): mai chiamate di rete reali né chiavi vere.
