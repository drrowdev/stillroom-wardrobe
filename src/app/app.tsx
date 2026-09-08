import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readConfiguration, type Configuration, type PublicConfig } from '../data/config';
import { makeClient } from '../data/client';
import { SessionController, type OwnerScope, type SessionState } from '../auth/session';
import { Login } from '../auth/login';
import { translate, resolveLanguage, type Language, type MessageKey, type Translate } from '../i18n';
import { LanguageSelector } from '../i18n/language-selector';
import { Icon, WardrobeIllustration } from './icon';
import { AddItem } from '../features/wardrobe/add-item';
import { WardrobeScreen } from '../features/wardrobe/wardrobe-screen';
import { DiscardDialog } from './dialog';
import { loadWardrobe } from '../data/items';
import { errorKey, isAborted } from '../data/errors';
import type { AppClient } from '../data/client';
import type { WardrobeItem } from '../domain/wardrobe';
import { PrivateImages } from '../images/private-images';
import { ProfileScreen } from '../features/profile/profile-screen';
import { LanguageSettings } from '../features/settings/language-settings';
import type { ProfileRow } from '../data/rows';
import { PasswordRecovery, RecoveryRequest } from '../auth/password-recovery';
import {
  clearRecoveryNotice, leaveRecovery, markNormalAuthStarted, normalAuthStarted,
  recoverySnapshot, subscribeRecovery, type RecoveryCallback,
} from '../auth/recovery-callback';

