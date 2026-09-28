// The version shown in the app, decided at build time. A Cloudflare Pages build names the commit it built, so the
// label can't go stale the way a hand-set Pages variable does; any other build keeps VITE_APP_VERSION.
export function appVersion(build: { CF_PAGES_COMMIT_SHA?: string | undefined; VITE_APP_VERSION?: string | undefined }): string {
  const commit = build.CF_PAGES_COMMIT_SHA?.trim() ?? '';
  if (/^[0-9a-f]{40}$/i.test(commit)) return commit.slice(0, 8).toLowerCase();
  return build.VITE_APP_VERSION?.trim() || '0.1.0';
}
