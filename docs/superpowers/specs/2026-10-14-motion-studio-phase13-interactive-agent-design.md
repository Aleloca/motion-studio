# Motion Studio — Fase 13: Agente interattivo — Specifica

> **Fonti:**
> - programma `docs/superpowers/specs/2026-10-08-motion-studio-redesign-design.md`, §2, riga della Fase 13: scrivere all'agente o interromperlo mentre lavora;
> - percorso attuale dei turni: `ClaudeCodeRunner` (CLI `claude -p --input-format stream-json`, un solo messaggio su stdin, poi chiuso), `AgentLauncher`, `JobQueue`, `creative-turns.ts`, il compositore in `Conversation.tsx` (invio disattivato durante il lavoro, pulsante Cancel).
>
> **Decisioni prese in autonomia** dall'orchestratore (l'utente dorme e ha chiesto di procedere): voci 600–609 del registro. L'utente le rivede alla fine.

## 1. Perché

Oggi, mentre l'agente lavora:
- il compositore accetta testo ma non lo invia (409 `job-running`). L'utente deve aspettare la fine del turno anche per dire "il logo è quello blu";
- l'unica azione è Cancel, che butta via il lavoro del turno senza versione;
- il turno successivo riprende dalla sessione dell'ultima versione, quindi l'agente non ricorda cosa stava facendo quando è stato fermato.

## 2. Scrivere all'agente mentre lavora

- **Il compositore resta attivo** durante un turno. Il pulsante principale diventa **"Send to agent"**: il messaggio arriva all'agente nel turno in corso, al passo successivo, senza fermarlo.
- **Una seconda azione nel menu del pulsante, "Queue for after"**, mette il messaggio in coda come nuova richiesta da eseguire quando il turno finisce.
- **Stati di un messaggio nella conversazione:**
  - "sending";
  - "delivered", quando l'agente lo ha ricevuto;
  - "queued", con la possibilità di modificarlo o toglierlo finché non parte.
- **Contenuto.** Un messaggio durante il lavoro ha testo (massimo 4000 caratteri) e pin, come un messaggio normale, ma niente allegati: gli allegati si aggiungono con una nuova richiesta.
  - Al massimo 10 messaggi per turno e 5 richieste in coda per creatività. Oltre il limite, la UI spiega perché non si può inviare.
- **Ripetizioni del turno.** Ogni tentativo di riparazione è un nuovo processo e porta con sé, delimitate come parole dell'utente, sia la richiesta originale sia i messaggi ricevuti durante il turno (regola F4 della Fase 11).
- **Fase finale.** Se un messaggio arriva quando l'agente ha già finito e il core sta salvando la versione, non va perso: diventa una richiesta in coda e la UI lo dice ("Arrived after the agent finished: queued as the next request").
- **Coda dopo un riavvio.** Le richieste in coda stanno in `creative.json` (`queued[]`). Dopo un riavvio dell'app la UI le mostra, ma non le avvia da sola: l'utente preme "Run next".
- **Dove vale:** turni delle creatività (tutti i tipi, compresi `localize`) e console. Le analisi del brand e le descrizioni degli asset hanno solo l'interruzione.

## 3. Interrompere

- Il pulsante Cancel diventa **"Stop"**, con due azioni:
  - **Stop:** ferma il turno come oggi (nessuna versione). In più, il core ricorda la sessione interrotta: il turno successivo la riprende in un fork, con la nota "The previous turn was stopped by the user; files in work/ may be partial", e così l'agente sa cosa stava facendo.
  - **Stop and redirect…:** apre il compositore con un messaggio. Il core interrompe il passo in corso e consegna subito il messaggio nella stessa sessione. Il turno continua con la nuova indicazione: stesso job, stessi tentativi rimasti.
- **Approvazioni.** Un'approvazione a pagamento in attesa viene annullata da Stop e da Stop and redirect, senza spesa (percorso esistente `approvals.cancelJob` per Stop; per il redirect si annullano solo le approvazioni aperte di quel job).
- **Strumenti lunghi.** Un'interruzione durante uno strumento lungo del core (render di anteprima, generazione, download) annulla quello strumento con il suo segnale. Non devono restare processi figli: si usa lo stesso percorso di chiusura del job.

## 4. Meccanismo

- **Sessione aperta.** Il runner tiene aperto stdin del processo `claude` (`--input-format stream-json`, già passato) e può scrivere altri messaggi utente mentre il turno è in corso. Chiude stdin quando arriva il `result` finale del turno.
- **Interruzione nello stesso processo.** Si usa la richiesta di controllo `interrupt` del protocollo stream-json, se la versione installata di Claude Code la supporta.
- **Verifica prima del codice.** Il Task 0 verifica dal vivo, con haiku e una configurazione usa e getta, che cosa fa la versione installata:
  - quando consuma un messaggio scritto a metà turno;
  - come risponde all'interruzione;
  - come termina.

  Il risultato decide il percorso.
- **Ripiego, sempre disponibile.** Se un comportamento manca o cambia:
  - messaggio a metà turno: va in coda come richiesta successiva, e la UI lo dice;
  - interruzione: il core ferma il processo come oggi e riparte subito con `--resume` sulla stessa sessione e il messaggio del redirect come prompt.

  Il doctor riporta quale percorso è attivo ("Live messages: supported / queued only").
- **Conversazione.** I messaggi durante il lavoro sono voci `user` di `conversation.jsonl` con `jobId`, `mode: 'live' | 'queued' | 'redirect'` e `deliveredAt`. Nuovi eventi del job: `user_message_delivered` e `interrupted`.

**Aggiornamento 2026-10-14 (decisione: orchestratore).** La prova dal vivo del Task 0 è stata fermata dal classificatore di sicurezza prima di partire: costo zero, nessun processo avviato. Non viene rieseguita né aggirata. La fase procede così:
- i percorsi di ripiego (coda, ferma e riprendi) sono quelli attivi;
- consegna a metà turno e interruzione sono implementate dietro capacità spente, provate solo con il finto `claude`;
- si potranno accendere dopo una prova eseguita dall'utente.

## 5. Fuori perimetro

- Modificare un messaggio già consegnato.
- Messaggi a un'analisi del brand in corso.
- Più turni della stessa creatività in parallelo.
- Riprendere un turno fermato da un riavvio come se nulla fosse: resta "interrupted" come oggi, con la sessione ricordata.

## 6. Verifica

- Test del runner con un finto `claude` (script Node) che legge stdin in streaming, simula consumo, interruzione e uscita, e verifica: nessuna scrittura dopo la chiusura, nessun processo orfano, timeout.
- Test del core:
  - consegna, coda e fase finale;
  - limiti;
  - riparazione con le parole dell'utente;
  - Stop con sessione ricordata;
  - redirect con approvazione aperta (nessuna spesa);
  - ripiego quando il runner non supporta i messaggi a metà turno;
  - coda dopo un riavvio.
- Verifica dal vivo con haiku, configurazione e userData usa e getta:
  - un messaggio a metà turno che cambia un colore;
  - Stop seguito da una nuova richiesta che ricorda il turno fermato;
  - Stop and redirect durante uno strumento;
  - mtime delle cartelle reali invariati.
