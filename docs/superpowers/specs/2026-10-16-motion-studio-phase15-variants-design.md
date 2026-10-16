# Motion Studio — Fase 15: Varianti creative — Specifica

> **Fonti:**
> - note dell'utente del 2026-10-16, dopo il secondo giro di prove:
>   - **nota 1:** le proposte del logo devono valere anche per favicon e icona app, raggruppate per variante;
>   - **nota 4:** varianti per tutti i formati, scelta finale mescolando le varianti, varianti scartate nascoste con "Mostra scartate";
> - brainstorming con l'utente del 2026-10-16: tutte le scelte di questo documento sono state confermate dall'utente in chat;
> - modello attuale:
>   - versioni `vN` per creatività;
>   - `exportPicks` (★ per formato → versione);
>   - istanze `<preset>@k`;
>   - proposte del logo come istanze (decisione 731);
>   - `creative.json`, `outputs/vN/`, `conversation.jsonl`, la coda e la sessione fermata nella cartella di configurazione del core.

## 1. Perché

Per un lavoro creativo è più utile vedere più direzioni affiancate che correggerne una sola alla volta. Oggi le proposte multiple esistono solo per il logo "da zero", e non arrivano a favicon e icona app. L'utente vuole poter:
- generare più varianti di qualunque creatività;
- scegliere per ogni formato la proposta migliore, anche da varianti diverse;
- mettere da parte le varianti che non servono.

## 2. Modello

- **Variante = una direzione creativa per tutti i formati.** La variante B ha il suo 16:9, la sua story e il suo quadrato, coerenti tra loro. Per l'identità, il logo, la favicon e l'icona app della variante B nascono dalla stessa idea.
- **Ogni variante è una creatività figlia di un gruppo:**
  - ha chat, versioni, editor, render, traduzioni, commenti, coda e Stop propri, che funzionano come oggi;
  - la creatività esistente diventa la **variante A**: la cartella non si sposta e i nomi di esportazione non cambiano;
  - le altre varianti sono creatività sorelle `creatives/<nome>~b` … `~e`, per un massimo di **5 varianti**.
- **I dati del gruppo stanno nel `creative.json` della variante A**, nel campo additivo `variantGroup`:
  - `members[]`, con `{ slug, letter, direction, directionSource: 'agent'|'user', status: 'active'|'discarded', createdAt }`;
  - `picks`, cioè formato → `{ slug, version }` (la ★ di gruppo);
  - `layout`, cioè `'variant'|'format'`.
- **Collegamento delle sorelle:** ogni sorella ha `variantOf: <slug della A>` nel proprio `creative.json`.
- **Il campo `exportPicks` attuale resta** per una creatività senza varianti. Con le varianti valgono i `picks` del gruppo.
- **Brief comune:**
  - il brief, i formati, le etichette, le lingue e i servizi sono uguali per tutto il gruppo;
  - modificarli dalla UI aggiorna tutte le varianti attive;
  - ogni variante aggiunge solo la propria `direction`;
  - una variante al lavoro riceve il brief nuovo al turno successivo, mai a metà turno.
- **Elenco delle creatività:** un solo elemento per gruppo, con il segno "N varianti". Le sorelle non compaiono da sole.
- **Compatibilità:** una creatività senza `variantGroup` è un gruppo di una sola variante. La UI la mostra come oggi, senza selettore né interruttore.

## 3. Generazione

- **Nuova creatività:**
  - nuovo campo **Varianti**, da 1 a 5, predefinito 1;
  - da 2 in su, un campo facoltativo "direzione" per ogni variante.
- **Direzioni:**
  - per le direzioni che l'utente non ha scritto, prima della generazione gira un turno breve dell'agente che non crea file. L'agente propone direzioni chiaramente diverse tra loro e da quelle già date, una riga ciascuna, e le consegna con uno strumento MCP dedicato (`submit_variant_directions`), senza scrivere file;
  - le direzioni dell'utente hanno sempre la precedenza;
  - si possono modificare in seguito: una direzione modificata vale dal turno successivo di quella variante.
- **Turni delle varianti:**
  - ogni variante parte come una creatività normale, con brief comune, propria direzione e le direzioni delle altre varianti come riferimento ("non copiarle");
  - girano al massimo **2 varianti alla volta**, e le altre aspettano in coda con il motivo scritto.
- **Servizi a pagamento:**
  - ogni variante genera il proprio audio (musica, voce, effetti);
  - per una partenza o una richiesta "Tutte", **una sola conferma di costo** copre tutte le varianti del lotto, con il totale stimato. Si riusa il meccanismo `paid-batch` della fase 12;
  - i servizi del brief valgono per tutte le varianti.
- **+ Variante:**
  - si aggiunge una variante in seguito, con direzione facoltativa;
  - la variante parte dal brief, oppure dall'ultima versione di una variante scelta, che diventa la sua base.
- **Identità:**
  - il campo "proposte" del logo da zero (1–5, decisione 731) diventa il numero di varianti del gruppo;
  - logo, favicon e icona app di una variante stanno nella stessa figlia e sono coerenti;
  - le proposte come istanze `identity-logo@k` non nascono più per le creatività nuove. Quelle esistenti restano valide.

