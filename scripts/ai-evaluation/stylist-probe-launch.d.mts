export const AZURE_TARGET: Readonly<{ resourceGroup: string; resource: string; keyName: string }>;
export function parseLauncherArguments(args: string[]): { subscription: string; id: string; slot: 'min' | 'max' };
export function azureCommands(subscription: string): { endpoint: string[]; keys: string[] };
export function runAzure(args: string[]): Promise<string>;
export function childEnvironment(base: Record<string, string | undefined>, key: string): Record<string, string | undefined>;
export function launch(args: string[], options?: {
  azure?: (args: string[]) => Promise<string>;
  child?: (env: Record<string, string | undefined>, args: string[]) => Promise<number>;
  baseEnv?: Record<string, string | undefined>;
}): Promise<number>;
