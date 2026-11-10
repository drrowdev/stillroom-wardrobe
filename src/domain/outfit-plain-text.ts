// OUTFITGEN-QUALITY2: the title and reason of a suggestion whose verdict carries none. The prompt asks the model for a title and a reason
// only when it says "good" (both scores 8 or more); a plain look (score 7) arrives with empty strings, and a suggestion needs both. The Edge
// function stores this fixed text for it, in the owner's language. It says nothing the model did not give: no garment, colour or claim.
// Pure and import-free (shared by the Edge function and the tests).

export type PlainLanguage = 'en' | 'fi' | 'sv';
export const PLAIN_TEXT: Readonly<Record<PlainLanguage, Readonly<{ title: string; reason: string }>>> = Object.freeze({
  en: Object.freeze({ title: 'Plain look', reason: 'It works, but nothing about it stands out.' }),
  fi: Object.freeze({ title: 'Tavallinen asu', reason: 'Toimii, mutta mikään ei erotu edukseen.' }),
  sv: Object.freeze({ title: 'Enkel look', reason: 'Fungerar, men inget sticker ut.' }),
});
