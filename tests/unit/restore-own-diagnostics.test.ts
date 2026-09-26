import { describe, expect, it } from 'vitest';
import { restoreDiagnostics } from '../fixtures/restore-own-diagnostics';

const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const canary = 'CANARY-restore-own-secret-7f3a';
const quiet = (text: string) => !text.includes(canary);

describe('restore-own gate diagnostics', () => {
  it('reports fixed outcomes, known refusal codes and de-IDed routes, never raw output', () => {
    const run = { code: 1, signal: null, stdout: '', stderr: `Checking the backup and its photos...\nRestore refused (refused). A request outside what a restore needs was refused. Nothing more was changed. ${id}\n` };
    const text = restoreDiagnostics(run, [`GET /rest/v1/items`, `POST /storage/v1/object/wardrobe/${id}/${id}/${id}/main.jpg`, 'GET /x?y=1'], true);
    expect(text).toContain('exit=1 signal=none');
    expect(text).toContain('outcomes=["Restore refused"]');
    expect(text).toContain('problems=["refused"]');
    expect(text).toContain('POST /storage/v1/object/wardrobe/ID/ID/ID/main.jpg');
    expect(text).toContain('unrecognizedRoutes=1');
    expect(text).not.toContain(id);
    expect(text).not.toContain('Checking the backup');
  });

  it('drops unknown refusal codes and route text that could carry a secret', () => {
    const run = { code: 1, signal: null, stdout: '', stderr: `Restore refused (${'Canaryword'}).` };
    const text = restoreDiagnostics(run, [`GET /rest/v1/${canary}`, `GET /rest/v1/items?apikey=${canary}`], true);
    expect(text).toContain('problems=[] unrecognizedProblems=1');
    expect(text).not.toContain('Canaryword');
    expect(text).not.toContain(canary);
  });

  it('reports only literal restore routes, counting any other REST, RPC or function name', () => {
    const run = { code: 2, signal: null, stdout: '', stderr: '' };
    const routes = ['GET /rest/v1/privatesecretcanary', 'POST /rest/v1/rpc/privatesecretcanary', 'POST /functions/v1/privatesecretcanary',
      'POST /rest/v1/rpc/save_outfit', 'POST /functions/v1/finalize-image-change', 'GET /storage/v1/object/wardrobe/privatesecretcanary/main.jpg'];
    const text = restoreDiagnostics(run, routes, true, ['POST /rest/v1/rpc/privatesecretcanary 404', 'POST /rest/v1/rpc/save_outfit 200',
      `POST /functions/v1/finalize-image-change 409`]);
    expect(text).toContain('routes=["POST /rest/v1/rpc/save_outfit","POST /functions/v1/finalize-image-change"] unrecognizedRoutes=4');
    expect(text).toContain('statuses=["POST /rest/v1/rpc/save_outfit 200 x1","POST /functions/v1/finalize-image-change 409 x1"]');
    expect(text).not.toContain('privatesecretcanary');
  });

  it('keeps only the fixed count lines of the summary', () => {
    const stdout = ['Items: 3 restored, 0 already here, 0 changed here and left as they are, 0 in Trash and left, 1 not finished, 0 blocked, 2 held back.',
      'Photos: 4 written, 0 already here, 0 not needed or not reached, 1 not finished, 0 blocked.', `Items: privatesecretcanary restored`].join('\n');
    const text = restoreDiagnostics({ code: 2, signal: null, stdout, stderr: '' }, [], true);
    expect(text).toContain('1 not finished, 0 blocked, 2 held back.');
    expect(text).toContain('Photos: 4 written');
    expect(text).not.toContain('privatesecretcanary');
  });

  it('suppresses all output content when the redaction check caught a secret', () => {
    const run = { code: 0, signal: null, stdout: 'Restore complete.', stderr: `Restore refused (refused). ${canary}` };
    const clean = quiet(run.stdout + run.stderr);
    expect(clean).toBe(false);
    const text = restoreDiagnostics(run, ['GET /rest/v1/items'], clean);
    expect(text).toBe(' exit=0 signal=none output=suppressed(redaction check failed)');
    expect(text).not.toContain(canary);
  });
});
