// Tests and tools only (a unit guard keeps it out of src/): every startup catalogue in every language, installed on
// import, plus the try-on catalogue. The app itself fetches one language at a time through ./load.
import baseMessages from './messages.json' with { type: 'json' };
import phaseZeroMessages from './phase-zero.json' with { type: 'json' };
import tryOnMessages from './tryon.json' with { type: 'json' };
import { installCatalogue, languages, registerMessages } from './index';

const startup = { ...baseMessages, ...phaseZeroMessages };
export const messages = { ...startup, ...tryOnMessages };
for (const language of languages) {
  installCatalogue(language, Object.fromEntries(Object.entries(startup).map(([key, entry]) => [key, entry[language]])));
}
registerMessages(tryOnMessages);

export * from './index';