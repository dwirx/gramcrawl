import { createLogger } from "../logger";
import { runWithChatActionHeartbeat } from "../runtime-utils";
import type { TelegramApi } from "../api/client";
import { buildStatusCard } from "../ui/formatter";
import { buildJobFailureHint } from "../runtime-utils";
import type { ChatJob, ChatQueueState, JobCancelRef } from "../types";
import { CHAT_QUEUE_MAX_LENGTH } from "../constants";

export class QueueService {
  private readonly chatQueues = new Map<number, ChatQueueState>();
  private readonly logger = createLogger("queue-service");

  constructor(private readonly api: TelegramApi) {}

  getOrCreateQueueState(chatId: number): ChatQueueState {
    const existing = this.chatQueues.get(chatId);
    if (existing) {
      return existing;
    }

    const created: ChatQueueState = {
      running: null,
      runningCancelRef: null,
      queue: [],
      startedAt: 0,
    };
    this.chatQueues.set(chatId, created);
    return created;
  }

  runNextChatJob(chatId: number): void {
    const state = this.getOrCreateQueueState(chatId);
    if (state.running || state.queue.length === 0) {
      return;
    }

    const nextJob = state.queue.shift();
    if (!nextJob) {
      return;
    }

    const cancelRef: JobCancelRef = {
      cancelled: false,
      abortController: new AbortController(),
    };
    state.running = nextJob;
    state.runningCancelRef = cancelRef;
    state.startedAt = Date.now();

    void (async () => {
      try {
        await this.logger.info("chat job started", {
          chatId,
          label: nextJob.label,
          queued: state.queue.length,
        });
        await runWithChatActionHeartbeat(
          (targetChatId, action) =>
            this.api.sendChatAction(targetChatId, action),
          chatId,
          "typing",
          async () =>
            nextJob.run({
              isCancelled: () => cancelRef.cancelled,
              signal: cancelRef.abortController.signal,
            }),
        );
      } catch (error) {
        const detail = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 300);
        const hint = buildJobFailureHint(nextJob.label, detail);
        await this.logger.error("chat job failed", error, {
          chatId,
          label: nextJob.label,
        });
        await this.api.sendMessage(
          chatId,
          buildStatusCard(
            "❌ Job gagal",
            [
              { label: "Task", value: nextJob.label },
              {
                label: "Detail",
                value: detail,
              },
            ],
            hint ?? undefined,
          ),
        );
      } finally {
        state.running = null;
        state.runningCancelRef = null;
        state.startedAt = 0;
        if (state.queue.length === 0) {
          this.chatQueues.delete(chatId);
        } else {
          this.runNextChatJob(chatId);
        }
      }
    })();
  }

  enqueueChatJob(
    chatId: number,
    label: string,
    run: ChatJob["run"],
  ): { started: boolean; position: number; queueSize: number } {
    const state = this.getOrCreateQueueState(chatId);
    if (state.queue.length >= CHAT_QUEUE_MAX_LENGTH) {
      return {
        started: false,
        position: -1,
        queueSize: state.queue.length + (state.running ? 1 : 0),
      };
    }

    const started = !state.running;
    const job: ChatJob = {
      id: crypto.randomUUID(),
      label,
      createdAt: Date.now(),
      run,
    };
    state.queue.push(job);
    const position = started ? 0 : state.queue.length;
    this.runNextChatJob(chatId);
    return {
      started,
      position,
      queueSize: state.queue.length + (state.running ? 1 : 0),
    };
  }

  cancelChatJobs(chatId: number): {
    queuedCleared: number;
    runningCancelled: boolean;
    runningLabel: string;
  } {
    const state = this.chatQueues.get(chatId);
    if (!state) {
      return {
        queuedCleared: 0,
        runningCancelled: false,
        runningLabel: "-",
      };
    }

    const queuedCleared = state.queue.length;
    state.queue = [];
    const runningCancelled = Boolean(state.running && state.runningCancelRef);
    if (state.runningCancelRef) {
      state.runningCancelRef.cancelled = true;
      state.runningCancelRef.abortController.abort(
        new Error("Cancelled from /cancel command"),
      );
    }
    const runningLabel = state.running?.label ?? "-";

    if (!state.running) {
      this.chatQueues.delete(chatId);
    }

    return { queuedCleared, runningCancelled, runningLabel };
  }

  getStats(): {
    activeChats: number;
    runningJobs: number;
    queuedJobs: number;
  } {
    let runningJobs = 0;
    let queuedJobs = 0;

    for (const state of this.chatQueues.values()) {
      if (state.running) {
        runningJobs += 1;
      }
      queuedJobs += state.queue.length;
    }

    return {
      activeChats: this.chatQueues.size,
      runningJobs,
      queuedJobs,
    };
  }
}
