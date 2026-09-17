export interface SkipVoteTrackerConfig {
  /** Процент от числа "активных" зрителей, необходимый для скипа (например 30). */
  thresholdPercent: number;
  /** За сколько мс до "сейчас" зритель считается активным (писал что-либо в чат). */
  activeWindowMs: number;
}

/**
 * Отслеживает "активных" зрителей чата (кто угодно писал что-либо в чат за
 * последние activeWindowMs — не только команду скипа) и голоса за скип
 * текущего заказа. Голосование считается успешным, когда число голосов
 * достигает порога — округлённого вверх процента от числа активных
 * зрителей (Math.ceil, чтобы, например, при 3 активных и пороге 30%
 * требовался хотя бы 1 голос, а не 0 — 30% от 3 это 0.9, что интуитивно
 * должно означать "нужен хотя бы один голос").
 */
export class SkipVoteTracker {
  private readonly cfg: SkipVoteTrackerConfig;
  private readonly lastActiveAt = new Map<string, number>();
  private readonly votes = new Set<string>();

  constructor(cfg: SkipVoteTrackerConfig) {
    this.cfg = cfg;
  }

  /** Отмечает пользователя активным — вызывается на каждое сообщение в чате. */
  recordActivity(userId: string, now: number = Date.now()): void {
    this.lastActiveAt.set(userId, now);
  }

  /** Число уникальных пользователей, писавших в чат за последние activeWindowMs. */
  countActive(now: number = Date.now()): number {
    let count = 0;
    for (const ts of this.lastActiveAt.values()) {
      if (now - ts <= this.cfg.activeWindowMs) count += 1;
    }
    return count;
  }

  /** Сколько голосов сейчас нужно для скипа, при текущем числе активных зрителей. */
  requiredVotes(now: number = Date.now()): number {
    const active = this.countActive(now);
    return Math.max(1, Math.ceil((active * this.cfg.thresholdPercent) / 100));
  }

  /**
   * Регистрирует голос пользователя за скип (повторный голос того же
   * пользователя не учитывается дважды). Возвращает true, если после этого
   * голоса порог достигнут.
   */
  vote(userId: string, now: number = Date.now()): boolean {
    this.votes.add(userId);
    return this.votes.size >= this.requiredVotes(now);
  }

  get voteCount(): number {
    return this.votes.size;
  }

  /** Сбрасывает голоса (вызывается при смене трека) — активность зрителей НЕ сбрасывается. */
  resetVotes(): void {
    this.votes.clear();
  }
}
