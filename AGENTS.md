# AI/LLM Guardrails

This project uses a high-performance tooling stack and a modular architecture. AI agents should follow these rules to ensure code quality, consistency, and architectural integrity.

## Quality Commands

- **Check (Fast):** `bun run check:fast` (Use this frequently during development to check lint and fmt)
- **Check (Full):** `bun run check` (Use this before finishing a task to run type-checker, linter, and fmt)
- **Auto-fix:** `bun run fix` (Use this to automatically resolve linting and formatting issues)
- **Test:** `bun test` (Always run existing tests after structural changes)

## Architectural Rules

1. **Modular Telegram Structure**: Do NOT add everything to `bot.ts`. Follow the established modular structure in `src/telegram/`:
   - `handlers/`: Logic for specific commands or events.
   - `services/`: Stateful services (Queue, Cache, etc.).
   - `api/`: Low-level Telegram API interactions.
   - `ui/`: Message templates and keyboard layouts.
2. **Context Passing**: Use the `BotContext` interface to access services and configuration within handlers.
3. **Strict Typing**: Avoid `any`. Use specific types like `TelegramCommand` from `command-parser.ts` and ensure all service methods are properly typed.
4. **Queue Usage**: Heavy or long-running tasks MUST be enqueued using `ctx.queue.enqueueChatJob` to prevent blocking the bot's polling loop.
5. **Abort Signals**: Always respect `cancelToken` or `AbortSignal` in long-running jobs to ensure the `/cancel` command works effectively.

## Code Standards

1. **Zero Warnings Policy:** If `oxlint` reports an error or warning, it MUST be fixed.
2. **Consistency:** Code MUST be formatted using `oxfmt` (`bun run fmt`).
3. **Type Safety:** All changes MUST pass `tsgo` (`bun run typecheck`) diagnostics.
4. **Validation:** Never claim a task is finished without passing `bun run check`.
