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
import { ItemDetail } from '../features/wardrobe/item-detail';
import { detailRouteId } from '../domain/item-details';
import { DiscardDialog, type BeforeDiscard } from './dialog';
import { AiClient } from '../data/ai';
import type { AppClient } from '../data/client';
import { useWardrobeBrowse } from '../features/wardrobe/use-wardrobe-browse';
import { PrivateImages } from '../images/private-images';
import { LanguageSettings } from '../features/settings/language-settings';
import { UndoNotice } from '../features/settings/trash';
import { ItemLifecycleClient } from '../data/item-lifecycle';
import { newUndo, type LifecycleSnapshot, type UndoItem } from '../domain/item-lifecycle';
import type { ProfileRow } from '../data/rows';
import { PasswordRecovery, RecoveryRequest } from '../auth/password-recovery';
import { DeletionRecovery } from '../auth/deletion-recovery';
import { leaveDialogFor, navFamilyFor, outfitRouteId, type NavFamily } from '../domain/outfits';
import { OutfitLeaveDialog } from '../features/outfits/leave-dialog';
import { LazyBoundary } from './lazy';
import { UpdatePrompt } from '../pwa/update-prompt';
import { lazyNamed, preloadChunks } from './lazy-load';
import { WeatherStore, weatherKey } from '../features/today/use-weather';
import { weatherConfig } from '../domain/weather';
import { fitHeader } from './header-fit';
import {
  clearRecoveryNotice, leaveRecovery, markNormalAuthStarted, normalAuthStarted,
  recoverySnapshot, subscribeRecovery, type RecoveryCallback,
} from '../auth/recovery-callback';

