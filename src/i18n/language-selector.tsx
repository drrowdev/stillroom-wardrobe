import { languages, type Language, type Translate } from './index';

type Props = { language: Language; onChange: (language: Language) => void; t: Translate; disabled?: boolean };

export function LanguageSelector({ language, onChange, t, disabled = false }: Props) {
  return (
    <fieldset className="language-selector" disabled={disabled}>
      <legend className="sr-only">{t('language.label')}</legend>
      {languages.map((value) => (
        <button
          key={value}
          type="button"
          lang={value}
          aria-pressed={language === value}
          onClick={() => onChange(value)}
        >{t(`language.${value}`)}</button>
      ))}
    </fieldset>
  );
}
