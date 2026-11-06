// OUTFITGEN1b: registers the suggested-outfits messages. Imported for its side effect by every module that shows them,
// so the catalog loads with those lazy chunks and stays out of the signed-out startup payload.
import outfitGenMessages from './outfitgen.json' with { type: 'json' };
import { registerMessages } from './index';

registerMessages(outfitGenMessages);