const ProfileScreen = lazyNamed(() => import('../features/profile/profile-screen'), 'ProfileScreen');
const Trash = lazyNamed(() => import('../features/settings/trash-screen'), 'Trash');
const OutfitsScreen = lazyNamed(() => import('../features/outfits/outfits-screen'), 'OutfitsScreen');
const NewOutfit = lazyNamed(() => import('../features/outfits/detail'), 'NewOutfit');
const OutfitDetail = lazyNamed(() => import('../features/outfits/detail'), 'OutfitDetail');
const TodayScreen = lazyNamed(() => import('../features/today/today-screen'), 'TodayScreen');
const CalendarScreen = lazyNamed(() => import('../features/calendar/calendar'), 'CalendarScreen');
const StatisticsScreen = lazyNamed(() => import('../features/statistics/statistics-screen'), 'StatisticsScreen');
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
      <UpdatePrompt t={t} />
      <main id="main" className="entry-main">
        <div className="intro"><WardrobeIllustration /></div>
        {children}
      </main>
      <footer className="site-footer"><span>Stillroom Wardrobe</span></footer>
    </div>
  );
}
function Unconfigured({ status }: { status: Configuration['status'] }) {
  const [language, setLanguage] = useState(resolveLanguage(browserLanguages));
  const t = useCallback<Translate>((key, parameters) => translate(language, key, parameters), [language]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <EntryLayout language={language} onLanguage={setLanguage} t={t}><section className="entry-card setup-card"><div className="small-mark"><Icon name="wardrobe" /></div><h1>{t('setup.title')}</h1><p className="muted">{t(status === 'invalid' ? 'setup.invalid' : 'setup.body')}</p><details className="copy-details"><summary>{t('setup.instructions')}</summary><ol className="setup-steps"><li>{t('setup.step1')}<code>npm run db:start</code></li><li>{t('setup.step2')}<code>.env.local</code></li><li>{t('setup.step3')}</li></ol></details><p className="privacy-note"><Icon name="lock" />{t('setup.note')}</p></section></EntryLayout>;
}
type WorkspaceRoute = 'today' | 'wardrobe' | 'add' | 'settings' | 'trash' | 'outfits' | 'outfit-new' | 'calendar' | 'statistics' | `detail:${string}` | `outfit:${string}`;
const routeHash = { today: '#/today', wardrobe: '#/wardrobe', add: '#/items/new', settings: '#/settings', trash: '#/trash', outfits: '#/outfits', 'outfit-new': '#/outfits/new', calendar: '#/calendar', statistics: '#/statistics' };
function currentRoute(hash = location.hash): WorkspaceRoute {
  return hash === '#/today' ? 'today' : hash === '#/calendar' ? 'calendar' : hash === '#/statistics' ? 'statistics' : hash === '#/items/new' ? 'add' : hash === '#/settings' ? 'settings' : hash === '#/trash' ? 'trash'
    : hash === '#/outfits' ? 'outfits' : hash === '#/outfits/new' ? 'outfit-new'
      : hash.startsWith('#/outfits/') ? `outfit:${hash.slice(10)}`
        : hash.startsWith('#/items/') ? `detail:${hash}` : 'wardrobe';
}
function hashForRoute(route: WorkspaceRoute) {
  return route.startsWith('detail:') ? route.slice(7) : route.startsWith('outfit:') ? `#/outfits/${route.slice(7)}` : routeHash[route as keyof typeof routeHash];
}
const routeFocus: Partial<Record<WorkspaceRoute, string>> = { today: 'today-title', add: 'capture-title', settings: 'settings-title', trash: 'trash-title', outfits: 'outfits-title', 'outfit-new': 'outfit-editor-title', calendar: 'calendar-title', statistics: 'statistics-title' };
function OwnedWardrobe({ client, config, controller, scope, profile, change, busy, unresolved, t, language, online, onRouteCommitted }: { client: AppClient; config: PublicConfig; controller: SessionController; scope: OwnerScope; profile: ProfileRow; change: SessionState['profileChange']; busy: boolean; unresolved: boolean; t: Translate; language: Language; online: boolean; onRouteCommitted: (family: NavFamily) => void }) {
  const [route, setRoute] = useState<WorkspaceRoute>(() => currentRoute());
  const [outfitUnresolved, setOutfitUnresolved] = useState(false);
  const [outfitsInvalidation, setOutfitsInvalidation] = useState(0);
  const [outfitNotice, setOutfitNotice] = useState<string | null>(null);
  const [outfitSeed, setOutfitSeed] = useState<{ itemIds: string[]; occasion: string } | null>(null);
  const [calendarSeed, setCalendarSeed] = useState<{ outfitId: string } | null>(null);
  const invalidateOutfits = useCallback(() => setOutfitsInvalidation(value => value + 1), []);
  useEffect(() => {
    onRouteCommitted(navFamilyFor(route));
    setOutfitNotice(current => current !== null && route !== `outfit:${current}` ? null : current);
    if (route !== 'outfit-new') setOutfitSeed(null);
    if (route !== 'calendar') setCalendarSeed(null);
  }, [route, onRouteCommitted]);
  const browse = useWardrobeBrowse(client, scope, language, online);
  const invalidateHistory = browse.invalidateHistory;
  const calendarSeedUsed = useCallback(() => setCalendarSeed(null), []);
  const refresh = browse.refresh;
  const [notice, setNotice] = useState(false);
  const [undo, setUndo] = useState<UndoItem | null>(null);
  const [discard, setDiscard] = useState<{ next: WorkspaceRoute; position?: number } | null>(null);
  const discardFocus = useRef<HTMLElement | null>(null);
  const navigation = useRef({ route: currentRoute(), position: Number.isSafeInteger(history.state?.wardrobePosition) ? Number(history.state.wardrobePosition) : 0, restoring: false });
  const dirty = useRef({ dirty: false, incomplete: false, busy: false });
  // A route asked for while Settings is saving. It is followed once the save settles, through the normal leave guard.
  // A Back/Forward request keeps its history position so it is replayed as a traversal, not a new entry.
  // Calendar and outfit wear writes hold navigation the same way, from their own page.
  const queued = useRef<{ from: WorkspaceRoute; next: WorkspaceRoute; position?: number } | null>(null);
  const writing = useRef(false);
  const [settled, setSettled] = useState(0);
  const images = useMemo(() => new PrivateImages(client, scope), [client, scope]);
  const ai = useMemo(() => new AiClient(client, config, scope), [client, config, scope]);
  const lifecycle = useMemo(() => new ItemLifecycleClient(client, config, scope), [client, config, scope]);
  const [weatherStore] = useState(() => new WeatherStore());
  const weather = weatherConfig(profile);
  const weatherId = weatherKey(weather);
  useEffect(() => { weatherStore.keep(weatherId); }, [weatherStore, weatherId]);
  const routeLifetime = useRef(new AbortController());
  const routeSignal = useCallback(() => routeLifetime.current.signal, []);
  useEffect(() => {
    const current = new AbortController(); routeLifetime.current = current;
    return () => current.abort();
  }, [route]);
  const beforeDiscard = useRef<BeforeDiscard | null>(null);
  const onBeforeDiscard = useCallback((handler: BeforeDiscard | null) => { beforeDiscard.current = handler; }, []);
  const onDirty = useCallback((isDirty: boolean, incomplete: boolean, busy: boolean) => {
    const wasBusy = dirty.current.busy;
    dirty.current = { dirty: isDirty, incomplete, busy };
    if (wasBusy && !busy && queued.current) setSettled(value => value + 1);
  }, []);
  const onWriting = useCallback((busy: boolean) => {
    const was = writing.current;
    writing.current = busy;
    if (was && !busy && queued.current) setSettled(value => value + 1);
  }, []);
  useEffect(() => { images.activate(); return () => images.clear(); }, [images]);
  useEffect(preloadChunks, []);
  const changeRoute = useCallback((next: WorkspaceRoute) => {
    if (next === navigation.current.route) return;
    if (dirty.current.dirty || dirty.current.busy || writing.current) {
      if (!dirty.current.busy && !writing.current) {
        discardFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setDiscard({ next });
      } else if (writing.current || navigation.current.route === 'settings') queued.current = { from: navigation.current.route, next };
      return;
    }
    queued.current = null;
    dirty.current = { dirty: false, incomplete: false, busy: false };
    navigation.current = { route: next, position: navigation.current.position + 1, restoring: false };
    history.pushState({ ...history.state, wardrobePosition: navigation.current.position }, '', hashForRoute(next));
    setRoute(next);
  }, []);
  useEffect(() => {
    history.replaceState({ ...history.state, wardrobePosition: navigation.current.position }, '', location.href);
    const onHash = () => {
      const current = navigation.current;
      if (current.restoring) {
        if (history.state?.wardrobePosition === current.position) {
          current.restoring = false;
          if (queued.current && !dirty.current.busy && !writing.current) setSettled(value => value + 1);
        }
        return;
      }
      const next = currentRoute();
      const position = typeof history.state?.wardrobePosition === 'number' ? history.state.wardrobePosition : current.position + 1;
      if (history.state?.wardrobePosition !== position) history.replaceState({ ...history.state, wardrobePosition: position }, '', location.href);
      if (next === current.route) { current.position = position; return; }
      if ((dirty.current.dirty || dirty.current.busy || writing.current) && next !== current.route && position !== current.position) {
        current.restoring = true;
        if (!dirty.current.busy && !writing.current) {
          discardFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setDiscard({ next, position });
        } else if (writing.current || current.route === 'settings') queued.current = { from: current.route, next, position };
        history.go(current.position - position);
        return;
      }
      navigation.current = { route: next, position, restoring: false };
      queued.current = null;
      dirty.current = { dirty: false, incomplete: false, busy: false };
      setRoute(next);
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      const href = anchor?.getAttribute('href');
      const next = href && (Object.values(routeHash).includes(href) || href.startsWith('#/items/') || href.startsWith('#/outfits/')) ? currentRoute(href) : null;
      if (next) { event.preventDefault(); if (navigation.current.route.startsWith('detail:') || navigation.current.route.startsWith('outfit')) anchor?.focus(); changeRoute(next); }
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
  useEffect(() => {
    const request = queued.current;
    if (!request || dirty.current.busy || writing.current || navigation.current.restoring || scope.signal.aborted) return;
    queued.current = null;
    if (navigation.current.route !== request.from) return;
    if (request.position === undefined) changeRoute(request.next);
    else if (dirty.current.dirty) {
      discardFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDiscard({ next: request.next, position: request.position });
    } else history.go(request.position - navigation.current.position);
  }, [settled, changeRoute, scope]);
  // Today's "Turn on weather" opens Settings at the Weather card.
  const weatherFocus = useRef(false);
  const focusRoute = useCallback(() => {
    // The flag stays set while Settings is shown, since focusRoute can run twice for one visit.
    const card = weatherFocus.current && route === 'settings' ? document.getElementById('weather-heading') : null;
    if (card) { card.focus(); return; }
    if (route !== 'settings') weatherFocus.current = false;
    document.getElementById(routeFocus[route] ?? (route.startsWith('detail:') ? 'item-detail-title' : route.startsWith('outfit:') ? 'outfit-detail-title' : 'wardrobe-title'))?.focus();
  }, [route]);
  useEffect(focusRoute, [focusRoute]);
  function trashed(item: LifecycleSnapshot) {
    dirty.current = { dirty: false, incomplete: false, busy: false };
    browse.remove(item.id);
    setUndo(newUndo(item)); setNotice(false);
    changeRoute('wardrobe'); void refresh(); invalidateOutfits();
  }
  function saved() {
    dirty.current = { dirty: false, incomplete: false, busy: false };
    setNotice(true);
    changeRoute('wardrobe');
    void refresh(); invalidateOutfits();
  }
  const settle = useCallback(() => {
    dirty.current = { dirty: false, incomplete: false, busy: false };
    setOutfitUnresolved(false); setDiscard(null);
  }, []);
  const outfitSaved = useCallback((id: string) => {
    settle(); setOutfitNotice(id); invalidateOutfits();
    changeRoute(`outfit:${id}`);
  }, [settle, invalidateOutfits, changeRoute]);
  const openOutfit = useCallback((id: string) => { settle(); changeRoute(`outfit:${id}`); }, [settle, changeRoute]);
  const outfitsBack = useCallback(() => changeRoute('outfits'), [changeRoute]);
  const outfitProps = {
    client, scope, images, online, t, invalidation: outfitsInvalidation, paused: discard !== null, onDirty,
    onOutfitUnresolved: setOutfitUnresolved, onSaved: outfitSaved, onOpen: openOutfit, onBack: outfitsBack,
  };
  return (
    <>
      <aside className="workspace-identity" aria-label={t('account.identity')}><span className="identity-dot" />{profile.display_name}</aside>
      <main id="main" className="workspace-main" tabIndex={-1}>
        {!online && <div className="notice notice-offline" role="status">{t('common.offline')} {t('common.stale')}</div>}
        {undo && <UndoNotice key={`${undo.item.id}:${undo.item.version}`} undo={undo} visible={route === 'wardrobe'} routeSignal={routeSignal} lifecycle={lifecycle} scope={scope} online={online} t={t} images={images}
          onRestored={() => { setUndo(null); void refresh(); invalidateOutfits(); }} />}
        {notice && route === 'wardrobe' && <div className="notice notice-success" role="status"><Icon name="check" /><span>{t('item.saved')}</span><button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setNotice(false)}><Icon name="close" /></button></div>}
        {outfitNotice && route === `outfit:${outfitNotice}` && <div className="notice notice-success" role="status"><Icon name="check" /><span>{t('outfits.saved')}</span><button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setOutfitNotice(null)}><Icon name="close" /></button></div>}
        <LazyBoundary key={route} t={t} onReady={focusRoute}>{route === 'add'
          ? <AddItem client={client} ai={ai} onBeforeDiscard={onBeforeDiscard} scope={scope} currency={profile.currency} language={language} t={t} online={online} onDirty={onDirty} onSaved={saved} onBack={() => changeRoute('wardrobe')} />
          : route === 'settings' ? <ProfileScreen client={client} ai={ai} images={images} unresolved={unresolved} controller={controller} scope={scope} profile={profile} change={change} busy={busy} t={t} language={language} online={online} onDirty={onDirty} onBack={() => changeRoute('wardrobe')} />
          : route === 'trash' ? <Trash lifecycle={lifecycle} scope={scope} online={online} t={t} language={language} images={images}
            onDeleting={itemId => setUndo(current => current?.item.id === itemId ? null : current)}
            onBack={() => changeRoute('wardrobe')} onChanged={() => { setUndo(null); void refresh(); invalidateOutfits(); }} />
          : route.startsWith('detail:') ? <ItemDetail key={route} client={client} scope={scope} itemId={detailRouteId(route.slice(7))} images={images}
            lifecycle={lifecycle} onTrashed={trashed} ai={ai} onBeforeDiscard={onBeforeDiscard}
            t={t} language={language} currency={profile.currency} online={online} onDirty={onDirty} onSaved={() => { void refresh(); invalidateOutfits(); }} onBack={() => changeRoute('wardrobe')} />
          : route === 'outfits' ? <OutfitsScreen client={client} scope={scope} invalidation={outfitsInvalidation} images={images} online={online} language={language} t={t}
            onCreate={() => changeRoute('outfit-new')} onAddItem={() => changeRoute('add')} />
          : route === 'outfit-new' ? <NewOutfit key={outfitSeed ? outfitSeed.itemIds.join('|') : 'blank'} {...outfitProps} initial={outfitSeed ?? undefined} />
          : route.startsWith('outfit:') ? <OutfitDetail key={route} {...outfitProps} id={outfitRouteId(route.slice(7))} timeZone={profile.timezone}
            onPlan={outfitId => { setCalendarSeed({ outfitId }); changeRoute('calendar'); }} onWorn={invalidateHistory} onWriting={onWriting} />
          : route === 'calendar' ? <CalendarScreen client={client} scope={scope} online={online} language={language} t={t} timeZone={profile.timezone}
            invalidation={outfitsInvalidation} seed={calendarSeed} onSeedUsed={calendarSeedUsed} onChanged={invalidateHistory} onWriting={onWriting} />
          : route === 'statistics' ? <StatisticsScreen client={client} scope={scope} online={online} language={language} t={t} currency={profile.currency} />
          : route === 'today' ? <TodayScreen client={client} scope={scope} images={images} online={online} language={language} t={t}
            timeZone={profile.timezone} invalidation={outfitsInvalidation} weather={weather} weatherStore={weatherStore} onAddItem={() => changeRoute('add')} onTurnOnWeather={() => { weatherFocus.current = true; }}
            onSave={(itemIds, occasion) => { setOutfitSeed({ itemIds, occasion }); changeRoute('outfit-new'); }} />
          : <WardrobeScreen browse={browse} images={images} t={t} language={language} online={online} onAdd={() => changeRoute('add')} onRefresh={refresh} />}</LazyBoundary>
      </main>
      {discard && leaveDialogFor(route) === 'outfit' && <OutfitLeaveDialog unresolved={outfitUnresolved} t={t}
        onStay={() => { setDiscard(null); requestAnimationFrame(() => { if (discardFocus.current?.isConnected) discardFocus.current.focus(); }); }}
        onLeave={() => {
          dirty.current = { dirty: false, incomplete: false, busy: false }; setDiscard(null); setOutfitUnresolved(false);
          if (discard.position !== undefined) history.go(discard.position - navigation.current.position);
          else changeRoute(discard.next);
        }} />}
      {discard && leaveDialogFor(route) === 'discard' && <DiscardDialog beforeConfirm={route === 'add' || route.startsWith('detail:')
        ? async () => beforeDiscard.current ? beforeDiscard.current() : route === 'add' ? 'unresolved' : 'cancelled' : undefined}
        title={t(route === 'settings' || route.startsWith('detail:') ? 'common.unsaved' : 'capture.discard')} t={t} onCancel={() => {
        setDiscard(null);
        if (route.startsWith('detail:')) requestAnimationFrame(() => { if (discardFocus.current?.isConnected) discardFocus.current.focus(); });
      }} onConfirm={() => {
        dirty.current = { dirty: false, incomplete: false, busy: false }; setDiscard(null);
        if (discard.position !== undefined) history.go(discard.position - navigation.current.position);
        else changeRoute(discard.next);
      }}><p>{t(route === 'settings' ? 'settings.discardBody' : route.startsWith('detail:') ? 'detail.discardPage' : dirty.current.incomplete ? 'capture.incompleteDiscard' : 'capture.discardBody')}</p></DiscardDialog>}
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
  const [navFamily, setNavFamily] = useState<NavFamily>('wardrobe');
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
        : state.phase === 'deleting' && state.scope && state.deletion ? <DeletionRecovery key={state.scope.epoch} client={client} controller={controller}
          scope={state.scope} deletion={state.deletion} online={online} t={t} onSignOut={() => { void signOut(); }} />
        : state.phase === 'locked' ? <section className="entry-card"><h1>{t('common.errorTitle')}</h1><p className="muted">{t('account.locked')}</p><div className="stack"><button className="button button-primary" onClick={() => { void controller.retry(); }} disabled={!online}>{t('common.retry')}</button><button className="button button-quiet" onClick={() => { void signOut(); }}>{t('auth.signOut')}</button></div></section>
          : <div>{callback.kind === 'none' && callback.notice && <p role="status" className="notice">{t(callback.notice)}</p>}{!online && <p role="status" className="notice notice-offline">{t('common.offline')}</p>}{state.notice === 'delete.done' ? <p className="notice notice-success" role="status">{t('delete.done')}</p>
            : (signOutError || state.notice) && <p className="notice notice-error" role="alert">{t(state.notice ?? 'auth.localSignOut')}</p>}<Login controller={controller} online={online} t={t} onAuthActivity={clearRecoveryNotice} onRecovery={() => { clearRecoveryNotice(); setRequestPassword(true); }} /></div>}
    </EntryLayout>;
  }
  return (
    <div className="workspace">
      {refusal && <aside className="notice" role="alert"><p>{t(refusal.notice ?? (refusal.kind === 'conflict' ? 'recovery.conflict' : 'recovery.invalid'))}</p><button type="button" className="text-button" onClick={() => leaveRecovery()}>{t('common.close')}</button></aside>}
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>{t('common.skipContent')}</a>
      <header className="workspace-header" ref={fitHeader}><Brand /><nav aria-label={t('nav.wardrobe')}>
        <a className={`nav-link${navFamily === 'today' ? ' active-nav' : ''}`} aria-current={navFamily === 'today' ? 'page' : undefined} href="#/today"><Icon name="today" />{t('nav.today')}</a>
        <a className={`nav-link${navFamily === 'wardrobe' ? ' active-nav' : ''}`} aria-current={navFamily === 'wardrobe' ? 'page' : undefined} href="#/wardrobe"><Icon name="wardrobe" />{t('nav.wardrobe')}</a>
        <a className={`nav-link${navFamily === 'outfits' ? ' active-nav' : ''}`} aria-current={navFamily === 'outfits' ? 'page' : undefined} href="#/outfits"><Icon name="outfits" />{t('nav.outfits')}</a>
        <a className={`nav-link${navFamily === 'calendar' ? ' active-nav' : ''}`} aria-current={navFamily === 'calendar' ? 'page' : undefined} href="#/calendar"><Icon name="calendar" />{t('nav.calendar')}</a>
        <a className={`nav-link${navFamily === 'statistics' ? ' active-nav' : ''}`} aria-current={navFamily === 'statistics' ? 'page' : undefined} href="#/statistics"><Icon name="statistics" />{t('nav.statistics')}</a>
      </nav><div className="account-controls"><button type="button" className="account-button" aria-expanded={menu} aria-label={t('account.menu')} onClick={() => setMenu(!menu)}><span className="avatar">{state.profile.display_name.slice(0, 1).toLocaleUpperCase(state.language)}</span><span title={state.profile.display_name}>{state.profile.display_name}</span><Icon name="chevron" /></button>{menu && <div className="account-popover"><a className="text-button" href="#/settings" onClick={() => setMenu(false)}>{t('nav.settings')}</a><a className="text-button" href="#/trash" onClick={() => setMenu(false)}>{t('nav.trash')}</a><LanguageSettings controller={controller} scope={state.scope} profile={state.profile} language={state.language} busy={Boolean(state.profileSaving)} online={online} t={t} /><button className="text-button" type="button" onClick={() => { void signOut(); }}>{t('auth.signOut')}</button></div>}</div></header>
      {state.languageUnsaved && <div className="language-warning notice" role="status"><span>{t('account.languageRetry')}</span><button className="text-button" disabled={!online || state.profileSaving} onClick={() => { void controller.retryLanguage(); }}>{t('common.retry')}</button></div>}
      <UpdatePrompt t={t} />
      <OwnedWardrobe key={state.scope.epoch} client={client} config={config} controller={controller} scope={state.scope} profile={state.profile} change={state.profileChange} busy={Boolean(state.profileSaving)} unresolved={Boolean(state.aiConsentUnresolved)} language={state.language} online={online} t={t} onRouteCommitted={setNavFamily} />
      <footer className="site-footer"><span>Stillroom Wardrobe</span></footer>
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
