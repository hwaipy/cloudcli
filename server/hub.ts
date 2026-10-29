import { createHubServer, loadHubConfiguration } from '@/modules/hub/index.js';

const configuration = loadHubConfiguration();
const host = process.env.HUB_HOST ?? '127.0.0.1';
const port = Number(process.env.HUB_PORT ?? '3003');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HUB_PORT must be a valid port');

createHubServer(configuration).listen(port, host, () => {
  console.log(`CloudCLI Hub listening on http://${host}:${port}`);
});
