# MakeCode model evaluation

This suite compares models on the outcome Vibbit actually needs: valid response JSON containing target-correct MakeCode Static TypeScript that compiles and decompiles entirely to native Blocks.

The model sampler and corpus are available now:

- `evals/makecode-models/corpus.json`: 24 cases across micro:bit, Arcade, and Maker and across eight task categories. Micro:bit is the primary screening target; Arcade and Maker remain cross-target regression checks.
- `evals/makecode-models/run.mjs`: exact Vibbit prompt construction, OpenAI-compatible sampling, strict contract checks, compatibility prechecks, prompt criteria, latency, token usage, and cost capture.

The sampler deliberately awards only 40 provisional points. A regex cannot establish whether an API exists or code decompiles. The remaining 60 points require a pinned MakeCode compiler/decompiler runner described below.

## What is being compared

Treat a row as a **model plus route**, not just a model name. For example, `glm-5.3` through OpenCode Go and Zen are separate candidates, and an equivalent OpenRouter slug is another candidate. Routing, quantization, provider fallback, and serving configuration can change quality and latency.

Record these with every run:

- requested and provider-resolved model IDs;
- gateway and endpoint;
- model-list metadata snapshot;
- corpus version and SHA-256 hashes of the exact system and user prompts;
- target, and the hardware variant for Maker;
- temperature, maximum tokens, seed if accepted, and repetition number;
- wall-clock latency, finish reason, native token counts, cache/reasoning token details, and billed cost when returned;
- MakeCode target release, PXT release, hardware variant, compile/decompile diagnostics, and grey-block count.

OpenCode's available models change. Snapshot `GET /v1/models` on each run and select `--protocol chat` for `/chat/completions` models or `--protocol responses` for `/responses` models. Models that require `/messages` are not comparable through this harness without a separate adapter. API requests use bare model IDs such as `glm-5.3`; the `opencode-go/...` and `opencode/...` prefixes are OpenCode client configuration IDs, not the API request IDs.

## Corpus design

There is one case per category per target:

1. simple generation;
2. event handlers;
3. state;
4. compile-error repair with `CURRENT_CODE` and `PAGE_ERRORS`;
5. conversion-error repair with `CURRENT_CODE` and `CONVERSION_DIALOG`;
6. positive and negative prompt adherence;
7. unsupported or invented APIs;
8. valid-looking TypeScript constructs that compile in ordinary TypeScript but do not become native Blocks.

Each case has conservative required and forbidden patterns. They test explicit semantics such as exact pins, timing, event kinds, and prohibited behavior. They are not an oracle: equivalent code can miss a textual pattern, and matching every pattern does not prove correctness. Any pattern change is a corpus-version change and should be reviewed against known-good target output.

### Target constraints

- **micro:bit:** use the target's `basic`, `input`, and optional `radio` packages, exact enum members, block signatures, and top-level event registrations. A compile fixture that uses radio must include the radio dependency.
- **Arcade:** use Arcade sprite/controller/scene/game/info APIs and image literals. Accept canonical decompiler normalization, such as a sprite flag replacing a compatibility convenience method; score semantics or Blocks XML rather than textual round-trip identity.
- **Maker:** pin a board because Maker is a family of hardware packages, not one uniform API. The corpus uses **Adafruit Circuit Playground Express**. Canonical Maker code uses fixed pin objects (`pins.LED.digitalWrite(true)`, `pins.A3.analogRead()`, `pins.A1.servoWrite(90)`), fixed button objects (`input.buttonA.onEvent(ButtonEvent.Click, ...)`), and global `forever`/`pause`. Temperature requires `TemperatureUnit.Celsius`. Pin capabilities and sensor/button packages differ by board.

This inspection exposed a material baseline issue: Vibbit's current Maker catalog in `shared/makecode-compat-core.mjs` describes micro:bit-style `DigitalPin`/`AnalogPin` arguments, `pins.digitalWritePin`, `input.onButtonPressed`, `loops.forever`, and `pins.map`. Those are not the canonical pxt-maker Circuit Playground Express surface; several do not exist there. Do not interpret low Maker scores as model weakness until either that prompt is corrected or the evaluation explicitly measures how well models resist incorrect prompt grounding. Report Maker separately in all cases.

## Scoring

Score every response out of 100. Use micro:bit results as the primary ranking because that is Vibbit's main target, while retaining separate Arcade and Maker results as regression signals rather than folding them into an equally weighted product decision:

| Dimension | Points | Rule |
|---|---:|---|
| Strict JSON contract | 10 | Raw response is exactly one JSON object with only `feedback` (non-empty string array) and non-empty string `code`; no fences or prose. |
| Vibbit static prefilter | 10 | `validateBlocksCompatibility(code, target)` reports no violation. |
| Prompt/repair adherence | 20 | Pro-rate the case's required and forbidden semantic checks. Review failures before changing patterns. |
| Target compile | 20 | Pinned target compilation succeeds with no error diagnostics. |
| TypeScript-to-Blocks decompile | 25 | Decompiler succeeds, emits non-empty `main.blocks`, and has no error diagnostics. |
| Native Blocks only | 10 | No `typescript_statement` XML and no grey blocks. |
| Blocks round trip | 5 | Recompile the emitted Blocks/derived TypeScript successfully without errors. |

The first three dimensions are the harness's **40-point provisional score**. Never rank production candidates on that score alone.

A **hard pass** requires all of the following, regardless of weighted score:

- successful provider request and non-empty code;
- strict JSON contract;
- target compilation;
- successful decompilation;
- zero grey/TypeScript-statement blocks;
- all required and forbidden case criteria;
- for repair cases, the reported bad construct is absent and intended behavior remains.

Report:

- macro-average score (each of 24 cases equal weight), overall hard-pass rate, and hard-pass rate by target and category;
- JSON, compile, decompile, grey-block, unsupported-API, and adherence failure rates separately;
- median and p95 latency, mean input/output/reasoning tokens, total cost, and cost per hard pass;
- 95% Wilson intervals for pass rates and paired bootstrap confidence intervals for score/pass-rate differences, resampling by case and repetition;
- worst-case results. Do not let strong micro:bit results hide a Maker or repair failure.

Recommended release gate: at least 95% overall hard pass, at least 90% for every target and category, zero JSON-contract failures in the finalist run, and no statistically or practically meaningful regression versus the incumbent. Adjust thresholds only before seeing candidate labels.

## Sampling strategy

Use three phases, with most screening spend on micro:bit:

1. **Micro:bit screen:** 5 repetitions × 8 micro:bit cases per candidate at Vibbit's temperature 0.1.
2. **Cross-target check:** 3 repetitions × the 16 Arcade and Maker cases for candidates that pass the micro:bit screen.
3. **Final:** at least 10 repetitions × all 24 cases for the shortlist and incumbent. Five is an acceptable budget-constrained minimum, but gives wide intervals.

Keep system/user prompts, max tokens, temperature, target versions, board, and retry policy identical. Use `--prompt-mode managed` for an apples-to-apples primary model comparison. Vibbit's BYOK route adds conversational guidance, so use `--prompt-mode byok` only for a separate route-faithful benchmark. Run raw single attempts first: Vibbit's correction retries can hide first-pass model quality and multiply cost. Run a second end-to-end policy benchmark only after raw quality is understood, recording every retry and fallback separately.

The harness rotates case and model order deterministically to reduce time-of-day and warm-cache bias. Run candidates from the same gateway in one interleaved matrix. Alternate gateway order across replicated runs. A provider seed is only a request hint and is not assumed to make results deterministic; repeated samples remain mandatory. If all candidates support a seed, use `--seed 1701` and still vary repetition (`1701 + repetition`). Otherwise omit seed for every candidate in the primary comparison.

Freeze the corpus before unblinding model labels. If a case is invalid, correct it for all models and rerun that case; do not selectively waive failures.

## Running the sampler now

Validate the corpus and matrix without secrets:

```bash
node --check evals/makecode-models/run.mjs
node evals/makecode-models/run.mjs \
  --provider openrouter \
  --models openai/gpt-5.6-luna,deepseek/deepseek-v4-flash-0731,xiaomi/mimo-v2.5,qwen/qwen3.8-27b,tencent/hy3 \
  --target microbit \
  --samples 5 \
  --prompt-mode managed \
  --dry-run
```

OpenCode Go, restricted to models listed with a chat-completions endpoint:

```bash
export OPENCODE_GO_API_KEY='...'
node evals/makecode-models/run.mjs \
  --provider opencode-go \
  --key-env OPENCODE_GO_API_KEY \
  --models deepseek-v4-flash,glm-5.3,kimi-k3,mimo-v2.5,hy3 \
  --samples 3
```

For an OpenCode Go Responses API model such as GPT-5.6 Luna:

```bash
node evals/makecode-models/run.mjs \
  --provider opencode-go \
  --key-env OPENCODE_GO_API_KEY \
  --protocol responses \
  --models gpt-5.6-luna \
  --target microbit \
  --samples 3
```

OpenCode Zen:

```bash
export OPENCODE_GO_API_KEY='...'
node evals/makecode-models/run.mjs \
  --provider opencode-zen \
  --key-env OPENCODE_GO_API_KEY \
  --models hy3-free,nemotron-3-ultra-free,nemotron-3.5-lightning-free \
  --samples 3
```

OpenRouter using models configured or under consideration for Vibbit:

```bash
export OPENROUTER_API_KEY='...'
node evals/makecode-models/run.mjs \
  --provider openrouter \
  --models openai/gpt-5.6-luna,deepseek/deepseek-v4-flash-0731,xiaomi/mimo-v2.5,qwen/qwen3.8-27b,tencent/hy3 \
  --target microbit \
  --samples 5
```

Results go to ignored `output/model-evals/<provider>-<timestamp>/`:

- `results.jsonl`: raw output, parsed output, provisional checks, usage/cost, and a null `makeCodeValidation` slot;
- `models-snapshot.json`: provider model metadata at run time;
- `summary.json`: run configuration and counts.

Secrets are read only from the named environment variable and are never written. OpenRouter currently returns native token accounting and cost in `usage`; for endpoints that omit billed cost, retain token counts and apply a frozen price snapshot during analysis rather than silently using today's price later.

## True MakeCode validation

### Preferred repeatable infrastructure

Build a separate validator image or CI job with immutable editor/target versions. For each JSONL response:

1. Create an isolated target project with `main.ts`, `main.blocks`, target-specific `pxt.json`, and pinned `mkc.json`.
2. Compile Static TypeScript with `mkc build -j --no-colors` (Maker also specifies the Circuit Playground Express hardware variant). Require exit 0, `Build OK`, and no error diagnostics.
3. Load the same pinned target compiler worker and obtain target compile options.
4. Set `main.ts`, add `main.blocks`, set `ast = true` and `errorOnGreyBlocks = true`, then call the compiler worker operation `decompile` for `main.ts`.
5. Require `result.success`, no error diagnostics, and non-empty `outfiles["main.blocks"]`.
6. Independently reject XML containing `<block type="typescript_statement">`.
7. Load/recompile the emitted Blocks and record round-trip diagnostics.
8. Write target/PXT release IDs, diagnostics, output hashes, and grey-block count into `makeCodeValidation` in a derived result file; keep the raw JSONL immutable.

`mkc build` alone is insufficient: it tests compilation but has no decompile command. The decompile operation is the same target compiler path used when the MakeCode editor switches JavaScript back to Blocks. Pin `mkc.json.targetWebsite` to an immutable version or SHA-indexed target build, not stable/beta URLs; pin package dependencies and the Maker hardware variant too.

### Browser validation

Where direct compiler-worker integration is unavailable, Playwright can load each target editor, import/set `main.ts`, switch to Blocks, reject the conversion dialog, and inspect Blockly for grey blocks. This is slower and more timing-sensitive but exercises the exact released editor. It must run separately against:

- `https://makecode.microbit.org/`;
- `https://arcade.makecode.com/`;
- `https://maker.makecode.com/` with the pinned board.

The existing `npm run audit:smoke` is not this validation. It visits only micro:bit, stubs Monaco/provider calls, and accepts a log saying the decompile probe passed, failed, or was unavailable. The live audit also stubs Monaco and tests only one prompt. Neither currently compiles/decompiles the corpus for all targets.

## What is automated now vs. deferred

Automated now:

- exact production prompt builders from `shared/makecode-compat-core.mjs`;
- balanced prompt fixture generation including errors and conversion-dialog context;
- strict raw JSON and permissive production parser outcomes;
- Vibbit compatibility prefilter and case criteria;
- repeated, interleaved sampling for OpenRouter and chat-compatible OpenCode Go/Zen models;
- latency, resolved model, token usage, provider cost where supplied, prompt hashes, and model metadata snapshots.

Requires pinned MakeCode infrastructure:

- authoritative target API/type checking;
- target compilation;
- TypeScript-to-Blocks decompilation;
- grey-block/`typescript_statement` rejection;
- Blocks round-trip compilation;
- visual/browser confirmation of conversion-dialog behavior and Vibbit's retry/fallback policy.

Until that second stage exists, the suite is suitable for corpus review and inexpensive model screening, not a final model-selection claim.

## Sources

- Vibbit source: `shared/makecode-compat-core.mjs`, `work.js`, `apps/backend/src/runtime.mjs`, `scripts/audit/smoke.mjs`, and `scripts/audit/live.mjs`.
- OpenCode Go API/model list and changing model roster: <https://opencode.ai/docs/go>
- OpenCode Zen endpoints and per-token pricing: <https://opencode.ai/docs/zen>
- OpenRouter usage/cost accounting: <https://openrouter.ai/docs/cookbook/administration/usage-accounting>
- MakeCode CLI: <https://makecode.com/cli>
- MakeCode command-line compiler: <https://github.com/microsoft/pxt-mkc>
- PXT decompiler implementation: <https://github.com/microsoft/pxt/blob/master/pxtcompiler/emitter/decompiler.ts>
- Target sources: <https://github.com/microsoft/pxt-microbit>, <https://github.com/microsoft/pxt-arcade>, and <https://github.com/microsoft/pxt-maker>
