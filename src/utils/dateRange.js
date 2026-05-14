function resolveSyncWindow({ startDate, endDate, lookbackDays, now = new Date() } = {}) {
  if (startDate || endDate) {
    if (!startDate || !endDate) {
      throw new Error("Provide both startDate and endDate, or provide neither and use lookbackDays.");
    }

    const start = startOfDay(parseDateInput(startDate, now.getFullYear()));
    const end = endOfDay(parseDateInput(endDate, now.getFullYear()));
    if (start > end) {
      throw new Error("startDate must be before or equal to endDate.");
    }

    return {
      startDate: start,
      endDate: end,
      label: `${formatDateOnly(start)} to ${formatDateOnly(end)}`
    };
  }

  if (lookbackDays !== undefined && lookbackDays !== null && lookbackDays !== "") {
    return resolveLookbackWindow({ lookbackDays, now });
  }

  const start = startOfCurrentWeek(now);
  const end = endOfDay(now);

  return {
    startDate: start,
    endDate: end,
    label: `current week (${formatDateOnly(start)} to ${formatDateOnly(end)})`
  };
}

function resolveLookbackWindow({ lookbackDays, now = new Date() } = {}) {
  const days = Number(lookbackDays || 14);
  if (!Number.isFinite(days) || days < 1 || days > 90) {
    throw new Error("lookbackDays must be between 1 and 90.");
  }

  const end = endOfDay(now);
  const start = startOfDay(new Date(now));
  start.setDate(start.getDate() - days);

  return {
    startDate: start,
    endDate: end,
    label: `last ${days} days`
  };
}

function startOfCurrentWeek(date, weekStartDay = 0) {
  const start = startOfDay(new Date(date));
  const offset = (start.getDay() - weekStartDay + 7) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

function parseDateInput(value, fallbackYear = new Date().getFullYear()) {
  if (value instanceof Date) {
    return new Date(value);
  }

  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Date value cannot be blank.");
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return buildLocalDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]), raw);
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = slashMatch[3] ? normalizeYear(Number(slashMatch[3])) : fallbackYear;
    return buildLocalDate(year, month, day, raw);
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(`Invalid date: ${raw}. Use YYYY-MM-DD or M/D/YYYY.`);
}

function buildLocalDate(year, month, day, originalValue) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid date: ${originalValue}`);
  }

  return date;
}

function normalizeYear(year) {
  return year < 100 ? 2000 + year : year;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  resolveSyncWindow,
  parseDateInput,
  startOfDay,
  endOfDay,
  formatDateOnly,
  startOfCurrentWeek,
  resolveLookbackWindow
};
