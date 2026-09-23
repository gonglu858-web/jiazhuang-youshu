const pad = value => String(value).padStart(2, '0');

function day(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shift(value, offset) {
  const [year, month, date] = value.split('-').map(Number);
  return day(new Date(year, month - 1, date + offset, 12));
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, date] = value.split('-').map(Number);
  return day(new Date(year, month - 1, date, 12)) === value;
}

function time(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${day(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { day, shift, validDay, time };
