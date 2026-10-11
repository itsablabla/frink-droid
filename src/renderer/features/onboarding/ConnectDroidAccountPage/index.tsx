import robotLogo from '@iconify-icons/ri/robot-2-fill';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { useConnectAccountFlow } from '../../../hooks/useConnectAccountFlow';
import { trpc } from '../../../lib/trpc';
import { ConnectAccountShell, connectFlowProps } from '../connect-account-shell';

const DroidIcon = iconifyComponent(robotLogo);

const DROID_AUTH_COMMAND = 'droid';

/**
 * Connect a Factory Droid login as a passthrough account.
 *
 * - No token is stored in Frink. The `droid` CLI owns its credential (machine-local
 *   `~/.factory`); we only read identity metadata to label the row.
 * - One passthrough per machine (matches droid's single-source auth).
 */
export function ConnectDroidAccountPage() {
  const detectionQuery = trpc.claudeCode.detectDroidAccount.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const connectMutation = trpc.claudeCode.connectDroidPassthrough.useMutation();

  const flow = useConnectAccountFlow({
    detectionQuery,
    connectMutation,
    buildConnectInput: (accountLabel) => ({ accountLabel }),
    deriveLabel: (detection) =>
      detection.available ? (detection.email ?? detection.displayName ?? 'Factory') : null,
    successMessage: (isReauthFlow) =>
      isReauthFlow ? 'Factory account reconnected' : 'Factory account connected',
  });

  const { detection } = flow;

  return (
    <ConnectAccountShell
      providerIcon={<DroidIcon className="w-6 h-6 text-background" />}
      providerIconBgClassName="bg-foreground"
      providerName="Factory"
      authCommand={DROID_AUTH_COMMAND}
      headerDescription="Uses your Droid sign-in on this computer. No token is stored in Frink."
      detectionAvailable={detection?.available === true}
      detectionEmail={detection?.available ? detection.email : null}
      detectionHint={detection && !detection.available ? detection.hint : null}
      {...connectFlowProps(flow)}
    />
  );
}
