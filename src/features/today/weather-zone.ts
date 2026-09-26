// The zone's localized generic name ("Eastern European Time"); a runtime without one gives its offset. Never the IANA ID.
function zoneName(timeZone: string, at: number, locale: string): string | null {
  for (const style of ['longGeneric', 'shortOffset'] as const) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
      if (name && name !== timeZone) return name;
    } catch { /* try the next style */ }
  }
  return null;
}
const canonical = (timeZone: string): string | null => {
  try { return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; } catch { return null; }
};
const genericName = (timeZone: string, at: number, locale: string): string | null => {
  try { return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longGeneric' }).formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? null; } catch { return null; }
};
// The forecast's zone name, or null when it is the profile's zone under another ID (such as Asia/Calcutta and Asia/Kolkata)
// or has the same generic name. A profile zone that can't be resolved counts as different.
export function forecastZoneSuffix(forecastZone: string, profileZone: string, at: number, locale: string): string | null {
  const forecast = canonical(forecastZone), profile = canonical(profileZone);
  if (forecast !== null && forecast === profile) return null;
  const name = genericName(forecastZone, at, locale);
  if (profile !== null && name !== null && name === genericName(profileZone, at, locale)) return null;
  return zoneName(forecastZone, at, locale);
}
