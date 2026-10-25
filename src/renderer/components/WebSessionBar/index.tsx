/**
 * Web mode chrome the desktop app never needs: a "reconnecting" notice while the server socket is
 * down, and a sign-out control. Sign-out is a real same-origin form post (no script), so it goes
 * through the same Origin check as sign-in and the browser follows the redirect to the login page.
 */
import { LogOut } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { WEB_HOST_LOGOUT_PATH } from '../../../shared/lib/web-host';
import { getWebBridge } from '../../lib/web-host/install';

export function WebSessionBar(): ReactElement {
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const unsubscribe = getWebBridge()?.onStatus(setConnected);
    return () => {
      unsubscribe?.();
    };
  }, []);
  return (
    <>
      {!connected && (
        <div
          role="status"
          className="fixed left-1/2 top-2 z-[2000] -translate-x-1/2 rounded-md border bg-background px-3 py-1 text-xs shadow"
        >
          Reconnecting to the Frink server…
        </div>
      )}
      <form method="post" action={WEB_HOST_LOGOUT_PATH} className="fixed bottom-2 right-2 z-[2000]">
        <button
          type="submit"
          aria-label="Sign out of Frink"
          title="Sign out"
          className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </form>
    </>
  );
}
