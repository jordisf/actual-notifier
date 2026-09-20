// override: true para que un .env montado como volumen tenga prioridad y se recargue en cada ejecución sin reiniciar el contenedor.
require('dotenv').config({ override: true });
const nodemailer = require('nodemailer');
const actual = require('./actual');
const { compute } = require('./report');
const store = require('./store');
const bot = require('./telegram/bot');
const send = require('./telegram/send');
const { log } = require('./log');

/**
 * T4: attach the Actual tx id + account id to each report tx row so the
 * Telegram layer can persist interaction rows (write-back target). A missing
 * row is tolerated (id stays null; that tx gets no interactive message but
 * remains visible in summary + email).
 */
async function attachTxIds(handle, txRows, mesActual) {
  if (!txRows || txRows.length === 0) return txRows || [];
  const [y, m] = mesActual.split('-');
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const primerDia = `${mesActual}-01`;
  const ultimoDia = `${mesActual}-${String(lastDay).padStart(2, '0')}`;
  const matchKey = (fecha, beneficiario, importe) =>
    `${fecha}|${beneficiario}|${importe.toFixed(2)}`;

  const byKey = new Map(txRows.map((t) => [matchKey(t.fecha, t.beneficiario, t.importe), t]));
  const accounts = await handle.api.getAccounts();
  for (const account of accounts.filter((a) => !a.offbudget && !a.closed)) {
    try {
      const txs = await handle.api.getTransactions(account.id, primerDia, ultimoDia);
      for (const t of txs) {
        if (t.is_parent) continue;
        if (t.category != null && t.category !== '') continue; // keep only uncategorized
        if (t.transfer_id != null && t.transfer_id !== '') continue;
        const importe = (t.amount || 0) / 100;
        const row = byKey.get(matchKey(t.date, t.imported_payee || t.payee_name || 'Desconocido', importe));
        if (row) {
          row.id = t.id;
          row.account_id = account.id;
        }
      }
    } catch (errTx) {
      log('warn', 'cron', `No se pudieron leer transacciones de ${account.name}: ${errTx.message}`);
    }
  }
  return [...byKey.values()];
}

