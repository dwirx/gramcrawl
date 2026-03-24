import type { PendingSubtitleSelection } from "../types";
import {
  SUBTITLE_SESSION_TTL_MS,
  SUBTITLE_MAX_ACTIVE_SESSIONS,
} from "../constants";

export class SessionService {
  private readonly subtitleSessions = new Map<
    string,
    PendingSubtitleSelection
  >();

  set(sessionId: string, session: PendingSubtitleSelection): void {
    this.subtitleSessions.set(sessionId, session);
    this.cleanup();
  }

  get(sessionId: string): PendingSubtitleSelection | undefined {
    return this.subtitleSessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.subtitleSessions.delete(sessionId);
  }

  clear(): void {
    this.subtitleSessions.clear();
  }

  size(): number {
    return this.subtitleSessions.size;
  }

  createId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.subtitleSessions) {
      if (now - session.createdAt > SUBTITLE_SESSION_TTL_MS) {
        this.subtitleSessions.delete(sessionId);
      }
    }

    const overflow = this.subtitleSessions.size - SUBTITLE_MAX_ACTIVE_SESSIONS;
    if (overflow <= 0) {
      return;
    }

    const oldest = [...this.subtitleSessions.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, overflow);
    for (const [sessionId] of oldest) {
      this.subtitleSessions.delete(sessionId);
    }
  }
}
