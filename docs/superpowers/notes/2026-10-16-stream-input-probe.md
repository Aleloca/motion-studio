# Stream-input and interrupt probe, run by the user

Date: 2026-10-16. Installed CLI: Claude Code **2.1.301**. Probe: `scripts/spike/stream-input-probe.mjs` (real `claude`, model haiku, throwaway temp folder, cost a few cents). The **user ran it themselves**; no agent ran it, and no agent re-ran it. It completes the Phase 13 spike that was suspended on 2026-10-14 (`2026-10-14-phase13-stream-input-spike.md`, decision 610). Decision 804 turns live input and interrupt on from this version.

## Output (verbatim)

```json
{"cliVersion":"2.1.301 (Claude Code)",
 "midTurn":{"exitCode":0,"ms":16728,"results":2,"sawSecondAnswer":true,"firstAnswerDone":true,"lastResult":"success","stderrTail":""},
 "interrupt":{"exitCode":1,"ms":83744,"controlResponses":[{"subtype":"success","request_id":"probe-int-1","response":{"still_queued":[]}}],"resultSubtype":"error_during_execution","interruptedEarly":true,"stderrTail":""}}
```

## What the probe did

- **midTurn.** First message: "Count slowly from 1 to 40, one number per line, then say DONE-ONE." On the first `assistant` event it wrote a second user message on the open stdin: "Also, after that, reply with the single word PINEAPPLE." It closed stdin after the second `result`.
- **interrupt.** First message: "Write a numbered list of 200 short facts about the ocean." On the first `assistant` event it wrote `{ type: 'control_request', request_id: 'probe-int-1', request: { subtype: 'interrupt' } }`. It closed stdin at the `result`, or 15 s after the interrupt at the latest.

## Reading

- **Live input works on 2.1.301.** The second message was accepted mid-turn and answered in the same session: two `result`s, the first answer finished (DONE-ONE), then the second (PINEAPPLE). The last result is `success`, and the exit code is 0.
- **Delivery timing is not measured.** The probe cannot tell whether the CLI reads the second message between steps of the running turn or only after the current reply: haiku used no tools, so the turn had no steps. What it does show is one `result` per input (two messages, two results). Motion Studio uses only that as its evidence of "delivered" (decision 804). The interface says "The agent reads it as soon as the current step ends", not "delivered now".
- **Interrupt works.** `control_response` with `subtype: 'success'` for our `request_id` (the probe records `response`; the line is `{ type: 'control_response', response: { subtype: 'success', request_id: 'probe-int-1', response: { still_queued: [] } } }`). Then a `result` with subtype `error_during_execution`, and the list stopped early (fewer than 150 items).
- **Exit code 1 after an interrupt.** The process exits with 1 once stdin closes. Motion Studio treats an acknowledged interrupt followed by `error_during_execution` as a stop, not a failure, whatever the exit code.
- **83 s in total** is most likely the probe's own timing: it waits up to 15 s before closing stdin, and then the CLI shuts down. It is not the interrupt's latency.

## What follows (decision 804)

- `capabilitiesFor`: live input and interrupt on for 2.1.301 and newer, off for older or unknown versions. `agentLiveInput` and `agentInterrupt` default to `true` and can still switch them off. The Phase 13 fallbacks (queue, stop and resume) stay for off and for older versions.
- The runner treats the measured shape as "interrupted". The fake CLI (`packages/core/test/fixtures/fake-claude-stream.mjs`) emits exactly this shape in tests (`FAKE_STREAM_INTERRUPTED_EXIT=1`).
