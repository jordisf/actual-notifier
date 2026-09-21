'use strict';
/**
 * Dev-only Telegram summary preview.
 *
 * Renders buildSummaryText with a generated (ad-hoc) model and prints it —
 * or sends it to the configured group with --send. No Actual connection,
 * no DB, no report pipeline: just the template + the model, the same two
 * pieces production joins in reporte-diario.js.
 *
 * Usage (from the repo or via `docker exec actual_notifier_dev`):
 *   node src/dev/preview-telegram.js                      # default model
 *   node src/dev/preview-telegram.js negativo             # one negative balance
 *   node src/dev/preview-telegram.js banco-omitido        # omitted-sync variant
 *   node src/dev/preview-telegram.js banco-fallos         # failed-sync variant
 *   node src/dev/preview-telegram.js sobregasto-largo     # long overspend name
 *   node src/dev/preview-telegram.js --file model.json    # your own model
 *   ... [--send]          # actually send to TELEGRAM_GROUP_ID
 *
 * A JSON model file matches the buildSummaryText inputs:
 *   { "mesActual": "2026-09",
 *     "syncMensaje": "Sincronización bancaria completada con éxito a las 20:22.",
 *     "txCount": 2,            // number of uncategorized tx (count-only line)
 *     "datosConsumo":   [{ "nombre", "saldo", "ritmoDiario" }, ...],
 *     "categoriasNegativas": [{ "nombre", "saldo" }, ...] }
 *
 * The sync message in the model should be the FULL report.js wording —
 * buildSummaryText compresses it via bankSyncLine just like production.
 */

const path = require('path');
const fs = require('fs');
const { buildSummaryText } = require('../telegram/send');
const bot = require('../telegram/bot');

// .env mount holds TELEGRAM_* (compose only provides ACTUAL_*).
function loadEnv(envPath) {
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) {
        const k = line.slice(0, i).trim();
        if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim();
      }
    }
  } catch {
    /* no .env: fine for the print-only path */
  }
}
loadEnv(process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env'));

const CONSUMO_BASE = [
  { nombre: 'Gasto Personal', saldo: 5, ritmoDiario: '0.50' },
  { nombre: 'Farmacia y Botiquin', saldo: 17.3, ritmoDiario: '1.73' },
  { nombre: 'Supermercado y Alimentación', saldo: 48.9, ritmoDiario: '4.89' },
  { nombre: 'Ocio y Restaurantes', saldo: -9, ritmoDiario: '0.00' },
  { nombre: 'Transporte', saldo: 0, ritmoDiario: '0.00' },
];

const BASE = {
  mesActual: '2026-09',
  syncMensaje: 'Sincronización bancaria completada con éxito a las 20:22.',
  txCount: 2,
  datosConsumo: CONSUMO_BASE,
  categoriasNegativas: [{ nombre: 'Suscripciones', saldo: -7.5 }],
};

const PRESETS = {
  por_defecto: BASE,
  // Every monitored category negative, plus a long-named overspend.
  todo_negativo: {
    mesActual: '2026-09',
    syncMensaje: 'Sincronización bancaria completada con éxito a las 20:22.',
    txCount: 4,
    datosConsumo: [
      { nombre: 'Gasto Personal', saldo: -3, ritmoDiario: '0.00' },
      { nombre: 'Farmacia y Botiquin', saldo: -12.4, ritmoDiario: '0.00' },
      { nombre: 'Supermercado y Alimentación', saldo: -75.25, ritmoDiario: '0.00' },
      { nombre: 'Ocio y Restaurantes', saldo: -9, ritmoDiario: '0.00' },
      { nombre: 'Transporte', saldo: -1.5, ritmoDiario: '0.00' },
    ],
    categoriasNegativas: [
      { nombre: 'Suscripciones', saldo: -7.5 },
      { nombre: 'Mantenimiento del hogar y servicios varios', saldo: -110.1 },
    ],
  },
  'banco-omitido': {
    ...BASE,
    syncMensaje: 'Sincronización bancaria omitida: ya se sincronizó hace 5 min (umbral: 60 min).',
  },
  'banco-fallos': {
    ...BASE,
    syncMensaje: 'No se pudo sincronizar con ING (timeout de conexión PSD2).',
  },
  sobregasto_largo: {
    ...BASE,
    categoriasNegativas: [
      { nombre: 'Varios servicios del hogar y comunidad', saldo: -110.1 },
    ],
  },
  vacio: {
    mesActual: '2026-09',
    syncMensaje: 'Sincronización bancaria completada con éxito a las 20:22.',
    txCount: 0,
    datosConsumo: CONSUMO_BASE.map((c) => ({ ...c, saldo: Math.abs(c.saldo) || 0.8, ritmoDiario: '0.08' })),
    categoriasNegativas: [],
  },
};

function usage() {
  console.error(`Uso: node preview-telegram.js [preset] [--file modelo.json] [--send]
Presets: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const sendFlag = args.includes('--send');
const fileIdx = args.indexOf('--file');
let model = null;
if (fileIdx >= 0) {
  const file = args[fileIdx + 1];
  if (!file) usage();
  model = { ...PRESETS.por_defecto, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} else {
  const preset = args.find((a) => !a.startsWith('--'));
  const key = preset
    ? Object.keys(PRESETS).find((k) => k === preset || k.replace(/_/g, '-') === preset)
    : 'por_defecto';
  if (!key) {
    console.error(`Preset desconocido: ${preset}`);
    usage();
  }
  model = PRESETS[key];
}

const text = buildSummaryText({
  mesActual: model.mesActual,
  syncMensaje: model.syncMensaje,
  txList: Array.from({ length: model.txCount || 0 }, () => ({})),
  datosConsumo: model.datosConsumo,
  categoriasNegativas: model.categoriasNegativas,
});

if (!sendFlag) {
  console.log('--- RESUMEN (preview, no enviado) ---');
  console.log(text);
  console.log('--- Para enviar al grupo: añade --send ---');
  process.exit(0);
}

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_ID) {
  console.error('Falta TELEGRAM_BOT_TOKEN o TELEGRAM_GROUP_ID en el .env (o ambiente).');
  process.exit(1);
}
bot
  .sendMessage(process.env.TELEGRAM_GROUP_ID, text, undefined, 'HTML')
  .then((res) => {
    console.log(`Enviado al grupo (message_id=${res && res.message_id}).`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fallo al enviar:', err.message);
    process.exit(1);
  });
