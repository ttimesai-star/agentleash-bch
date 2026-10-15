// The public demo leash per network, written by scripts/demo-leash.ts. Its AGENT key is published on
// purpose: anyone can act as the agent, and the covenant still only lets the money go to the allow-listed
// demo tool, at most `limit` per window. That is the point of the demo. The owner key is not published.
import type { NetName } from './config.js';
import type { LeashDescriptor } from './store.js';
import data from './demo.json';

export const PUBLIC_DEMO: Partial<Record<NetName, LeashDescriptor>> = data as Partial<Record<NetName, LeashDescriptor>>;
