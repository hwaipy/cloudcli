import os from 'node:os';
import path from 'node:path';

import { startIsolationSshBroker, configureRunningIsolationSsh, getIsolationCapabilities } from '@/modules/project-isolation/index.js';

const root = path.resolve(process.env.CLOUDCLI_ISOLATION_STATE_DIR || path.join(os.homedir(), '.cloudcli', 'isolated-projects'));
const source = process.env.CLOUDCLI_ISOLATION_SSH_AUTH_SOCK || process.env.SSH_AUTH_SOCK;
if (!source) throw new Error('Set CLOUDCLI_ISOLATION_SSH_AUTH_SOCK to the authorized host agent socket');
const capability = await getIsolationCapabilities();
if (!capability.available) throw new Error(capability.reason);
const broker = await startIsolationSshBroker(root, source);
let scanning = false;
const discover = async () => { if (scanning) return; scanning = true; try { await configureRunningIsolationSsh(root); } finally { scanning = false; } };
await discover();
const scanTimer = setInterval(() => { void discover().catch(() => console.warn('Isolated SSH discovery will retry')); }, 15_000);
scanTimer.unref();
console.info('Isolated SSH broker ready: signing only, public SSH egress, no private key mounts');
const shutdown = () => { clearInterval(scanTimer); broker.agent.close(); broker.proxy.close(); process.exit(0); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
