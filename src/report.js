'use strict';

/**
 * Daily report computation (design §2 — report.js).
 *
 * This module contains steps 1–3 of the former `reporte-diario.js` monolith,
 * moved with VERBATIM semantics so the refactor is behavior-preserving:
 *   1. Automatic bank sync with a 60-minute throttle (stdout dump suppressed).
 *   2. Uncategorized-transaction detection for the current month.
 *   3. Target-category availability + full overspend sweep.
 *
 * It returns a plain `ReportData` object consumed by the orchestrator
 * (`reporte-diario.js`) and, from T4 on, by the Telegram delivery layer:
 *
 *   {
 *     syncOk,                 // boolean — bank sync succeeded (or skipped)
 *     syncMensaje,            // string  — human sync status for the report
 *     mesActual,              // string  — 'YYYY-MM'
 *     diasRestantes,          // number  — days left in the month (>= 1)
 *     transaccionesSinCategorizar, // array of {cuenta, fecha, beneficiario, importe}
 *     datosConsumo,           // array of {nombre, saldo, ritmoDiario}
 *     categoriasNegativas,    // array of {nombre, saldo}
 *     hoy                     // Date — snapshot used by the email subject
 *   }
 *
 * Signature: `compute(handle)` where `handle` is the object returned by
 * `actual.open(...)` — `{ api, dataDir }`. `dataDir` is required for the
 * bank-sync throttle marker path. The bank-sync stdout-suppression trick is
 * load-bearing (the Actual API dumps a large transaction list to stdout) and
 * is preserved exactly.
 *
 * `CATEGORIAS_OBJETIVO` lives here (exported) because it drives step 3; T4
 * may import it.
 */

const fs = require('fs');
const { log } = require('./log');

// 1. Categorías prioritarias de gasto corriente del hogar (Grupo 2)
const CATEGORIAS_OBJETIVO = [
  'Gasto Personal',
  'Farmacia y Botiquin',
  'Supermercado y Alimentación',
  'Ocio y Restaurantes',
  'Transporte'
];

