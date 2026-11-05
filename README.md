# hindsight-tg (tg-memory-bridge)

Turn a private Telegram group into a durable memory bank for DeepSeek Harness.
Inspired by the four-layer memory model of
[vectorize-io/hindsight](https://github.com/vectorize-io/hindsight), but built entirely
on Telegram's free infrastructure: **group messages = memory, the pinned message = mental model**.

Pure Node (zero dependencies), installed as a DSH cordis plugin.

## Highlights

- **Human-agent shared memory**: memories the agent writes are visible on your phone, browsable by hashtag
- **Dual-entry retrieval**: the model queries a local JSONL index (the Bot API has no search endpoint —
  verified: all 8 candidate methods return 404); you use Telegram's built-in chat search
- **Pinned profile card = mental model**: one continuously edited pinned message carrying
  "who this user is / preferences / work in progress", read at session start with zero retrieval
- **Lifecycle automation** (patterns borrowed from the official hindsight-coding-agents DSH integration):
  `agent/pre-step` injects the card + latest `#digest` (change-deduplicated, official `injectionMessage` shape);
  `agent/turn-stopping` auto-captures durable facts from the user's prompt via an LLM gate
  (graceful no-key degradation); a proactive memory ruleset is injected as a system prompt section
- **Memory Defense**: regex screening for secrets/credentials on every write (30+ pattern classes, CJK-safe ASCII boundaries, Luhn credit-card validation), redacted to `[REDACTED:type]` by default (`defense:'block'|false` to block or disable)
- **7 tools**: `tg_status` / `tg_retain` / `tg_recall` / `tg_forget` / `tg_edit` / `tg_digest` / `tg_pin`

See [README.zh.md](./README.zh.md) for the full guide (install, config, four-layer mapping, known limits).

## License

[MIT](./LICENSE)
