import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readConfiguration, type Configuration, type PublicConfig } from '../data/config';
import { makeClient } from '../data/client';
import { SessionController, type OwnerScope } from '../auth/session';
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
import { PasswordRecovery, RecoveryRequest } from '../auth/password-recovery';
import {
  leaveRecovery, markNormalAuthStarted, normalAuthStarted, recoveryReturnNotice,
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
function OwnedWardrobe({ client, scope, profileName, currency, t, language, online }: { client: AppClient; scope: OwnerScope; profileName: string; currency: string; t: Translate; language: Language; online: boolean }) {
  const [route, setRoute] = useState(location.hash === '#/items/new' ? 'add' : 'wardrobe');
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState(false);
  const [discard, setDiscard] = useState(false);
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
  const changeRoute = useCallback((next: 'wardrobe' | 'add') => {
    if (next === 'wardrobe' && dirty.current.dirty) {
      if (!dirty.current.busy) setDiscard(true);
      history.replaceState(null, '', '#/items/new');
      return;
    }
    setRoute(next);
    location.hash = next === 'add' ? '#/items/new' : '#/wardrobe';
  }, []);
  useEffect(() => {
    const onHash = () => changeRoute(location.hash === '#/items/new' ? 'add' : 'wardrobe');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [changeRoute]);
  useEffect(() => { document.getElementById(route === 'add' ? 'capture-title' : 'wardrobe-title')?.focus(); }, [route]);
  function saved() {
    dirty.current = { dirty: false, incomplete: false, busy: false };
    setNotice(true);
    changeRoute('wardrobe');
    void refresh();
  }
  return (
    <>
      <aside className="workspace-identity" aria-label={t('account.identity')}><span className="identity-dot" />{profileName}<span className="identity-separator" />{t('common.private')}</aside>
      <main id="main" className="workspace-main" tabIndex={-1}>
        {!online && <div className="notice notice-offline" role="status">{t('common.offline')} {t('common.stale')}</div>}
        {notice && route === 'wardrobe' && <div className="notice notice-success" role="status"><Icon name="check" /><span>{t('item.saved')}</span><button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setNotice(false)}><Icon name="close" /></button></div>}
        {route === 'add'
          ? <AddItem client={client} scope={scope} currency={currency} t={t} online={online} onDirty={onDirty} onSaved={saved} onBack={() => changeRoute('wardrobe')} />
          : <WardrobeScreen items={items} images={images} loading={loading} error={error} t={t} language={language} online={online} onAdd={() => changeRoute('add')} onRefresh={() => { void refresh(); }} />}
      </main>
      {discard && <DiscardDialog title={t('capture.discard')} t={t} onCancel={() => { setDiscard(false); location.hash = '#/items/new'; }} onConfirm={() => { dirty.current = { dirty: false, incomplete: false, busy: false }; setDiscard(false); changeRoute('wardrobe'); }}><p>{t(dirty.current.incomplete ? 'capture.incompleteDiscard' : 'capture.discardBody')}</p></DiscardDialog>}
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
  const returnFromRequest = useCallback(() => {
    setRequestPassword(false);
    requestAnimationFrame(() => document.getElementById('login-title')?.focus());
  }, []);
  const online = useOnline();
  const t = useCallback<Translate>((key, parameters) => translate(state.language, key, parameters), [state.language]);
  useEffect(() => controller.start(), [controller]);
  useEffect(() => { document.documentElement.lang = state.language; }, [state.language]);
  useEffect(() => {
    if (state.phase === 'signed-out' && !requestPassword && callback.kind === 'none') document.getElementById('login-title')?.focus();
  }, [state.phase, requestPassword, callback.kind]);
  const signOut = async () => {
    setMenu(false);
    setSignOutError(false);
    try { await controller.signOut(); } catch { setSignOutError(true); }
  };
  if (state.phase !== 'ready' || !state.profile || !state.scope) {
    return <EntryLayout language={state.language} onLanguage={(language) => controller.chooseLanguage(language)} t={t}>
      {callback.kind !== 'none' ? <RecoveryRefusal kind="conflict" t={t} />
        : state.phase === 'signed-out' && requestPassword ? <RecoveryRequest config={config} online={online} t={t} language={state.language} onReturn={returnFromRequest} />
        : state.phase === 'loading' ? <section className="entry-card connecting" aria-busy="true"><span className="spinner" /><p role="status">{t('common.loading')}</p></section>
        : state.phase === 'locked' ? <section className="entry-card"><h1>{t('common.errorTitle')}</h1><p className="muted">{t('account.locked')}</p><div className="stack"><button className="button button-primary" onClick={() => { void controller.retry(); }} disabled={!online}>{t('common.retry')}</button><button className="button button-quiet" onClick={() => { void signOut(); }}>{t('auth.signOut')}</button></div></section>
          : <div>{recoveryReturnNotice && <p role="status" className="notice">{t(recoveryReturnNotice)}</p>}{!online && <p role="status" className="notice notice-offline">{t('common.offline')}</p>}{(signOutError || state.notice) && <p className="notice notice-error" role="alert">{t(state.notice ?? 'auth.localSignOut')}</p>}<Login controller={controller} online={online} t={t} onRecovery={() => setRequestPassword(true)} /></div>}
    </EntryLayout>;
  }
  return (
    <div className="workspace">
      {callback.kind !== 'none' && <aside className="notice" role="alert"><p>{t('recovery.conflict')}</p><button type="button" className="text-button" onClick={() => leaveRecovery()}>{t('common.close')}</button></aside>}
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>{t('common.skipContent')}</a>
      <header className="workspace-header"><Brand /><nav aria-label={t('nav.wardrobe')}><a className="active-nav" href="#/wardrobe"><Icon name="wardrobe" />{t('nav.wardrobe')}</a></nav><div className="account-controls"><button type="button" className="account-button" aria-expanded={menu} aria-label={t('account.menu')} onClick={() => setMenu(!menu)}><span className="avatar">{state.profile.display_name.slice(0, 1).toLocaleUpperCase(state.language)}</span><span>{state.profile.display_name}</span><Icon name="chevron" /></button>{menu && <div className="account-popover"><button className="text-button" type="button" onClick={() => { void signOut(); }}>{t('auth.signOut')}</button></div>}</div></header>
      {state.languageUnsaved && <div className="language-warning notice" role="status"><span>{t('account.languageRetry')}</span><button className="text-button" disabled={!online} onClick={() => { void controller.retryLanguage(); }}>{t('common.retry')}</button></div>}
      <OwnedWardrobe key={state.scope.epoch} client={client} scope={state.scope} profileName={state.profile.display_name} currency={state.profile.currency} language={state.language} online={online} t={t} />
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
