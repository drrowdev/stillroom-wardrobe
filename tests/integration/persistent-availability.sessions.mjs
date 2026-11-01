import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal } from './ai-analysis.sessions.mjs';

// AVAIL1: catalog proof after 20261101080000. The nine replaced bodies equal the migration source byte for byte, and only
// the legacy Google term in the analysis permission still reads a review date. The historical stages keep their own
// expiry-dependent behaviour; this stage never changes a clock, a manifest row or a trigger.
const MIGRATION = '20261101080000_persistent_ai_availability.sql';
const FUNCTIONS = Object.freeze(['public.ai_claim_analysis', 'private.ai_analysis_permitted',
  'private.reserve_analyzed_item_save_v10', 'private.reserve_image_change', 'public.stylist_claim', 'public.enhance_claim',
  'private.tryon_permission', 'private.tryon_probe_permission', 'public.tryon_claim']);

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

function sourceBody(sql, name) {
  const header = `create or replace function ${name}(`, start = sql.indexOf(header);
  requireEvidence(start >= 0 && sql.indexOf(header, start + header.length) === -1);
  const open = sql.indexOf(' as $$\n', start), close = sql.indexOf('\n$$;', open);
  requireEvidence(open > start && close > open);
  const body = sql.slice(open + ' as $$'.length, close + 1);
  requireEvidence(!body.includes('$$'));
  return body;
}

export async function availabilityCatalogProbe(sql) {
  const source = await readFile(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  requireEvidence(!source.includes('\r'));
  const state = JSON.parse(await sql(`select jsonb_object_agg(f.name,(select coalesce(jsonb_agg(jsonb_build_object(
      'md5',md5(p.prosrc),'dates',(length(p.prosrc)-length(replace(p.prosrc,'review_expires_at','')))/length('review_expires_at'),
      'definer',p.prosecdef,'config',coalesce(p.proconfig,'{}'::text[]))),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=f.name))
    from (values ${FUNCTIONS.map((name) => `(${literal(name)})`).join(',')}) as f(name);`));
  for (const name of FUNCTIONS) {
    requireEvidence(Array.isArray(state[name]) && state[name].length === 1);
    equal(state[name][0].md5, createHash('md5').update(sourceBody(source, name)).digest('hex'));
    equal(state[name][0].dates, name === 'private.ai_analysis_permitted' ? 1 : 0);
    requireEvidence(state[name][0].config.includes('search_path='));
  }
}
