import { useEffect, useState, type KeyboardEvent } from 'react';
import { locales, resolveLanguage, type MessageKey, type Translate } from '../i18n';
import { aspectCrop, FULL_CROP, ORIGINAL_EDIT, validCrop, type Crop, type PhotoEdit } from './crop';

const fields: readonly (keyof Crop)[] = ['x', 'y', 'width', 'height'];
const labels: Record<keyof Crop, MessageKey> = {
  x: 'photo.cropX', y: 'photo.cropY', width: 'photo.cropWidth', height: 'photo.cropHeight',
};
const valuesFor = (crop: Crop) => ({
  x: String(crop.x * 100), y: String(crop.y * 100), width: String(crop.width * 100), height: String(crop.height * 100),
});
type Props = {
  preview: string; width: number; height: number; accepted: PhotoEdit; preparing: boolean; t: Translate;
  onApply: (edit: PhotoEdit) => void; onCancel: () => void;
};

export function CropEditor({ preview, width, height, accepted, preparing, t, onApply, onCancel }: Props) {
  const [turns, setTurns] = useState(accepted.turns);
  const [values, setValues] = useState(() => valuesFor(accepted.crop));
  const [aspect, setAspect] = useState('free');
  const [language, setLanguage] = useState(() => resolveLanguage([document.documentElement.lang]));
  useEffect(() => {
    const update = () => setLanguage(resolveLanguage([document.documentElement.lang]));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    update();
    document.getElementById('crop-editor-title')?.focus();
    return () => observer.disconnect();
  }, []);
  const crop = Object.fromEntries(fields.map((field) => [
    field, !/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(values[field].trim()) ? NaN : Number(values[field].replace(',', '.')) / 100,
  ])) as Crop;
  const valid = validCrop(crop);
  const w = turns % 2 ? height : width, h = turns % 2 ? width : height;
  const number = new Intl.NumberFormat(locales[language], { maximumFractionDigits: 1 });
  const edit = (next: Crop) => setValues(valuesFor(next));
  const rotate = (step: number) => {
    setTurns((turns + step + 4) % 4);
    edit(FULL_CROP);
    setAspect('free');
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (preparing || !valid || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.01;
    edit({
      ...crop,
      x: Math.max(0, Math.min(1 - crop.width, crop.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0))),
      y: Math.max(0, Math.min(1 - crop.height, crop.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))),
    });
  };
  return <section className="crop-editor" aria-labelledby="crop-editor-title" aria-busy={preparing}>
    <h2 id="crop-editor-title" tabIndex={-1}>{t('photo.crop')}</h2>
    <p id="crop-help" className="fine muted">{t('photo.cropHelp')}</p>
    <div className="crop-stage" style={{ aspectRatio: `${w} / ${h}` }}>
      <img src={preview} alt="" style={{
        width: `${(turns % 2 ? h / w : 1) * 100}%`, height: `${(turns % 2 ? w / h : 1) * 100}%`,
        transform: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
      }} />
      <div id="crop-rectangle" className="crop-rectangle" role="group" tabIndex={0}
        aria-label={t('photo.cropRectangle')} aria-describedby="crop-help crop-status" onKeyDown={nudge}
        style={{ left: `${(valid ? crop.x : 0) * 100}%`, top: `${(valid ? crop.y : 0) * 100}%`,
          width: `${(valid ? crop.width : 1) * 100}%`, height: `${(valid ? crop.height : 1) * 100}%` }} />
    </div>
    <p id="crop-status" className="fine" role="status">{valid
      ? t('photo.cropStatus', { x: number.format(crop.x * 100), y: number.format(crop.y * 100), width: number.format(crop.width * 100), height: number.format(crop.height * 100) })
      : t('photo.cropInvalid')}</p>
    <fieldset disabled={preparing}>
      <legend className="sr-only">{t('photo.crop')}</legend>
      <div className="crop-actions">
        <button className="button button-secondary" type="button" onClick={() => rotate(-1)}>{t('photo.rotateLeft')}</button>
        <button className="button button-secondary" type="button" onClick={() => rotate(1)} aria-label={t('photo.rotateRight')}>{t('photo.rotate')}</button>
        <button className="button button-quiet" type="button" onClick={() => { edit(FULL_CROP); setAspect('free'); }}>{t('photo.fit')}</button>
        <button className="button button-quiet" type="button" onClick={() => { setTurns(ORIGINAL_EDIT.turns); edit(FULL_CROP); setAspect('free'); }}>{t('photo.reset')}</button>
      </div>
      <div className="field"><label htmlFor="crop-aspect">{t('photo.cropAspect')}</label>
        <select id="crop-aspect" value={aspect} onChange={(event) => {
          const value = event.target.value; setAspect(value);
          if (value !== 'free') edit(aspectCrop(w, h, value === 'original' ? width / height : Number(value)));
        }}>
          <option value="free">{t('photo.cropFree')}</option>
          <option value="original">{t('photo.cropOriginal')}</option>
          {[1, 4 / 3, 3 / 4, 16 / 9].map((ratio) => <option key={ratio} value={ratio}>{t('photo.cropRatio', { ratio: number.format(ratio) })}</option>)}
        </select>
      </div>
      <div className="crop-fields">{fields.map((field) => <div className="field" key={field}>
        <label htmlFor={`crop-${field}`}>{t(labels[field])}</label>
        <input id={`crop-${field}`} type="text" inputMode="decimal" value={values[field]} aria-invalid={!valid}
          aria-describedby="crop-status" onChange={(event) => { setValues({ ...values, [field]: event.target.value }); setAspect('free'); }} />
      </div>)}</div>
      <button id="apply-crop" className="button button-primary" type="button" disabled={!valid} onClick={() => onApply({ turns, crop })}>{t('photo.applyCrop')}</button>
    </fieldset>
    <button className="button button-quiet" type="button" onClick={onCancel}>{t('photo.cancelCrop')}</button>
  </section>;
}
