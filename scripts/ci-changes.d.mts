export interface ChangeClassification { heavy: boolean; reason: string }
export function isDocumentation(file: unknown): boolean;
export function classify(input: { event: string; parents: number; files: unknown }): ChangeClassification;
