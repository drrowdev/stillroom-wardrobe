import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { locales, resolveLanguage, type MessageKey, type Translate } from '../i18n';
import {
  cropValues, FULL_CROP, HANDLE_FRAME_PX, handleMinimum, moveCrop, normalizeCrop, ORIGINAL_EDIT, parseCropValues, resizeCrop,
  sameEdit, validCrop, type Corner, type Crop, type PhotoEdit,
} from './crop';

const fields: readonly (keyof Crop)[] = ['x', 'y', 'width', 'height'];
const labels: Record<keyof Crop, MessageKey> = {
  x: 'photo.cropX', y: 'photo.cropY', width: 'photo.cropWidth', height: 'photo.cropHeight',
};
const corners: readonly Corner[] = ['nw', 'ne', 'sw', 'se'];
const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const MOVABLE = 1 - 1e-9;
type Values = Record<keyof Crop, string>;
type Props = {
  preview: string; width: number; height: number; accepted: PhotoEdit; preparing: boolean; t: Translate;
  onApply: (edit: PhotoEdit) => void; onCancel: () => void;
};

export function CropEditor({ preview, width, height, accepted, preparing, t, onApply, onCancel }: Props) {
  const [turns, setTurns] = useState(accepted.turns);
  const [values, setValues] = useState(() => cropValues(accepted.crop));
  const [frozen, setFrozen] = useState<Values | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [language, setLanguage] = useState(() => resolveLanguage([document.documentElement.lang]));
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: Crop; cleanup: () => void } | null>(null);
  useEffect(() => {
    const update = () => setLanguage(resolveLanguage([document.documentElement.lang]));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    update();
    document.getElementById('crop-editor-title')?.focus();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setStageSize((size) => size.width === rect.width && size.height === rect.height ? size : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const end = useCallback((commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.cleanup();
    if (!commit) setValues(cropValues(current.start));
    setFrozen(null);
  }, []);
  useEffect(() => { if (preparing) end(false); }, [preparing, end]);
  useEffect(() => () => { drag.current?.cleanup(); drag.current = null; }, []);
  const crop = parseCropValues(values);
  const valid = validCrop(crop);
  const frame = valid ? normalizeCrop(crop) : FULL_CROP;
  const movableX = valid && frame.width < MOVABLE, movableY = valid && frame.height < MOVABLE;
  const handles = valid && frame.width * stageSize.width >= HANDLE_FRAME_PX && frame.height * stageSize.height >= HANDLE_FRAME_PX;
  const quarter = ((turns % 4) + 4) % 4;
  const w = quarter % 2 ? height : width, h = quarter % 2 ? width : height;
  const number = new Intl.NumberFormat(locales[language], { maximumFractionDigits: 1 });
  const edit = (next: Crop) => setValues(cropValues(next));
  const shown = parseCropValues(frozen ?? values);
  const orientation = quarter ? t('photo.orientationTurned', { degrees: number.format(quarter * 90) }) : t('photo.orientationOriginal');
  const begin = (event: ReactPointerEvent<HTMLElement>, mode: 'move' | Corner) => {
    if (preparing || !valid || drag.current || !event.isPrimary || event.pointerType === 'mouse' && event.button !== 0) return;
    if (mode === 'move' && !movableX && !movableY) return;
    if (mode !== 'move' && !handles) return;
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget, pointerId = event.pointerId, startX = event.clientX, startY = event.clientY;
    const start = frame, minWidth = handleMinimum(rect.width), minHeight = handleMinimum(rect.height);
    const mine = (next: PointerEvent) => next.pointerId === pointerId && drag.current !== null;
    const move = (next: PointerEvent) => {
      if (!mine(next)) return;
      const dx = (next.clientX - startX) / rect.width, dy = (next.clientY - startY) / rect.height;
      setValues(cropValues(mode === 'move' ? moveCrop(start, dx, dy) : resizeCrop(start, mode, dx, dy, minWidth, minHeight)));
    };
    const release = (next: PointerEvent) => { if (mine(next)) end(true); };
    const cancel = (next: PointerEvent) => { if (mine(next)) end(false); };
    const blur = () => end(false);
    const hidden = () => { if (document.visibilityState === 'hidden') end(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    target.addEventListener('lostpointercapture', release);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', hidden);
    drag.current = {
      start,
      cleanup: () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', cancel);
        target.removeEventListener('lostpointercapture', release);
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', hidden);
      },
    };
    setFrozen(values);
    // Capture is optional: the window listeners above still follow and end the drag without it.
    try { target.setPointerCapture(pointerId); } catch { /* unsupported or synthetic pointer */ }
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (preparing || !valid || !arrows.includes(event.key)) return;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (horizontal ? !movableX : !movableY) return;
    event.preventDefault();
    const step = (event.shiftKey ? 0.1 : 0.01) * (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
    edit(moveCrop(crop, horizontal ? step : 0, horizontal ? 0 : step));
  };
  const touchAction = movableX && movableY ? 'none' : movableX ? 'pan-y' : movableY ? 'pan-x' : 'auto';
  return <section className="crop-editor" aria-labelledby="crop-editor-title" aria-busy={preparing}>
    <h2 id="crop-editor-title" tabIndex={-1}>{t('photo.edit')}</h2>
    <p id="crop-help" className="fine muted">{t('photo.cropHelp')}</p>
    <div ref={stage} className="crop-stage" style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(70vh * ${w} / ${h}))` }}>
      <img src={preview} alt="" style={{
        width: `${(quarter % 2 ? h / w : 1) * 100}%`, height: `${(quarter % 2 ? w / h : 1) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${quarter * 90}deg)`,
      }} />
      <div id="crop-rectangle" className="crop-rectangle" role="group" tabIndex={0} data-movable={movableX || movableY}
        aria-label={t('photo.cropRectangle')} aria-describedby="crop-help crop-status" onKeyDown={nudge}
        onPointerDown={(event) => begin(event, 'move')}
        style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, height: `${frame.height * 100}%`, touchAction }}>
        {handles && corners.map((corner) => <span key={corner} className="crop-handle" data-corner={corner} aria-hidden="true"
          onPointerDown={(event) => begin(event, corner)} />)}
      </div>
    </div>
    <p id="crop-status" className={valid ? 'sr-only' : 'field-error'} role="status">{valid
      ? t('photo.cropStatus', { orientation, x: number.format(shown.x * 100), y: number.format(shown.y * 100), width: number.format(shown.width * 100), height: number.format(shown.height * 100) })
      : t('photo.cropInvalid')}</p>
    <span id="crop-rotate-hint" className="sr-only">{t('photo.rotateHint')}</span>
    <fieldset disabled={preparing}>
      <div className="crop-tools">
        <button id="crop-rotate" className="button button-secondary" type="button" aria-describedby="crop-rotate-hint"
          onClick={() => { setTurns((quarter + 1) % 4); edit(FULL_CROP); }}>{t('photo.rotate')}</button>
        <button id="crop-reset" className="button button-quiet" type="button"
          onClick={() => { setTurns(ORIGINAL_EDIT.turns); edit(FULL_CROP); }}>{t('photo.reset')}</button>
      </div>
      <details className="crop-exact">
        <summary>{t('photo.cropExact')}</summary>
        <div className="crop-fields">{fields.map((field) => <div className="field" key={field}>
          <label htmlFor={`crop-${field}`}>{t(labels[field])}</label>
          <input id={`crop-${field}`} type="text" inputMode="decimal" value={values[field]} aria-invalid={!valid}
            aria-describedby="crop-status" onChange={(event) => setValues({ ...values, [field]: event.target.value })} />
        </div>)}</div>
      </details>
    </fieldset>
    <div className="crop-footer">
      <button id="apply-crop" className="button button-primary" type="button" disabled={!valid || preparing}
        onClick={() => { if (valid) { if (sameEdit({ turns, crop }, accepted)) onCancel(); else onApply({ turns, crop }); } }}>{t('photo.applyCrop')}</button>
      <button id="crop-cancel" className="button button-quiet" type="button" onClick={onCancel}>{t('photo.cancelCrop')}</button>
    </div>
  </section>;
}