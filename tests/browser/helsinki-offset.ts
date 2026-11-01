// Helsinki's UTC offset in seconds at an instant: 7200 in winter, 10800 in summer. Fixtures that stand in for Open-Meteo
// need the offset the real zone has at the instant they describe, which changes twice a year.
export function helsinkiOffsetSeconds(at: number): number {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', timeZoneName: 'longOffset' })
    .formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? '';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) throw new Error(`Unexpected zone offset name: ${name}`);
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60);
}
