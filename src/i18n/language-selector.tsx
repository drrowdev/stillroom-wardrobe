import { languages, type Language, type Translate } from './index';

type Props = { language: Language; onChange: (language: Language) => void; t: Translate; disabled?: boolean; pending?: Language | null };

// While a language loads (`pending`), the buttons stay focusable but inert (aria-disabled), so focus does not drop.
export function LanguageSelector({ language, onChange, t, disabled = false, pending = null }: Props) {
  return (
    <fieldset className="language-selector" disabled={disabled} aria-busy={pending ? true : undefined}>
      <legend className="sr-only">{t('language.label')}</legend>
      {languages.map((value) => (
        <button
          key={value}
          type="button"
          lang={value}
          aria-pressed={language === value}
          aria-disabled={pending ? true : undefined}
          data-pending={pending === value ? '' : undefined}
          onClick={() => { if (!pending) onChange(value); }}
        >{t(`language.${value}`)}</button>
      ))}
    </fieldset>
  );
}