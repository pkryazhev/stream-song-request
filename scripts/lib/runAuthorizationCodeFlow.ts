import { createServer } from 'node:http';

export interface AuthFlowTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

export interface AuthFlowOptions {
  authorizeUrl: URL;
  /** Должен совпадать (включая порт и путь) с тем, что зарегистрирован в консоли разработчика. */
  redirectUri: string;
  exchangeCode: (code: string) => Promise<AuthFlowTokens>;
  onSuccess: (tokens: AuthFlowTokens) => void;
}

/**
 * Общий каркас для одноразового OAuth Authorization Code Flow: поднимает
 * локальный HTTP-сервер на redirect_uri, печатает ссылку для авторизации в
 * браузере, по колбэку меняет code на токены и завершает работу.
 * Используется и scripts/spotify-auth.ts, и scripts/twitch-auth.ts —
 * протокол OAuth 2.0 у них одинаковый, отличаются только сами endpoint'ы.
 */
export function runAuthorizationCodeFlow(opts: AuthFlowOptions): void {
  const redirect = new URL(opts.redirectUri);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          `<h1>Ошибка авторизации</h1><p>${error}</p>`,
        );
        server.close();
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('В запросе нет параметра code');
        return;
      }

      try {
        const tokens = await opts.exchangeCode(code);
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<h1>Готово!</h1><p>Можно закрыть вкладку и вернуться в терминал.</p>');
        opts.onSuccess(tokens);
      } catch (err) {
        res.writeHead(500).end('Ошибка обмена кода на токен, смотри лог в терминале.');
        console.error(err);
      } finally {
        server.close();
      }
    })();
  });

  server.listen(Number(redirect.port || 80), () => {
    console.log('Открой эту ссылку в браузере и разреши доступ:\n');
    console.log(opts.authorizeUrl.toString());
    console.log('');
  });
}
