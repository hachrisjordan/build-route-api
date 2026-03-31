import { ensureAmexCookieEnvFromStore } from './amex-cookie-store';
import { spawn } from 'child_process';
import path from 'path';

/**
 * Spawn the Python amex-auth script to refresh cookies, if configured.
 * Returns true if the script exits with code 0.
 */
export async function refreshAmexCookiesViaScript(): Promise<boolean> {
  const scriptPath =
    process.env.AMEX_AUTH_SCRIPT_PATH ||
    path.join(process.cwd(), 'amex-microservice', 'amex-auth.py');

  return new Promise<boolean>((resolve) => {
    const child = spawn('python3', [scriptPath, '--headless'], {
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      console.error('[AmEx] Failed to spawn amex-auth.py:', err);
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.log('[AmEx] amex-auth.py completed successfully');
        resolve(true);
      } else {
        console.error(`[AmEx] amex-auth.py exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

/**
 * Attempt to recover from a 403 by:
 * 1. Reloading cookies from Supabase into AMEX_COOKIE
 * 2. Optionally running the Python script to refresh cookies if still missing
 */
export async function recoverFromAmex403(): Promise<void> {
  const existing = process.env.AMEX_COOKIE;
  if (!existing) {
    await ensureAmexCookieEnvFromStore();
  }

  if (process.env.AMEX_COOKIE) {
    return;
  }

  // If we still don't have a cookie and a script path is configured, try to refresh
  if (process.env.AMEX_AUTH_DISABLE_AUTO_REFRESH === 'true') {
    return;
  }

  const refreshed = await refreshAmexCookiesViaScript();
  if (refreshed) {
    await ensureAmexCookieEnvFromStore();
  }
}

