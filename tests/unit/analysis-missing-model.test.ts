import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAiStatus, photoModelNoticeWindowMs } from '../../src/domain/ai-controls';

const sql = readFileSync('supabase/migrations/20261008080000_analysis_model_identity.sql', 'utf8').replace(/\r\n/g, '\n');
const previous = readFileSync('supabase/migrations/20260924100100_azure_colour_manifest.sql', 'utf8').replace(/\r\n/g, '\n');
const body = (source: string, name: string) => {
  const start = source.indexOf(`function public.${name}(`);
  return source.slice(start, source.indexOf('\n$$;', start));
};
const finisher = body(sql, 'ai_finish_analysis');
const status = body(sql, 'ai_status');

describe('SAVE1 model identity: source contract', () => {
  it('replaces only the finisher and status, in one transaction', () => {
    expect([...sql.matchAll(/create (?:or replace )?function ([\w.]+)\(/g)].map((m) => m[1]))
      .toEqual(['public.ai_finish_analysis', 'public.ai_status']);
    expect(sql).toMatch(/^begin;$/m);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/\b(drop|alter table|grant|revoke)\b/i);
  });

  it('switches the account off only for control observations, counters or envelope overruns', () => {
    expect(finisher).toContain("v_bad := v_control<>'ordinary';");
    expect(previous).toContain("v_bad := v_model in ('response_missing_model','response_unrecognised_model') or v_control<>'ordinary';");
    expect(finisher).toContain("if k in ('cacheRead','cacheWrite') and n>0");
    expect(finisher).toContain('v_anomaly := (p_usage->>\'input\')::numeric>m.input_envelope');
    expect(finisher.match(/set activated=false/g)).toHaveLength(2);
  });

  it('fails the photo before permission and facts validation, after anomaly, terminal and expiry checks', () => {
    const order = ['if v_anomaly then', "elsif r.request_id is null or p_code='USAGE_ONLY'", 'elsif r.expires_at<=v_now',
      "elsif p_code='FAILED' or v_model in ('response_missing_model','response_unrecognised_model')",
      'elsif not private.ai_analysis_permitted', 'elsif not private.ai_valid_facts'].map((marker) => finisher.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps metering and the conflict guard untouched, and never marks a model as an anomaly', () => {
    for (const fragment of ['v_estimate := ceil(', "update private.ai_usage set accounted_micro=v_estimate,charge_state='estimated'",
      '(e.anomaly and e.normalized_usage is null)', 'or (e.model_observation is not null and e.model_observation<>\'not_observed\'']) {
      expect(finisher).toContain(fragment);
      expect(previous).toContain(fragment);
    }
    expect(finisher).not.toMatch(/anomaly=true[^;]*response_/);
  });

  it('adds the notice only on exact status version 2, from the request time and never the close time', () => {
    expect(status).toContain("->>'x-stillroom-ai-status-version'='2'");
    expect(status).toContain('max(coalesce(u.dispatched_at,u.created_at))+interval \'7 days\'');
    expect(status).toContain("e.model_observation='response_unrecognised_model'");
    expect(status).toContain("u.purpose='analysis'");
    expect(status).toContain('u.owner_id=p.owner_id');
    expect(status).not.toContain('closed_at');
    expect(status).toContain('case when v_notice>v_now');
  });

  it('keeps the legacy status keys', () => {
    const legacy = status.slice(status.indexOf('v_result := jsonb_build_object'), status.indexOf("if nullif(current_setting"));
    for (const key of ["'code'", "'period'", "'serverTimeMs'", "'consent'", "'policy'", "'usage'"]) expect(legacy).toContain(key);
    expect(legacy).not.toContain('photoModelNoticeUntilMs');
  });
});

describe('SAVE1 model identity: client contract', () => {
  const base = { code: 'OK', period: '2026-10', serverTimeMs: 1_790_000_000_000,
    consent: { enabled: true, noticeRevision: 2, consentedAt: '2026-10-01T00:00:00Z', profileVersion: '1' },
    policy: { activated: true, modelId: 'gpt-5.6-terra-2026-07-09', promptVersion: 2, noticeRevision: 2,
      executionManifestId: 'azure-eu-terra-devtest-v2', maxRequestMicro: '4097351', resultTtlSeconds: 3600 },
    budget: { monthlyAllowanceMicro: '100000000', usedMicro: '0', remainingMicro: '100000000', warning: false } };

  it('mirrors the seven-day server window', () => {
    expect(photoModelNoticeWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(status).toContain("interval '7 days'");
  });

  it('accepts the deadline only within the window, and only when negotiated', () => {
    const at = (until: number | null) => ({ ...base, photoModelNoticeUntilMs: until });
    expect(parseAiStatus(at(null), true)?.photoModelNoticeUntilMs).toBeNull();
    expect(parseAiStatus(at(base.serverTimeMs + photoModelNoticeWindowMs), true)).not.toBeNull();
    expect(parseAiStatus(at(base.serverTimeMs + photoModelNoticeWindowMs + 1), true)).toBeNull();
    expect(parseAiStatus(at(base.serverTimeMs - 1), true)).toBeNull();
    expect(parseAiStatus(base, true)).toBeNull();
    expect(parseAiStatus(at(null))).toBeNull();
    expect(parseAiStatus(base)).not.toBeNull();
  });
});
