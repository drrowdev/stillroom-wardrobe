export const HOSTED_URL: string;
export type HostedEnvironment = Record<string, string | undefined>;
export type HostedOwner = { uid: string; token: string; item: string; image: string };
export type HostedResult =
  | { status: 'PASS'; exitCode: 0 }
  | { status: 'FAIL'; exitCode: 1 }
  | { status: 'BLOCKED'; exitCode: 2 };
export function validateHostedEnvironment(env: HostedEnvironment): { key: string; owners: HostedOwner[] };
export function runHostedSmoke(env: HostedEnvironment, fetcher?: typeof fetch): Promise<HostedResult>;