async function compute(handle) {
  const { api, dataDir } = handle;

  // =========================================================================
  // PASO 1: SINCRONIZACIÓN BANCARIA AUTOMÁTICA (CON SALIDA SILENCIADA)
  // =========================================================================
  const horaInicio = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  log('info', 'cron', 'Conectando con entidad bancaria (ING)');
  let syncOk = false;
  let syncMensaje = '';

  // Throttle: solo sincronizar con el banco si la última vez fue hace más de una hora.
  const SYNC_INTERVAL_MS = 60 * 60 * 1000;
  const syncMarkerPath = `${dataDir}/last-bank-sync.txt`;
  let ultimaSync = null;
  try {
    ultimaSync = parseInt(fs.readFileSync(syncMarkerPath, 'utf8').trim(), 10);
    if (!Number.isFinite(ultimaSync)) ultimaSync = null;
  } catch {
    ultimaSync = null;
  }
  const msDesdeUltima = ultimaSync ? Date.now() - ultimaSync : null;

  // Interceptar temporalmente stdout para suprimir el dump de transacciones de Actual API
  const originalStdoutWrite = process.stdout.write;
  function silenciarSalida() {
    process.stdout.write = () => true;
  }
  function restaurarSalida() {
    process.stdout.write = originalStdoutWrite;
  }

  if (msDesdeUltima !== null && msDesdeUltima < SYNC_INTERVAL_MS) {
    const minutos = Math.round(msDesdeUltima / 60000);
    syncOk = true;
    syncMensaje = `Sincronización bancaria omitida: ya se sincronizó hace ${minutos} min (umbral: 60 min).`;
    log('info', 'cron', syncMensaje, { minutos });
  } else {
    try {
      silenciarSalida();
      await api.runBankSync();
      restaurarSalida();

      syncOk = true;
      syncMensaje = `Sincronización bancaria completada con éxito a las ${horaInicio}.`;
      fs.writeFileSync(syncMarkerPath, String(Date.now()));
      log('info', 'cron', 'Sincronización bancaria finalizada correctamente');
    } catch (syncError) {
      restaurarSalida();
      syncOk = false;
      syncMensaje = `No se pudo sincronizar con ING (${syncError.message || 'Error de conexión / PSD2'}).`;
      log('warn', 'cron', `Advertencia: ${syncMensaje}`);
    }
  }

  // =========================================================================
  // PASO 2: DETECCIÓN DE MOVIMIENTOS SIN CATEGORIZAR (MES EN CURSO)
  // =========================================================================
  const hoy = new Date();
  const mesActual = hoy.toISOString().slice(0, 7); // 'YYYY-MM'
  const primerDiaMes = `${mesActual}-01`;
  const ultimoDiaMesNum = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const ultimoDiaMesStr = `${mesActual}-${String(ultimoDiaMesNum).padStart(2, '0')}`;
  const diasRestantes = Math.max(1, ultimoDiaMesNum - hoy.getDate() + 1);

  // Consultar todas las cuentas operativas (On-Budget)
  const accounts = await api.getAccounts();
  const cuentasOnBudget = accounts.filter(a => !a.offbudget && !a.closed);

  let transaccionesSinCategorizar = [];

  for (const cuenta of cuentasOnBudget) {
    try {
      const txs = await api.getTransactions(cuenta.id, primerDiaMes, ultimoDiaMesStr);
      // Filtrar movimientos sin categoría que no sean transferencias internas neutras
      const sinCat = txs.filter(t =>
        !t.is_parent && // Evitar duplicar con transacciones padre desglosadas
        (t.category == null || t.category === '') &&
        (t.transfer_id == null || t.transfer_id === '')
      );

      sinCat.forEach(t => {
        transaccionesSinCategorizar.push({
          cuenta: cuenta.name,
          fecha: t.date,
          beneficiario: t.imported_payee || t.payee_name || 'Desconocido',
          importe: (t.amount || 0) / 100
        });
      });
    } catch (errTx) {
      log('warn', 'cron', `No se pudieron leer transacciones de ${cuenta.name}: ${errTx.message}`);
    }
  }
  log('info', 'cron', `Movimientos sin categorizar detectados: ${transaccionesSinCategorizar.length}`, {
    mesActual,
    transacciones: transaccionesSinCategorizar
  });

  // =========================================================================
  // PASO 3: EXTRACCIÓN Y CÁLCULO DE DISPONIBILIDAD PRESUPUESTARIA
  // =========================================================================
  const categoriesList = await api.getCategories();
  const budgetMonth = await api.getBudgetMonth(mesActual);

  const balanceMap = new Map();
  if (budgetMonth && budgetMonth.categoryGroups) {
    for (const group of budgetMonth.categoryGroups) {
      if (group.categories) {
        for (const cat of group.categories) {
          balanceMap.set(cat.id, (cat.balance || 0) / 100);
        }
      }
    }
  }

  // Procesar las 5 categorías operativas del hogar
  const datosConsumo = [];
  const categoriasMonitoreadasIds = new Set();

  for (const nombre of CATEGORIAS_OBJETIVO) {
    const cat = categoriesList.find(c => c.name.trim().toLowerCase() === nombre.trim().toLowerCase());
    if (cat) {
      categoriasMonitoreadasIds.add(cat.id);
      const balance = balanceMap.get(cat.id) || 0;
      datosConsumo.push({
        nombre: cat.name,
        saldo: balance,
        ritmoDiario: (balance > 0 ? balance / diasRestantes : 0).toFixed(2)
      });
    }
  }

  // Barrido integral de sobregastos en todo el presupuesto
  const categoriasNegativas = [];
  for (const cat of categoriesList) {
    if (cat.is_income) continue;
    const balance = balanceMap.get(cat.id) || 0;

    if (balance < 0 && !categoriasMonitoreadasIds.has(cat.id)) {
      categoriasNegativas.push({
        nombre: cat.name,
        saldo: balance
      });
    }
  }

  return {
    syncOk,
    syncMensaje,
    mesActual,
    diasRestantes,
    transaccionesSinCategorizar,
    datosConsumo,
    categoriasNegativas,
    hoy
  };
}

module.exports = { compute, CATEGORIAS_OBJETIVO };
