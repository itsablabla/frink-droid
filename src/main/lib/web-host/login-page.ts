/** The standalone sign-in page web mode serves before a session exists. No scripts, no assets. */

export const LOGIN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const MESSAGES: Record<string, string> = {
  invalid: 'That password is not right.',
  wait: 'Too many attempts. Wait a few minutes and try again.',
  expired: 'Your session ended. Sign in again.',
};

export function renderLoginPage(error: string | null): string {
  const message = error ? MESSAGES[error] : undefined;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Sign in · Frink</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  form { width: min(360px, 90vw); display: grid; gap: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0; font-size: 14px; opacity: .75; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #8886; }
  button { background: #7c3aed; color: #fff; border: 0; cursor: pointer; }
  .error { color: #dc2626; opacity: 1; }
</style>
</head>
<body>
<form method="post" action="/__frink/login" autocomplete="on">
  <h1>Frink</h1>
  <p>Enter the password for this Frink server.</p>
  ${message ? `<p class="error" role="alert">${message}</p>` : ''}
  <input type="password" name="password" aria-label="Password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
