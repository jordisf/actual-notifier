'use strict';

/**
 * GET/POST /schedule (US4, FR-013/FR-014).
 *
 * crontab.txt holds one cron line: 5 whitespace-separated time fields
 * followed by the command. The panel only ever displays/edits the time
 * fields as one of three simplified modes (data-model.md Report Schedule);
 * the command suffix is preserved verbatim on every save. entrypoint.sh's
 * mtime-watcher (research.md) reinstalls the crontab after this write —
 * no signal from the panel to the notifier-cron container is needed.
 */

const fs = require('fs');
const path = require('path');

const { log } = require('../../log');
const { cronRead, cronWrite } = require('../config-store');

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'schedule.html');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Split one cron line into its 5 time fields plus the verbatim command
 * suffix (everything after the 5th field, including its separating
 * whitespace). Returns null if the line has fewer than 5 tokens.
 */
function splitCronLine(rawLine) {
  const m = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(\s[\s\S]*)?$/.exec(rawLine);
  if (!m) return null;
  return {
    minute: m[1],
    hour: m[2],
    day: m[3],
    month: m[4],
    weekday: m[5],
    commandSuffix: m[6] || '',
  };
}

/**
 * Recognize exactly one of the three supported shapes from a split cron
 * line, or 'raw' when it doesn't cleanly match any of them (data-model.md).
 */
function classifySchedule(split) {
  if (split.day !== '*' || split.month !== '*' || split.weekday !== '*') {
    return { mode: 'raw' };
  }
  const everyMinutes = /^\*\/(\d+)$/.exec(split.minute);
  if (everyMinutes && split.hour === '*') {
    return { mode: 'every-minutes', minutes: Number(everyMinutes[1]) };
  }
  const everyHours = /^\*\/(\d+)$/.exec(split.hour);
  if (split.minute === '0' && everyHours) {
    return { mode: 'every-hours', hours: Number(everyHours[1]) };
  }
  if (/^\d+$/.test(split.minute) && /^\d+$/.test(split.hour)) {
    const hh = String(Number(split.hour)).padStart(2, '0');
    const mm = String(Number(split.minute)).padStart(2, '0');
    return { mode: 'daily-at', time: `${hh}:${mm}` };
  }
  return { mode: 'raw' };
}

/** The current single schedule line, trimmed (empty string if the file has none). */
function currentLine() {
  const content = cronRead();
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length === 1 ? lines[0] : (lines.length === 0 ? '' : content.trim());
}

function currentSchedule() {
  const content = cronRead();
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length !== 1) {
    return { mode: 'raw', rawLine: content.trim() };
  }
  const split = splitCronLine(lines[0]);
  if (!split) return { mode: 'raw', rawLine: lines[0] };
  return Object.assign({ rawLine: lines[0] }, classifySchedule(split));
}

function render({ mode, minutes, hours, time, rawLine, error }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const errorHtml = error ? `<p style="color:red">${escapeHtml(error)}</p>` : '';
  const rawNoticeHtml = mode === 'raw'
    ? `<p><strong>Current schedule (raw, not editable here):</strong> <code>${escapeHtml(rawLine || '')}</code></p>` +
      '<p>Saving from this panel will replace it with one of the three supported modes below.</p>'
    : '';
  return template
    .replace('{{errorHtml}}', errorHtml)
    .replace('{{rawNoticeHtml}}', rawNoticeHtml)
    .replace('{{everyMinutesChecked}}', mode === 'every-minutes' ? 'checked' : '')
    .replace('{{everyHoursChecked}}', mode === 'every-hours' ? 'checked' : '')
    .replace('{{dailyAtChecked}}', mode === 'daily-at' ? 'checked' : '')
    .replace('{{minutesValue}}', escapeHtml(minutes != null && minutes !== '' ? String(minutes) : ''))
    .replace('{{hoursValue}}', escapeHtml(hours != null && hours !== '' ? String(hours) : ''))
    .replace('{{timeValue}}', escapeHtml(time || ''));
}

function register(router, ctx) {
  const { requireSession, parseBody, sendHtml, redirect } = ctx;

  router.get('/schedule', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      sendHtml(res2, 200, render(currentSchedule()));
    });
  });

  router.post('/schedule', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const mode = typeof body.mode === 'string' ? body.mode : '';

      const reject = (error, echo) => {
        sendHtml(res2, 400, render(Object.assign({ mode, error }, echo)));
      };

      const split = splitCronLine(currentLine());
      if (!split) {
        reject(
          'The current schedule line could not be parsed; fix its format directly in crontab.txt before saving from the panel.',
          { mode: 'raw', rawLine: currentLine() },
        );
        return;
      }

      let minuteField;
      let hourField;

      if (mode === 'every-minutes') {
        const minutes = Number(body.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
          reject('Minutes must be a whole number between 1 and 59.', { minutes: body.minutes });
          return;
        }
        minuteField = `*/${minutes}`;
        hourField = '*';
      } else if (mode === 'every-hours') {
        const hours = Number(body.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > 23) {
          reject('Hours must be a whole number between 1 and 23.', { hours: body.hours });
          return;
        }
        minuteField = '0';
        hourField = `*/${hours}`;
      } else if (mode === 'daily-at') {
        const timeMatch = /^(\d{1,2}):(\d{1,2})$/.exec(typeof body.time === 'string' ? body.time.trim() : '');
        if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) {
          reject('Time must be a valid HH:MM (00:00-23:59).', { time: body.time });
          return;
        }
        hourField = String(Number(timeMatch[1]));
        minuteField = String(Number(timeMatch[2]));
      } else {
        reject('Select one of the three schedule modes.', {});
        return;
      }

      const newLine = `${minuteField} ${hourField} * * *${split.commandSuffix}`;
      cronWrite(`${newLine}\n`);
      log('info', 'panel', 'schedule updated', { mode });
      redirect(res2, '/schedule');
    });
  });
}

module.exports = { register };
