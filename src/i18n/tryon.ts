// VTO-2: registers the try-on messages. Imported for its side effect by every try-on module, so the catalog loads with
// those lazy chunks and stays out of the signed-out startup payload.
import tryOnMessages from './tryon.json' with { type: 'json' };
import { registerMessages } from './index';

registerMessages(tryOnMessages);
