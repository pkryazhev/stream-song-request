/** Вспомогательное для scripts/yandex-auth.ts — вынесено отдельно ради юнит-тестов. */

/** Токен из вставленного адреса (…#access_token=…&…) или из голого токена. */
export function extractYandexToken(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/[#?&]access_token=([^&\s]+)/);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);
  if (/^[\w.-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

/** Заменяет строку VAR=... в .env (в том числе закомментированную) или дописывает её в конец. */
export function upsertEnvVar(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^#?[ \\t]*${name}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}${line}\n`;
}