## 4. Chat

- **Selettore Variante · A · B · C · Tutte** in cima al pannello della chat:
  - mostra la conversazione della variante scelta;
  - una richiesta crea una nuova versione **solo di quella variante**;
  - con **Tutte**, la stessa richiesta parte in ogni variante attiva, nella conversazione di ciascuna, con il limite di 2 alla volta.
- **Turni:** messaggi durante il lavoro, coda, Stop e Ferma e reindirizza valgono per singola variante.
- **Centro attività:** il lavoro di ogni variante compare con la sua lettera.

## 5. Tela, scelta finale, scartate

- **Interruttore "Raggruppa per: Variante | Formato"**, predefinito "Variante", salvato in `variantGroup.layout`:
  - **per variante:** una fila per variante, con intestazione "B · <direzione>", stato del lavoro e menu ⋯, e accanto i formati della variante;
  - **per formato:** un gruppo per formato, con le varianti affiancate;
  - la colonna dei formati a sinistra segue lo stesso raggruppamento.
- **★ di gruppo:**
  - la ★ su un riquadro sceglie, per quel formato, **variante e versione** da esportare. Per ogni formato c'è una sola ★ nel gruppo;
  - senza ★, vale la regola di oggi (`starOf`) applicata alla variante A;
  - nel menu ⋯ c'è **"Usa questa variante per tutti i formati"**;
  - il riepilogo **"Selezione finale"** elenca formato per formato da quale variante e versione arriva la ★.
- **Scartare:**
  - dal menu ⋯ si sceglie **Scarta**. La variante sparisce dalla tela, dal selettore della chat e dalle richieste "Tutte", e le sue ★ tornano alla regola predefinita;
  - non si cancella niente;
  - **Mostra scartate** le fa riapparire in grigio, con **Ripristina**;
  - l'ultima variante attiva non si può scartare;
  - una variante al lavoro si può scartare solo dopo averla fermata, e la UI lo spiega.

## 6. Esportazione

- **Esportazione del gruppo:** prende per ogni formato la sua ★, da qualunque variante, con i nomi file di oggi.
- **"Esporta questa variante"** esporta una sola variante, come una creatività normale.
- Pacchetto store e traduzioni restano dentro ogni variante. L'esportazione del pacchetto di gruppo prende la ★ di ogni formato del pacchetto.

## 7. Casi limite

- **Formato tolto dal gruppo:** sparisce da tutte le varianti. Le versioni fatte restano nella cronologia di ciascuna. La ★ di quel formato viene tolta.
- **Una variante fallisce o viene fermata:** le altre continuano. Nella sua fila compaiono lo stato e "Riprova".
- **Rinominare o eliminare il gruppo** vale per tutte le varianti. L'eliminazione chiede conferma e dice quante varianti contiene.
- **Sorella senza la A:** una sorella il cui gruppo non si trova (A eliminata o spostata a mano) si apre come creatività singola, con un avviso. Una A che elenca una sorella mancante la mostra come "mancante", senza errori.
- **Slug:** `~` è riservato alle sorelle. Una creatività nuova non può avere `~` nel nome, e le sorelle esistono solo dentro un gruppo.
- **Agente:**
  - ogni variante ha la sua sessione dell'agente;
  - l'agente di una variante non scrive mai nelle cartelle delle altre: si applicano le stesse protezioni di oggi tra creatività;
  - legge le loro direzioni solo dal prompt.

## 8. Fuori perimetro

- Note 2, 3 e 5 dello stesso giro:
  - il player al passaggio del mouse sui formati immagine;
  - l'editor dell'interno degli SVG;
  - i loghi dell'utente nell'app Motion Studio.
  Seguono in lotti separati.
- Unire due varianti in una.
- Varianti di un singolo formato, scollegate dalle altre.
- Votazioni o confronto con più persone.

## 9. Verifica

- **Test automatici con i dati finti di sempre:**
  - gruppo con N varianti;
  - brief propagato, anche a una variante al lavoro;
  - ★ tra varianti e "Usa questa variante";
  - scartare e ripristinare, compreso l'ultimo attivo rifiutato;
  - esportazione di gruppo e di una sola variante;
  - creatività vecchie aperte come gruppo di una variante;
  - limite di 2 alla volta e coda;
  - conferma di costo unica per il lotto;
  - `submit_variant_directions`;
  - sorella orfana;
  - slug con `~` rifiutato.
- **Prova dal vivo:** con il vero Claude Code nell'app di sviluppo, con `MOTION_STUDIO_USER_DATA_DIR` e un workspace temporaneo:
  - una creatività con 3 varianti e servizi a pagamento spenti;
  - una richiesta "Tutte";
  - una ★ mescolata e un'esportazione di gruppo;
  - un set di identità con 3 varianti.
  Prima e dopo si controllano le date delle cartelle vere. Se il classificatore di sicurezza ferma un passo, ci si ferma e si riporta.