const configuration = readConfiguration(import.meta.env);
const browserLanguages = navigator.languages;
function Brand() {
  return <a href="#/wardrobe" className="brand"><span className="brand-icon"><Icon name="wardrobe" /></span><span>Stillroom<span className="brand-subtitle">WARDROBE</span></span></a>;
}
function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}
function EntryLayout({ children, language, onLanguage, t }: { children: ReactNode; language: Language; onLanguage: (language: Language) => void; t: Translate }) {
  return (
    <div className="entry-page">
      <header className="entry-header"><Brand /><LanguageSelector language={language} onChange={onLanguage} t={t} /></header>
      <main id="main" className="entry-main">
        <div className="intro"><p className="eyebrow">{t('intro.eyebrow')}</p><h2>{t('intro.title')}</h2><p className="intro-body">{t('intro.body')}</p><WardrobeIllustration /><div className="intro-caption"><span className="caption-line" />{t('intro.caption')}</div></div>
        {children}
      </main>
      <footer className="site-footer"><span>{t('intro.private')}</span><span>Stillroom Wardrobe</span></footer>
    </div>
  );
}
function Unconfigured({ status }: { status: Configuration['status'] }) {
  const [language, setLanguage] = useState(resolveLanguage(browserLanguages));
  const t = useCallback<Translate>((key, parameters) => translate(language, key, parameters), [language]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <EntryLayout language={language} onLanguage={setLanguage} t={t}><section className="entry-card setup-card"><div className="small-mark"><Icon name="wardrobe" /></div><h1>{t('setup.title')}</h1><p className="muted">{t(status === 'invalid' ? 'setup.invalid' : 'setup.body')}</p><ol className="setup-steps"><li>{t('setup.step1')}<code>npm run db:start</code></li><li>{t('setup.step2')}<code>.env.local</code></li><li>{t('setup.step3')}</li></ol><p className="privacy-note"><Icon name="lock" />{t('setup.note')}</p></section></EntryLayout>;
}
type WorkspaceRoute = 'wardrobe' | 'add' | 'settings';
const routeHash = { wardrobe: '#/wardrobe', add: '#/items/new', settings: '#/settings' };
function currentRoute(): WorkspaceRoute { return location.hash === '#/items/new' ? 'add' : location.hash === '#/settings' ? 'settings' : 'wardrobe'; }
function OwnedWardrobe({ client, controller, scope, profile, change, busy, t, language, online }: { client: AppClient; controller: SessionController; scope: OwnerScope; profile: ProfileRow; change: SessionState['profileChange']; busy: boolean; t: Translate; language: Language; online: boolean }) {
  const [route, setRoute] = useState<WorkspaceRoute>(currentRoute);
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState(false);
  const [discard, setDiscard] = useState<{ next: WorkspaceRoute; position?: number } | null>(null);
  const navigation = useRef({ route: currentRoute(), position: Number.isSafeInteger(history.state?.wardrobePosition) ? Number(history.state.wardrobePosition) : 0, restoring: false });
  const dirty = useRef({ dirty: false, incomplete: false, busy: false });
  const loadSequence = useRef(0);
  const images = useMemo(() => new PrivateImages(client, scope), [client, scope]);
  const onDirty = useCallback((isDirty: boolean, incomplete: boolean, busy: boolean) => { dirty.current = { dirty: isDirty, incomplete, busy }; }, []);
  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadWardrobe(client, scope);
      if (!scope.signal.aborted && sequence === loadSequence.current) setItems(next);
    } catch (problem) {
      if (!scope.signal.aborted && sequence === loadSequence.current && !isAborted(problem)) setError(errorKey(problem));
    } finally { if (!scope.signal.aborted && sequence === loadSequence.current) setLoading(false); }
  }, [client, scope]);
  useEffect(() => { images.activate(); void refresh(); return () => images.clear(); }, [refresh, images]);
  const changeRoute = useCallback((next: WorkspaceRoute) => {
    if (next === navigation.current.route) return;
    if (dirty.current.dirty || dirty.current.busy) {
      if (!dirty.current.busy) setDiscard({ next });
      return;
    }
    dirty.current = { dirty: false, incomplete: false, busy: false };
    navigation.current = { route: next, position: navigation.current.position + 1, restoring: false };
    history.pushState({ ...history.state, wardrobePosition: navigation.current.position }, '', routeHash[next]);
    setRoute(next);
  }, []);
  useEffect(() => {
    history.replaceState({ ...history.state, wardrobePosition: navigation.current.position }, '', routeHash[navigation.current.route]);
    const onHash = () => {
      const current = navigation.current;
      if (current.restoring) {
        if (history.state?.wardrobePosition === current.position) current.restoring = false;
        return;
      }
      const next = currentRoute();
      const position = typeof history.state?.wardrobePosition === 'number' ? history.state.wardrobePosition : current.position + 1;
      if (history.state?.wardrobePosition !== position) history.replaceState({ ...history.state, wardrobePosition: position }, '', location.href);
      if (next === current.route) { current.position = position; return; }
      if ((dirty.current.dirty || dirty.current.busy) && next !== current.route && position !== current.position) {
        current.restoring = true;
        if (!dirty.current.busy) setDiscard({ next, position });
        history.go(current.position - position);
        return;
      }
      navigation.current = { route: next, position, restoring: false };
      dirty.current = { dirty: false, incomplete: false, busy: false };
      setRoute(next);
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      const href = anchor?.getAttribute('href');
      const next = (Object.keys(routeHash) as WorkspaceRoute[]).find((key) => routeHash[key] === href);
      if (next) { event.preventDefault(); changeRoute(next); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    document.addEventListener('click', onClick);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash);
      document.removeEventListener('click', onClick); window.removeEventListener('beforeunload', beforeUnload);
      dirty.current = { dirty: false, incomplete: false, busy: false };
    };
  }, [changeRoute]);
  useEffect(() => { document.getElementById(route === 'add' ? 'capture-title' : route === 'settings' ? 'settings-title' : 'wardrobe-title')?.focus(); }, [route]);
  function saved() {
    dirty.current = { dirty: false, incomplete: false, busy: false };
    setNotice(true);
    changeRoute('wardrobe');
    void refresh();
  }
  return (
    <>
      <aside className="workspace-identity" aria-label={t('account.identity')}><span className="identity-dot" />{profile.display_name}<span className="identity-separator" />{t('common.private')}</aside>
      <main id="main" className="workspace-main" tabIndex={-1}>
        {!online && <div className="notice notice-offline" role="status">{t('common.offline')} {t('common.stale')}</div>}
        {notice && route === 'wardrobe' && <div className="notice notice-success" role="status"><Icon name="check" /><span>{t('item.saved')}</span><button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setNotice(false)}><Icon name="close" /></button></div>}
        {route === 'add'
          ? <AddItem client={client} scope={scope} currency={profile.currency} t={t} online={online} onDirty={onDirty} onSaved={saved} onBack={() => changeRoute('wardrobe')} />
          : route === 'settings' ? <ProfileScreen client={client} controller={controller} scope={scope} profile={profile} change={change} busy={busy} t={t} language={language} online={online} onDirty={onDirty} onBack={() => changeRoute('wardrobe')} />
          : <WardrobeScreen items={items} images={images} loading={loading} error={error} t={t} language={language} online={online} onAdd={() => changeRoute('add')} onRefresh={() => { void refresh(); }} />}
      </main>
      {discard && <DiscardDialog title={t(route === 'settings' ? 'common.unsaved' : 'capture.discard')} t={t} onCancel={() => setDiscard(null)} onConfirm={() => {
        dirty.current = { dirty: false, incomplete: false, busy: false }; setDiscard(null);
        if (discard.position !== undefined) history.go(discard.position - navigation.current.position);
        else changeRoute(discard.next);
      }}><p>{t(route === 'settings' ? 'settings.discardBody' : dirty.current.incomplete ? 'capture.incompleteDiscard' : 'capture.discardBody')}</p></DiscardDialog>}
    </>
  );
}
function Connected({ config, callback }: { config: PublicConfig; callback: RecoveryCallback }) {
  const [client] = useState(() => { markNormalAuthStarted(); return makeClient(config); });
  const [controller] = useState(() => new SessionController(client, browserLanguages));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [menu, setMenu] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [requestPassword, setRequestPassword] = useState(false);
  const refusal = callback.kind === 'none' ? null
    : callback.kind === 'link' ? { kind: 'conflict' as const, notice: undefined }
      : { kind: callback.kind, notice: callback.notice };
  const returnFromRequest = useCallback(() => {
    setRequestPassword(false);
    requestAnimationFrame(() => document.getElementById('login-title')?.focus());
  }, []);
  const online = useOnline();
  const t = useCallback<Translate>((key, parameters) => translate(state.language, key, parameters), [state.language]);
  useEffect(() => controller.start(), [controller]);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event !== 'INITIAL_SESSION' || session) clearRecoveryNotice();
    });
    return () => data.subscription.unsubscribe();
  }, [client]);
  useEffect(() => { document.documentElement.lang = state.language; }, [state.language]);
  useEffect(() => {
    if (state.phase === 'signed-out' && !requestPassword && callback.kind === 'none') document.getElementById('login-title')?.focus();
  }, [state.phase, requestPassword, callback.kind]);
  const signOut = async () => {
    clearRecoveryNotice();
    setMenu(false);
    setSignOutError(false);
    try { await controller.signOut(); } catch { setSignOutError(true); }
  };
  if (state.phase !== 'ready' || !state.profile || !state.scope) {
    return <EntryLayout language={state.language} onLanguage={(language) => controller.chooseLanguage(language)} t={t}>
      {refusal ? <RecoveryRefusal kind={refusal.kind} notice={refusal.notice} t={t} />
        : state.phase === 'signed-out' && requestPassword ? <RecoveryRequest config={config} online={online} t={t} language={state.language} onReturn={returnFromRequest} />
        : state.phase === 'loading' ? <section className="entry-card connecting" aria-busy="true"><span className="spinner" /><p role="status">{t('common.loading')}</p></section>
        : state.phase === 'locked' ? <section className="entry-card"><h1>{t('common.errorTitle')}</h1><p className="muted">{t('account.locked')}</p><div className="stack"><button className="button button-primary" onClick={() => { void controller.retry(); }} disabled={!online}>{t('common.retry')}</button><button className="button button-quiet" onClick={() => { void signOut(); }}>{t('auth.signOut')}</button></div></section>
          : <div>{callback.kind === 'none' && callback.notice && <p role="status" className="notice">{t(callback.notice)}</p>}{!online && <p role="status" className="notice notice-offline">{t('common.offline')}</p>}{(signOutError || state.notice) && <p className="notice notice-error" role="alert">{t(state.notice ?? 'auth.localSignOut')}</p>}<Login controller={controller} online={online} t={t} onAuthActivity={clearRecoveryNotice} onRecovery={() => { clearRecoveryNotice(); setRequestPassword(true); }} /></div>}
    </EntryLayout>;
  }
  return (
    <div className="workspace">
      {refusal && <aside className="notice" role="alert"><p>{t(refusal.notice ?? (refusal.kind === 'conflict' ? 'recovery.conflict' : 'recovery.invalid'))}</p><button type="button" className="text-button" onClick={() => leaveRecovery()}>{t('common.close')}</button></aside>}
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>{t('common.skipContent')}</a>
      <header className="workspace-header"><Brand /><nav aria-label={t('nav.wardrobe')}><a className="active-nav" href="#/wardrobe"><Icon name="wardrobe" />{t('nav.wardrobe')}</a></nav><div className="account-controls"><button type="button" className="account-button" aria-expanded={menu} aria-label={t('account.menu')} onClick={() => setMenu(!menu)}><span className="avatar">{state.profile.display_name.slice(0, 1).toLocaleUpperCase(state.language)}</span><span>{state.profile.display_name}</span><Icon name="chevron" /></button>{menu && <div className="account-popover"><a className="text-button" href="#/settings" onClick={() => setMenu(false)}>{t('nav.settings')}</a><LanguageSettings controller={controller} scope={state.scope} profile={state.profile} language={state.language} busy={Boolean(state.profileSaving)} online={online} t={t} /><button className="text-button" type="button" onClick={() => { void signOut(); }}>{t('auth.signOut')}</button></div>}</div></header>
      {state.languageUnsaved && <div className="language-warning notice" role="status"><span>{t('account.languageRetry')}</span><button className="text-button" disabled={!online || state.profileSaving} onClick={() => { void controller.retryLanguage(); }}>{t('common.retry')}</button></div>}
      <OwnedWardrobe key={state.scope.epoch} client={client} controller={controller} scope={state.scope} profile={state.profile} change={state.profileChange} busy={Boolean(state.profileSaving)} language={state.language} online={online} t={t} />
      <footer className="site-footer"><span>{t('intro.private')}</span><span>Stillroom Wardrobe</span></footer>
    </div>
  );
}
class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const language = resolveLanguage(browserLanguages);
    return <main className="fatal-error"><h1>{translate(language, 'common.errorTitle')}</h1><p>{translate(language, 'error.unavailable')}</p><button className="button button-primary" onClick={() => location.reload()}>{translate(language, 'common.retry')}</button></main>;
  }
}
export function App() {
  const callback = useSyncExternalStore(subscribeRecovery, recoverySnapshot);
  return <AppBoundary>{configuration.status !== 'ready' ? <Unconfigured status={configuration.status} />
    : callback.kind === 'none' || normalAuthStarted() ? <Connected config={configuration.value} callback={callback} />
      : <RecoveryEntry config={configuration.value} callback={callback} />}</AppBoundary>;
}
function RecoveryRefusal({ kind, t, notice }: { kind: 'invalid' | 'conflict'; t: Translate; notice?: MessageKey }) {
  useEffect(() => { document.getElementById('recovery-title')?.focus(); }, []);
  return <section className="entry-card recovery-card"><h1 id="recovery-title" tabIndex={-1}>{t('recovery.passwordTitle')}</h1><p role="alert">{t(notice ?? (kind === 'conflict' ? 'recovery.conflict' : 'recovery.invalid'))}</p><button type="button" className="button button-primary" onClick={() => leaveRecovery(notice)}>{t('recovery.return')}</button></section>;
}
function RecoveryEntry({ config, callback }: { config: PublicConfig; callback: RecoveryCallback }) {
  const [language, setLanguage] = useState(resolveLanguage(browserLanguages));
  const online = useOnline();
  const t = useCallback<Translate>((key, parameters) => translate(language, key, parameters), [language]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <EntryLayout language={language} onLanguage={setLanguage} t={t}>
    {callback.kind === 'link' ? <PasswordRecovery config={config} link={callback.link} online={online} t={t} onReturn={leaveRecovery} />
      : <RecoveryRefusal kind={callback.kind === 'conflict' ? 'conflict' : 'invalid'} notice={callback.notice} t={t} />}
  </EntryLayout>;
}
