type Level = 'info' | 'warn' | 'error';

function log(level: Level, scope: string, message: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${message}`;
  if (level === 'error') {
    console.error(line, extra ?? '');
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (scope: string, message: string): void => log('info', scope, message),
  warn: (scope: string, message: string): void => log('warn', scope, message),
  error: (scope: string, message: string, extra?: unknown): void => log('error', scope, message, extra),
};
