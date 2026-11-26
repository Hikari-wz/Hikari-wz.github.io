const dayMs = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function localClock(instant: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const part = (kind: string) => parts.find(value => value.type === kind)?.value ?? '';
  return { day: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

function civilDate(day: string) {
  return new Date(`${day}T00:00:00Z`);
}
export const shiftDay = (day: string, offset: number) =>
  new Date(+civilDate(day) + offset * dayMs).toISOString().slice(0, 10);
export const dayDistance = (from: string, to: string) => (+civilDate(to) - +civilDate(from)) / dayMs;
export const monday = (day: string) => shiftDay(day, -((civilDate(day).getUTCDay() + 6) % 7));
export const daysOf = (week: string) => Array.from({ length: 7 }, (_, index) => shiftDay(week, index));
export const validDay = (day: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= '1900-01-01' && day <= '9998-12-31'
  && Number.isFinite(+civilDate(day)) && shiftDay(day, 0) === day;
export const validClock = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const clockMinute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return !!value;
  } catch {
    return false;
  }
};

export function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分` : ''}` : `${rest} 分钟`;
}

// Find the first instant of the civil day, including zones with midnight transitions.
export function startOfDay(day: string, timezone: string) {
  const utc = +civilDate(day);
  let low = utc - 2 * dayMs;
  let high = utc + 2 * dayMs;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localClock(middle, timezone).day < day) low = middle;
    else high = middle;
  }
  return high;
}
