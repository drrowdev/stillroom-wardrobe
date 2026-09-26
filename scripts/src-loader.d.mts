export function resolveSourceSpecifier(specifier: string, parentURL: string | undefined, root?: string,
  fileExists?: (path: string) => boolean, real?: (path: string) => string): string | null;
export function registerSourceLoader(): void;