async function ejecutarReporteDiario() {
  const horaInicio = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  log('info', 'cron', `Conectando con Actual Budget en ${process.env.ACTUAL_SERVER_URL}...`, { horaInicio });

  // Cron siempre usa su propio dataDir efímero (marcador de throttle incluido).
  const handle = await actual.open('/tmp/actual-cache');
  // const api = handle.api;

  // =========================================================================
  // PASOS 1-3: SINCRONIZACIÓN + CATEGORIZACIÓN + DISPONIBILIDAD
  // (extracted to src/report.js — verbatim semantics)
  // =========================================================================
  const reporte = await compute(handle);
  const {
    syncOk, syncMensaje, mesActual, diasRestantes,
    transaccionesSinCategorizar, datosConsumo, categoriasNegativas, hoy
  } = reporte;

  // T4: the report layer (untouched) returns display fields only; the Actual
  // tx id + account id are looked up from the warm cache (same read the
  // report already did) and attached for the Telegram interaction rows.
  const txList = await attachTxIds(handle, transaccionesSinCategorizar, mesActual);

  // =========================================================================
  // PASO 4: MAQUETACIÓN HTML DEL CORREO
  // =========================================================================
  const badgeColor = syncOk ? '#e8f5e9' : '#fff3e0';
  const badgeTextColor = syncOk ? '#2e7d32' : '#e65100';
  const badgeBorder = syncOk ? '#a5d6a7' : '#ffb74d';
  const badgeIcon = syncOk ? '✅' : '⚠️';

  let html = `
  <div style="font-family: Arial, sans-serif; color: #2c3e50; max-width: 600px; margin: 0 auto; line-height: 1.5;">
    <h2 style="color: #0f4c81; border-bottom: 2px solid #0f4c81; padding-bottom: 6px; margin-bottom: 8px;">
      Estado Diario de Gasto Operativo
    </h2>
    <p style="color: #666; font-size: 14px; margin-top: 0; margin-bottom: 12px;">
      Ciclo: <strong>${mesActual}</strong> | Días restantes de mes: <strong>${diasRestantes} días</strong>
    </p>

    <!-- BLOQUE DINÁMICO: ESTADO DE SINCRONIZACIÓN BANCARIA -->
    <div style="padding: 10px 14px; background-color: ${badgeColor}; border: 1px solid ${badgeBorder}; border-radius: 4px; margin-bottom: 15px;">
      <p style="margin: 0; font-size: 13px; color: ${badgeTextColor}; font-weight: bold;">
        ${badgeIcon} Estado Sincronización Bancaria:
      </p>
      <p style="margin: 4px 0 0 0; font-size: 12px; color: #444;">
        ${syncMensaje}
      </p>
    </div>
  `;


    // BLOQUE CONDICIONAL: MOVIMIENTOS SIN CATEGORIZAR (Solo si existen)
  if (transaccionesSinCategorizar.length > 0) {
    html += `
    <div style="margin-bottom: 20px; padding: 12px 14px; background-color: #fff8e1; border-left: 4px solid #fbc02d; border-radius: 4px;">
      <h3 style="color: #f57f17; margin: 0 0 6px 0; font-size: 14px;">
        🔍 Movimientos pendientes de categorizar (${transaccionesSinCategorizar.length})
      </h3>
      <p style="font-size: 12px; color: #555; margin: 0 0 8px 0;">
        Se han descargado movimientos sin asignar a ningún sobre. Revisa la aplicación para mantener la disponibilidad al día:
      </p>
      <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: #333;">
        ${transaccionesSinCategorizar.map(t => `
          <li style="margin-bottom: 3px;">
            <strong>${t.fecha}:</strong> ${t.beneficiario} (${t.cuenta}) &rarr; <strong>${t.importe.toFixed(2)} €</strong>
          </li>
        `).join('')}
      </ul>
    </div>
    `;
  }

  
  // BLOQUE: CONSUMO DIARIO
  html += `
    <h3 style="color: #2e7d32; margin-top: 15px;">🛒 Consumo Operativo del Hogar</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      <thead>
        <tr style="background-color: #f8f9fa; text-align: left; border-bottom: 2px solid #dee2e6;">
          <th style="padding: 10px 8px;">Categoría</th>
          <th style="padding: 10px 8px; text-align: right;">Disponible</th>
          <th style="padding: 10px 8px; text-align: right;">Ritmo Diario</th>
        </tr>
      </thead>
      <tbody>
        ${datosConsumo.map(c => `
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px;">${c.nombre}</td>
            <td style="padding: 8px; text-align: right; font-weight: bold; color: ${c.saldo < 0 ? '#c62828' : '#2e7d32'};">
              ${c.saldo.toFixed(2)} €
            </td>
            <td style="padding: 8px; text-align: right; color: #6c757d;">
              ${c.ritmoDiario} €/día
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

    // BLOQUE CONDICIONAL: ALERTAS DE SOBREGASTO (Saldo negativo)
  if (categoriasNegativas.length > 0) {
    html += `
    <div style="margin-top: 25px; padding: 14px; background-color: #fdf2f2; border-left: 4px solid #c62828; border-radius: 4px;">
      <h3 style="color: #c62828; margin: 0 0 8px 0; font-size: 15px;">⚠️ Alertas de Saldo Negativo (Requieren Regularización)</h3>
      <p style="font-size: 13px; color: #555; margin-bottom: 8px;">
        Se ha detectado sobregasto en los siguientes sobres. Regulariza desde partidas operativas con excedente:
      </p>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px;">
        ${categoriasNegativas.map(cn => `
          <li style="margin-bottom: 4px; color: #b71c1c;">
            <strong>${cn.nombre}:</strong> ${cn.saldo.toFixed(2)} €
          </li>
        `).join('')}
      </ul>
    </div>
    `;
  }

    html += `
    <p style="margin-top: 25px; font-size: 12px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 12px;">
      Actual Budget v26.8.1 • Sincronización bancaria activa • La capacidad real de gasto reside exclusivamente en los sobres.
    </p>
  </div>
  `;

    // =========================================================================
  // PASO 5: ENVÍO SMTP MULTIDESTINATARIO
  // =========================================================================
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const transporter = nodemailer.createTransport({
    host: (process.env.SMTP_HOST || '').trim(),
    port: smtpPort,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465,
    auth: {
      user: (process.env.SMTP_USER || '').trim(),
      pass: (process.env.SMTP_PASS || '').trim().replace(/\s+/g, ''),
    },
  });

  // Composición inteligente del asunto
  let subjectTags = [];
  if (!syncOk) subjectTags.push('⚠️ Fallo Sincro Banco');
  if (transaccionesSinCategorizar.length > 0) subjectTags.push(`🔍 ${transaccionesSinCategorizar.length} sin categorizar`);
  if (categoriasNegativas.length > 0) subjectTags.push('⚠️ Alerta Sobregasto');

  const tagString = subjectTags.length > 0 ? ` [${subjectTags.join(' | ')}]` : '';


  // 1. Extraer y limpiar cada dirección de correo
  const destinatarios = (process.env.NOTIFICATION_EMAIL || '')
    .split(',')
    .map(email => email.trim())
    .filter(email => email.length > 0);

  log('info', 'cron', 'Lista de destinatarios procesada', { destinatarios });

  // 2. Enviar el correo pasando el array limpio
  const info = await transporter.sendMail({
    from: `"Finanzas JBDMO" <${(process.env.SMTP_USER || '').trim()}>`,
    to: destinatarios,
    subject: `Resumen de Gasto Diario - ${hoy.toLocaleDateString('es-ES')}${tagString}`,
    html: html
  });

  log('info', 'cron', `Reporte enviado a [${destinatarios.join(', ')}] (ID: ${info.messageId}).`);

  // =========================================================================
  // PASOS 6-9 (T4) — store row + Telegram delivery + expiry + retention.
  // Email already went out (PASO 5): everything below can NEVER affect the
  // email path or the exit contract (email failure ⇒ exit 1, above).
  // =========================================================================
  const db = store.open();

  try {
    const reportId = store.insertReport(db, {
      run_at: new Date().toISOString(),
      sync_ok: syncOk,
      sync_message: syncMensaje,
      tx_uncategorized_count: transaccionesSinCategorizar.length,
      email_sent: 1,
    });

    // -------------------------------------------------------------------------
    // PASO 7: ENTREGA TELEGRAM — ONE try/catch; any error ⇒ log, counts 0,
    // run still succeeds (channels are independent, design §7/§10).
    // -------------------------------------------------------------------------
    const tgToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const tgGroup = (process.env.TELEGRAM_GROUP_ID || '').trim();

    if (!tgToken || !tgGroup) {
      log('warn', 'cron', 'Telegram not configured; email-only mode', {
        hasToken: Boolean(tgToken),
        hasGroup: Boolean(tgGroup),
      });
    } else {
      try {
        const categories = await actual.getCategories(handle.api);
        const result = await send.sendReport({
          db,
          chatId: tgGroup,
          reportId,
          txList,
          categories,
          mesActual,
          syncMensaje,
          datosConsumo,
          categoriasNegativas,
        });
        store.setReportTelegram(db, reportId, {
          telegram_summary_sent: 1,
          telegram_tx_sent: result.sent,
        });
        log('info', 'cron', 'Entrega Telegram completada', {
          reportId,
          sent: result.sent,
          failed: result.failed,
        });
      } catch (errTg) {
        store.setReportTelegram(db, reportId, { telegram_summary_sent: 0, telegram_tx_sent: 0 });
        log('error', 'cron', 'Entrega Telegram fallida; el correo ya fue enviado y el run sigue en verde', {
          error: errTg.message,
        });
      }
    }

    // -------------------------------------------------------------------------
    // PASO 8: EXPIRY (D6) — store flips prior pending rows, then a
    // best-effort Telegram footer edit per just-expired message.
    // -------------------------------------------------------------------------
    const justExpired = store.expirePreviousPending(db, reportId);
    if (justExpired.length > 0) {
      log('info', 'cron', 'Interacciones previas expiradas', { count: justExpired.length, reportId });
    }
    for (const row of justExpired) {
      try {
        const text = send.buildExpiryText(row) + '\n⌛ Vencido por reporte nuevo';
        await bot.editMessageText(row.tg_chat_id, row.tg_message_id, text);
      } catch (errEdit) {
        log('warn', 'cron', `No se pudo editar el mensaje expirado (item_ref ${row.item_ref})`, {
          error: errEdit.message,
        });
      }
    }

    // -------------------------------------------------------------------------
    // PASO 9: RETENTION — 90-day answers sweep, one pass.
    // -------------------------------------------------------------------------
    const purged = store.answersRetentionSweep(db);
    if (purged > 0) {
      log('info', 'cron', 'Barrido de retención completado', { purged });
    }
  } finally {
    store.close(db);
  }

  await actual.close(handle);
}

ejecutarReporteDiario().catch(err => {
  console.error('Error al ejecutar el reporte:', err);
  process.exit(1);
});
