import { useEffect, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import { readAdminStatus } from '../../data/admin';
import type { AppClient } from '../../data/client';
import type { Translate } from '../../i18n';

// Settings: the admin gets a link to the spending view; anyone else sees who sets the AI limits. Nothing is shown when
// the check itself fails. The answer lives only in this component, so it goes with the account it was read for.
export function AdminEntry({ client, scope, t }: { client: AppClient; scope: OwnerScope; t: Translate }) {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readAdminStatus(client, scope, controller.signal).then((value) => { if (!controller.signal.aborted) setAdmin(value); }, () => undefined);
    return () => controller.abort();
  }, [client, scope]);
  if (admin === null) return null;
  return <p className="admin-entry">{admin ? <a className="button button-secondary" href="#/admin">{t('admin.title')}</a>
    : <span className="muted">{t('admin.note')}</span>}</p>;
}
