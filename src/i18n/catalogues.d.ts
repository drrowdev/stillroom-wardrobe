declare module 'virtual:stillroom-catalogues' {
  /** Each language's startup catalogue: its canonical URL, the full SHA-256 of its bytes and the shared key count. */
  export const catalogueUrls: Readonly<Record<'en' | 'fi' | 'sv', string>>;
  export const catalogueDigests: Readonly<Record<'en' | 'fi' | 'sv', string>>;
  export const catalogueKeyCount: number;
}