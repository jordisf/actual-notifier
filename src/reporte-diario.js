// override: true para que un .env montado como volumen tenga prioridad y se recargue en cada ejecución sin reiniciar el contenedor.
require('dotenv').config({ override: true });
const nodemailer = require('nodemailer');
const actual = require('./actual');
const { compute } = require('./report');
const { log } = require('./log');

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
  // PASOS 6-9 (T4): row de reporte + entrega Telegram + expiración + barrido
  // de retención — se insertarán aquí, DESPUÉS del envío de correo, sin
  // tocar el contrato de salida 0/1 de este bloque SMTP.
  // =========================================================================

  await actual.close(handle);
}

ejecutarReporteDiario().catch(err => {
  console.error('Error al ejecutar el reporte:', err);
  process.exit(1);
});
