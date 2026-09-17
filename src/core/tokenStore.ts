import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
}

export type RefreshFn = (refreshToken: string) => Promise<RefreshResult>;

/**
 * Хранит access/refresh токен в JSON-файле на диске и обновляет access
 * token перед истечением. И у Spotify, и у Twitch протокол refresh_token
 * одинаковый (OAuth 2.0 Authorization Code), поэтому логика общая —
 * отличается только сам refresh-запрос (передаётся снаружи).
 */
export class TokenStore {
  private token: StoredToken | undefined;
  private readonly filePath: string;
  private readonly refresh: RefreshFn;

  constructor(filePath: string, refresh: RefreshFn) {
    this.filePath = filePath;
    this.refresh = refresh;
  }

  /** Загружает сохранённый токен с диска. Возвращает false, если файла ещё нет. */
  load(): boolean {
    try {
      this.token = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredToken;
      return true;
    } catch {
      this.token = undefined;
      return false;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.token, null, 2));
  }

  /** Сохраняет токен, полученный впервые (после прохождения OAuth-флоу). */
  saveInitial(accessToken: string, refreshToken: string, expiresInSec: number): void {
    this.token = { accessToken, refreshToken, expiresAt: Date.now() + expiresInSec * 1000 };
    this.persist();
  }

  hasToken(): boolean {
    return this.token !== undefined;
  }

  async getValidAccessToken(): Promise<string> {
    if (!this.token) {
      throw new Error(
        `Нет сохранённого токена в ${this.filePath}. Нужно один раз пройти авторизацию — см. README.`,
      );
    }
    if (this.token.expiresAt - 60_000 > Date.now()) {
      return this.token.accessToken;
    }
    const refreshed = await this.refresh(this.token.refreshToken);
    this.token = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? this.token.refreshToken,
      expiresAt: Date.now() + refreshed.expiresInSec * 1000,
    };
    this.persist();
    return this.token.accessToken;
  }
}
