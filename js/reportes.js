// ============================================================
// reportes.js — Reportes de ventas y ganancia (solo admin)
// ------------------------------------------------------------
// Regla: solo se cuenta DINERO COBRADO.
//  - Ventas normales (efectivo, Yape, Plin, tarjeta) en su fecha.
//  - Ventas al crédito: NO cuentan en su fecha.
//  - Cobros de créditos ("cobros"): cuentan en la FECHA DEL PAGO con el
//    método con que pagaron. Su costo se cuenta en proporción a lo
//    cobrado: costo del crédito × monto cobrado / total del crédito.
//    Los productos del crédito cuentan en "más vendidos" cuando se paga
//    completo.
//
// Ganancia bruta = ventas cobradas − costo de producción.
// Ganancia neta  = ganancia bruta − pagos a trabajadores.
// Compras de insumos: solo informativo (su costo ya está en el costo
// de producción de cada producto).
//
// Todas las consultas filtran por UN solo campo (fecha o estado), así
// Firestore no necesita índices compuestos. Usa Chart.js y SheetJS.
// ============================================================

import { db, collection, doc, getDoc, getDocs, query, where, orderBy, Timestamp } from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, soloFecha, escaparHTML, aviso,
  mensajeError, claveDiaLima, inicioDiaLima, sumarDias, diaSemana,
  calcularTotales, METODOS, NOMBRES_METODO, tieneCosto, itemTieneCosto,
  costoDeItems, porcentaje, cantidadConUnidad
} from "./comun.js";

const CONCEPTOS = { sueldo: "Sueldo", adelanto: "Adelanto", bono: "Bono", otro: "Otro" };
const METODOS_PAGO = { efectivo: "Efectivo", yape: "Yape", plin: "Plin", transferencia: "Transferencia" };

// Elementos
const textoRango = document.getElementById("textoRango");
const filtrosRapidos = document.getElementById("filtrosRapidos");
const formRango = document.getElementById("formRango");
const inDesde = document.getElementById("desde");
const inHasta = document.getElementById("hasta");
const btnExcel = document.getElementById("btnExcel");
const tablaTop = document.getElementById("tablaTop");
const tablaDetalle = document.getElementById("tablaDetalle");
const bannerSinCosto = document.getElementById("bannerSinCosto");
const ordenTop = document.getElementById("ordenTop");

// Estado
let rango = null;        // { desde: "AAAA-MM-DD", hasta: "AAAA-MM-DD" } (ambos incluidos)
let ventas = [];         // ventas del rango SIN las de crédito (incluye anuladas)
let cobros = [];         // cobros de créditos del rango (con costoCobro calculado)
let pagosTrab = [];      // pagos a trabajadores del rango
let compras = [];        // compras de insumos del rango
let productosCatalogo = [];
let totales = null;      // resultado de calcularTotales
let ganancia = null;     // { ventas, costo, bruta, margen, pagos, neta, compras }
let pendiente = { total: 0, cantidad: 0 }; // créditos pendientes actuales (informativo)
let topProductos = [];
let ordenProductos = "cantidad";
let porDia = [];         // [{ clave, total, costo, ganancia, num }]
let movimientos = [];    // filas de la tabla detallada (ventas + cobros)
let vendidosSinCosto = new Set();
let grafico = null;

protegerPagina(() => {
  aplicarPeriodo("hoy");
}, true);

// ------------------------------------------------------------
// Periodos
// ------------------------------------------------------------
function calcularPeriodo(periodo) {
  const hoy = claveDiaLima();
  if (periodo === "semana") {
    // Lunes a domingo de la semana actual
    const dia = diaSemana(hoy);                // 0 = domingo
    const desdeLunes = dia === 0 ? 6 : dia - 1;
    const lunes = sumarDias(hoy, -desdeLunes);
    return { desde: lunes, hasta: sumarDias(lunes, 6) };
  }
  if (periodo === "mes") {
    const [a, m] = hoy.split("-").map(Number);
    const primero = `${a}-${String(m).padStart(2, "0")}-01`;
    const primeroSiguiente = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
    return { desde: primero, hasta: sumarDias(primeroSiguiente, -1) };
  }
  return { desde: hoy, hasta: hoy };
}

function aplicarPeriodo(periodo) {
  marcarChip(periodo);
  const r = calcularPeriodo(periodo);
  inDesde.value = r.desde;
  inHasta.value = r.hasta;
  cargar(r);
}

function marcarChip(periodo) {
  filtrosRapidos.querySelectorAll(".chip").forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.periodo === periodo))
  );
}

filtrosRapidos.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-periodo]");
  if (btn) aplicarPeriodo(btn.dataset.periodo);
});

formRango.addEventListener("submit", (e) => {
  e.preventDefault();
  const desde = inDesde.value;
  const hasta = inHasta.value;
  if (!desde || !hasta) return aviso("Elige las dos fechas del rango.", "error");
  if (desde > hasta) return aviso("La fecha \"Desde\" no puede ser mayor que \"Hasta\".", "error");
  marcarChip(null);
  cargar({ desde, hasta });
});

ordenTop.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-orden]");
  if (!btn) return;
  ordenProductos = btn.dataset.orden;
  ordenTop.querySelectorAll(".chip").forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.orden === ordenProductos))
  );
  dibujarTop();
});

// ------------------------------------------------------------
// Carga de datos
// ------------------------------------------------------------
/** Consulta una colección por rango de "fecha" (un solo campo: sin índice compuesto). */
function consultaPorFecha(coleccion, inicio, fin) {
  return getDocs(query(
    collection(db, coleccion),
    where("fecha", ">=", inicio),
    where("fecha", "<", fin),
    orderBy("fecha", "asc")
  ));
}

async function cargar(r) {
  rango = r;
  textoRango.textContent = r.desde === r.hasta
    ? `Día ${soloFecha(inicioDiaLima(r.desde))}`
    : `Del ${soloFecha(inicioDiaLima(r.desde))} al ${soloFecha(inicioDiaLima(r.hasta))}`;
  tablaDetalle.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';
  btnExcel.disabled = true;

  // Inicio del día "desde" y del día siguiente a "hasta", en hora de Lima
  const inicio = Timestamp.fromDate(inicioDiaLima(r.desde));
  const fin = Timestamp.fromDate(inicioDiaLima(sumarDias(r.hasta, 1)));

  try {
    const [snapVentas, snapCobros, snapPendientes, snapPagos, snapMovs, snapProductos] = await Promise.all([
      consultaPorFecha("ventas", inicio, fin),
      consultaPorFecha("cobros", inicio, fin),
      getDocs(query(collection(db, "creditos"), where("estado", "==", "pendiente"))),
      consultaPorFecha("pagosTrabajadores", inicio, fin),
      consultaPorFecha("movimientosInsumos", inicio, fin),
      getDocs(collection(db, "productos"))
    ]);
    // Las ventas al crédito NO cuentan en su fecha: se excluyen aquí.
    ventas = snapVentas.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((v) => v.metodoPago !== "credito");
    cobros = snapCobros.docs.map((d) => ({ id: d.id, ...d.data() }));
    pendiente = {
      total: redondear(snapPendientes.docs.reduce((s, d) => s + (Number(d.data().saldoPendiente) || 0), 0)),
      cantidad: snapPendientes.size
    };
    pagosTrab = snapPagos.docs.map((d) => ({ id: d.id, ...d.data() }));
    compras = snapMovs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.tipo === "compra");
    productosCatalogo = snapProductos.docs.map((d) => d.data());

    await completarCostoDeCobros();
    procesar();
  } catch (error) {
    console.error(error);
    aviso(mensajeError(error), "error");
    tablaDetalle.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(error))}</td></tr>`;
  }
}

/**
 * Calcula el costo proporcional de cada cobro.
 * Los cobros nuevos traen costoCredito y totalCredito; para los antiguos
 * se lee el crédito (una sola vez por crédito).
 */
async function completarCostoDeCobros() {
  const faltan = [...new Set(cobros.filter((c) => typeof c.costoCredito !== "number").map((c) => c.creditoId))];
  const creditos = new Map();
  await Promise.all(faltan.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "creditos", id));
      if (snap.exists()) creditos.set(id, snap.data());
    } catch (e) { console.warn("No se pudo leer el crédito", id, e); }
  }));

  for (const c of cobros) {
    let costoCredito = c.costoCredito;
    let totalCredito = c.totalCredito;
    let sinCosto = [];
    if (typeof costoCredito !== "number") {
      const cr = creditos.get(c.creditoId);
      const costo = costoDeItems(cr?.items);
      costoCredito = costo.total;
      totalCredito = Number(cr?.total) || 0;
      sinCosto = cr ? costo.sinCosto : ["(crédito no encontrado)"];
    } else if (c.costoCompleto === false) {
      sinCosto = ["(productos del crédito sin costo)"];
    }
    const proporcion = totalCredito > 0 ? (Number(c.monto) || 0) / totalCredito : 0;
    c.costoCobro = redondear(costoCredito * proporcion);
    c.sinCosto = sinCosto;
  }
}

// ------------------------------------------------------------
// Cálculos y dibujo
// ------------------------------------------------------------
function procesar() {
  const validas = ventas.filter((v) => !v.anulada);
  totales = calcularTotales(ventas, cobros);
  const anuladas = ventas.length - validas.length;
  vendidosSinCosto = new Set();

  // --- Costo de producción de lo cobrado ---
  let costoTotal = 0;
  for (const v of validas) {
    const c = costoDeItems(v.items);
    v.costoVenta = c.total;
    costoTotal += c.total;
    c.sinCosto.forEach((n) => vendidosSinCosto.add(n));
  }
  for (const c of cobros) {
    costoTotal += c.costoCobro;
    c.sinCosto.forEach((n) => vendidosSinCosto.add(n));
  }
  costoTotal = redondear(costoTotal);
  const totalPagos = redondear(pagosTrab.reduce((s, p) => s + (Number(p.monto) || 0), 0));
  const totalCompras = redondear(compras.reduce((s, m) => s + (Number(m.costoTotal) || 0), 0));
  const bruta = redondear(totales.total - costoTotal);
  const neta = redondear(bruta - totalPagos);
  ganancia = {
    ventas: totales.total,
    costo: costoTotal,
    bruta,
    margen: totales.total > 0 ? (bruta / totales.total) * 100 : 0,
    pagos: totalPagos,
    neta,
    margenNeto: totales.total > 0 ? (neta / totales.total) * 100 : 0,
    compras: totalCompras
  };
  dibujarGanancia();
  dibujarBanner();

  // --- Indicadores principales (dinero cobrado) ---
  document.getElementById("kpiTotal").textContent = soles(totales.total);
  document.getElementById("kpiNum").textContent = totales.numVentas;
  document.getElementById("kpiPromedio").textContent =
    soles(totales.numVentas ? totales.total / totales.numVentas : 0);
  document.getElementById("kpiAnuladas").textContent = anuladas;
  document.getElementById("resumenMetodos").innerHTML = METODOS.map((m) => `
    <div class="indicador">
      <div class="rotulo">${NOMBRES_METODO[m]}</div>
      <div class="valor">${soles(totales.porMetodo[m])}</div>
    </div>`).join("");

  // Créditos
  document.getElementById("kpiCobros").textContent = soles(totales.cobros.total);
  document.getElementById("kpiCobrosDetalle").textContent =
    `${totales.cobros.cantidad} pago(s) · ya incluidos en el total vendido`;
  document.getElementById("kpiPendiente").textContent = soles(pendiente.total);
  document.getElementById("kpiPendienteDetalle").textContent =
    `${pendiente.cantidad} crédito(s) · informativo, no suma`;

  // --- Productos más vendidos: ventas normales + créditos completados ---
  const mapa = new Map();
  const sumarItems = (items) => {
    for (const it of items || []) {
      const clave = it.productoId || it.nombre;
      const acc = mapa.get(clave) || { nombre: it.nombre, cantidad: 0, importe: 0, costo: 0, sinCosto: false };
      acc.cantidad += Number(it.cantidad) || 0;
      acc.importe += Number(it.subtotal) || 0;
      if (itemTieneCosto(it)) acc.costo += it.costoSubtotal;
      else acc.sinCosto = true;
      mapa.set(clave, acc);
    }
  };
  for (const v of validas) sumarItems(v.items);
  for (const c of cobros) if (c.completaCredito) sumarItems(c.items);
  topProductos = [...mapa.values()].map((p) => ({
    ...p,
    importe: redondear(p.importe),
    costo: redondear(p.costo),
    ganancia: redondear(p.importe - p.costo)
  }));
  dibujarTop();

  // --- Ventas, costo y ganancia por día (todos los días del rango) ---
  const dias = new Map();
  const acumularDia = (fecha, monto, costo, cuentaVenta) => {
    const clave = claveDiaLima(fecha);
    const acc = dias.get(clave) || { total: 0, costo: 0, num: 0 };
    acc.total += Number(monto) || 0;
    acc.costo += Number(costo) || 0;
    if (cuentaVenta) acc.num++;
    dias.set(clave, acc);
  };
  for (const v of validas) acumularDia(v.fecha, v.total, v.costoVenta, true);
  for (const c of cobros) acumularDia(c.fecha, c.monto, c.costoCobro, !!c.completaCredito);
  porDia = [];
  for (let c = rango.desde; c <= rango.hasta; c = sumarDias(c, 1)) {
    const acc = dias.get(c) || { total: 0, costo: 0, num: 0 };
    porDia.push({
      clave: c,
      total: redondear(acc.total),
      costo: redondear(acc.costo),
      ganancia: redondear(acc.total - acc.costo),
      num: acc.num
    });
  }
  dibujarGrafico();

  // --- Tabla detallada: ventas normales + cobros de créditos ---
  movimientos = [
    ...ventas.map((v) => ({
      fecha: v.fecha,
      tipo: "Venta",
      codigo: v.id.slice(-6).toUpperCase(),
      detalle: (v.items || []).map((it) => `${it.cantidad}× ${it.nombre}`).join(", "),
      metodo: v.metodoPago,
      monto: Number(v.total) || 0,
      costo: v.anulada ? 0 : (v.costoVenta ?? costoDeItems(v.items).total),
      recibido: Number(v.montoRecibido) || 0,
      vuelto: Number(v.vuelto) || 0,
      usuario: v.usuarioNombre || "",
      estado: v.anulada ? "Anulada" : "Válida"
    })),
    ...cobros.map((c) => ({
      fecha: c.fecha,
      tipo: "Cobro de crédito",
      codigo: String(c.ventaId || c.creditoId || "").slice(-6).toUpperCase(),
      detalle: `${c.nombreCliente} (DNI ${c.dni})${c.completaCredito ? " · crédito cancelado" : " · abono"}`,
      metodo: c.metodo,
      monto: Number(c.monto) || 0,
      costo: c.costoCobro,
      recibido: Number(c.monto) || 0,
      vuelto: 0,
      usuario: c.usuarioNombre || "",
      estado: "Válida"
    }))
  ].sort((a, b) => (b.fecha?.toMillis?.() || 0) - (a.fecha?.toMillis?.() || 0));

  tablaDetalle.innerHTML = movimientos.length
    ? movimientos.map((m) => `
        <tr class="${m.estado === "Anulada" ? "anulada" : ""}">
          <td>${fechaHora(m.fecha)}</td>
          <td>${m.tipo === "Venta" ? m.codigo : `<span class="etiqueta-estado rosa">Cobro</span> ${m.codigo}`}</td>
          <td>${escaparHTML(m.detalle)}</td>
          <td>${NOMBRES_METODO[m.metodo] || escaparHTML(m.metodo)}</td>
          <td class="num">${soles(m.monto)}</td>
          <td>${escaparHTML(m.usuario || "—")}</td>
          <td>${m.estado === "Anulada" ? '<span class="etiqueta-estado rojo">Anulada</span>' : '<span class="etiqueta-estado verde">Válida</span>'}</td>
        </tr>`).join("")
    : '<tr><td colspan="7" class="vacio">No hay ventas ni cobros en este periodo.</td></tr>';

  btnExcel.disabled = movimientos.length === 0 && pagosTrab.length === 0 && compras.length === 0;
}

function dibujarGanancia() {
  const g = ganancia;
  const claseValor = (n) => (n < 0 ? "texto-perdida" : "");
  document.getElementById("gVentas").textContent = soles(g.ventas);
  document.getElementById("gCosto").textContent = soles(g.costo);
  document.getElementById("gCostoDetalle").textContent = vendidosSinCosto.size ? "⚠ incompleto: hay productos sin costo" : "";
  const elBruta = document.getElementById("gBruta");
  elBruta.textContent = soles(g.bruta);
  elBruta.className = `valor ${claseValor(g.bruta)}`;
  document.getElementById("gMargen").textContent = `Margen ${porcentaje(g.margen)}`;
  document.getElementById("gPagos").textContent = soles(g.pagos);
  document.getElementById("gPagosDetalle").textContent = `${pagosTrab.length} pago(s)`;
  document.getElementById("gNeta").textContent = soles(g.neta);
  document.getElementById("gNetaMargen").textContent = `Margen neto ${porcentaje(g.margenNeto)}`;
  document.getElementById("gCompras").textContent = soles(g.compras);
  document.getElementById("gComprasDetalle").textContent = `${compras.length} compra(s) · informativo, no se resta`;
}

function dibujarBanner() {
  const enCatalogo = productosCatalogo.filter((p) => !tieneCosto(p)).length;
  const partes = [];
  if (vendidosSinCosto.size) {
    const nombres = [...vendidosSinCosto].slice(0, 6).map(escaparHTML).join(", ");
    partes.push(`En este periodo se vendieron productos <strong>sin costo registrado</strong> (${nombres}${vendidosSinCosto.size > 6 ? "…" : ""}): el costo y la ganancia salen inexactos (más altos de lo real).`);
  }
  if (enCatalogo) {
    partes.push(`${enCatalogo} producto(s) del catálogo no tienen costo. <a href="productos.html">Regístralo en Productos</a>.`);
  }
  bannerSinCosto.classList.toggle("oculto", partes.length === 0);
  bannerSinCosto.innerHTML = `<span>⚠ ${partes.join(" ")}</span>`;
}

function dibujarTop() {
  const lista = [...topProductos].sort((a, b) =>
    ordenProductos === "ganancia"
      ? b.ganancia - a.ganancia || b.cantidad - a.cantidad
      : b.cantidad - a.cantidad || b.importe - a.importe
  );
  tablaTop.innerHTML = lista.length
    ? lista.slice(0, 15).map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escaparHTML(p.nombre)}${p.sinCosto ? ' <span class="etiqueta-estado amarillo" title="Algunas unidades se vendieron sin costo registrado">Sin costo</span>' : ""}</td>
          <td class="num">${p.cantidad}</td>
          <td class="num">${soles(p.importe)}</td>
          <td class="num"><span class="${p.ganancia < 0 ? "texto-perdida" : "texto-ganancia"}">${soles(p.ganancia)}</span></td>
        </tr>`).join("")
    : '<tr><td colspan="5" class="vacio">Sin datos.</td></tr>';
}

const NOMBRES_DIA = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function dibujarGrafico() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js no se cargó (¿sin internet?).");
    return;
  }
  const etiquetas = porDia.map((d) => {
    const [, m, dd] = d.clave.split("-");
    return `${NOMBRES_DIA[diaSemana(d.clave)]} ${dd}/${m}`;
  });

  if (grafico) grafico.destroy();
  grafico = new Chart(document.getElementById("grafico"), {
    type: "bar",
    data: {
      labels: etiquetas,
      datasets: [
        {
          type: "bar",
          label: "Ventas cobradas",
          data: porDia.map((d) => d.total),
          backgroundColor: "#FFD21F",
          borderColor: "#141414",
          borderWidth: 2,
          borderRadius: 6,
          maxBarThickness: 48,
          order: 2
        },
        {
          type: "line",
          label: "Ganancia bruta",
          data: porDia.map((d) => d.ganancia),
          borderColor: "#D6136E",
          backgroundColor: "#D6136E",
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.25,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { font: { family: "Bricolage Grotesque", weight: "bold" } } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${soles(ctx.parsed.y)}`,
            afterBody: (items) => {
              const d = porDia[items[0].dataIndex];
              return `Costo: ${soles(d.costo)} · ${d.num} venta(s)`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "S/ " + v },
          grid: { color: "#EFECE8" }
        },
        x: { grid: { display: false } }
      }
    }
  });
}

// ------------------------------------------------------------
// Exportar a Excel (misma lógica: solo dinero cobrado)
// ------------------------------------------------------------
btnExcel.addEventListener("click", () => {
  if (typeof XLSX === "undefined") {
    aviso("No se pudo cargar la librería de Excel. Revisa tu internet.", "error");
    return;
  }
  const libro = XLSX.utils.book_new();
  const g = ganancia;

  // Hoja 1: Resumen
  const resumen = [
    ["ALANA - Reporte de ventas y ganancia (dinero cobrado)"],
    ["Desde", rango.desde, "Hasta", rango.hasta],
    [],
    ["GANANCIA"],
    ["Ventas cobradas (S/)", g.ventas],
    ["Costo de producción (S/)", g.costo],
    ["Ganancia bruta (S/)", g.bruta],
    ["Margen bruto (%)", redondear(g.margen)],
    ["Pagos a trabajadores (S/)", g.pagos],
    ["Ganancia neta (S/)", g.neta],
    ["Margen neto (%)", redondear(g.margenNeto)],
    ["Compras de insumos (S/) - informativo, NO se resta", g.compras],
    vendidosSinCosto.size ? ["AVISO: productos vendidos sin costo (ganancia inexacta)", [...vendidosSinCosto].join(", ")] : [],
    [],
    ["VENTAS"],
    ["Total vendido / cobrado (S/)", totales.total],
    ["  De ventas directas (S/)", totales.totalVentasDirectas],
    ["  Cobros de créditos en el periodo (S/)", totales.cobros.total],
    ["N.º de ventas", totales.numVentas],
    ["Ticket promedio (S/)", totales.numVentas ? redondear(totales.total / totales.numVentas) : 0],
    ["Ventas anuladas", ventas.filter((v) => v.anulada).length],
    [],
    ["Método de pago", "Total (S/)", "De ellos, cobros de créditos (S/)"],
    ...METODOS.map((m) => [NOMBRES_METODO[m], totales.porMetodo[m], totales.cobros.porMetodo[m]]),
    [],
    ["Informativo (no suma): total pendiente por cobrar hoy (S/)", pendiente.total],
    ["Informativo: créditos pendientes", pendiente.cantidad],
    [],
    ["Día", "N.º ventas", "Ventas cobradas (S/)", "Costo (S/)", "Ganancia bruta (S/)"],
    ...porDia.map((d) => [d.clave, d.num, d.total, d.costo, d.ganancia])
  ];
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(resumen), "Resumen");

  // Hoja 2: Ventas (ventas normales)
  const filasVentas = movimientos.filter((m) => m.tipo === "Venta").map((m) => ({
    "Fecha y hora": fechaHora(m.fecha),
    "Ticket": m.codigo,
    "Detalle": m.detalle,
    "Método": NOMBRES_METODO[m.metodo] || m.metodo,
    "Total (S/)": m.monto,
    "Costo (S/)": m.costo,
    "Ganancia (S/)": m.estado === "Anulada" ? 0 : redondear(m.monto - m.costo),
    "Recibido (S/)": m.recibido,
    "Vuelto (S/)": m.vuelto,
    "Atendió": m.usuario,
    "Estado": m.estado
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasVentas.length ? filasVentas : [{ "Sin datos": "" }]), "Ventas");

  // Hoja 3: Cobros de créditos
  const filasCobros = cobros.map((c) => ({
    "Fecha y hora": fechaHora(c.fecha),
    "Crédito": String(c.ventaId || c.creditoId || "").slice(-6).toUpperCase(),
    "DNI": c.dni,
    "Cliente": c.nombreCliente,
    "Método": NOMBRES_METODO[c.metodo] || c.metodo,
    "Monto cobrado (S/)": Number(c.monto) || 0,
    "Costo proporcional (S/)": c.costoCobro,
    "Ganancia (S/)": redondear((Number(c.monto) || 0) - c.costoCobro),
    "Tipo": c.completaCredito ? "Cancela el crédito" : "Abono",
    "Registró": c.usuarioNombre || ""
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasCobros.length ? filasCobros : [{ "Sin datos": "" }]), "Cobros de créditos");

  // Hoja 4: Pagos a trabajadores
  const filasPagos = pagosTrab.map((p) => ({
    "Fecha y hora": fechaHora(p.fecha),
    "Trabajador": p.nombreTrabajador,
    "Concepto": CONCEPTOS[p.concepto] || p.concepto,
    "Periodo": p.periodo,
    "Método": METODOS_PAGO[p.metodo] || p.metodo,
    "Monto (S/)": Number(p.monto) || 0,
    "De caja": p.pagadoConCaja ? "Sí" : "No",
    "Observación": p.observacion || "",
    "Registró": p.usuarioNombre || ""
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasPagos.length ? filasPagos : [{ "Sin datos": "" }]), "Pagos a trabajadores");

  // Hoja 5: Compras de insumos (informativo)
  const filasCompras = compras.map((m) => ({
    "Fecha y hora": fechaHora(m.fecha),
    "Insumo": m.nombreInsumo,
    "Cantidad": cantidadConUnidad(m.cantidad),
    "Costo total (S/)": Number(m.costoTotal) || 0,
    "De caja": m.pagadoConCaja ? "Sí" : "No",
    "Nota": m.motivo || "",
    "Registró": m.usuarioNombre || ""
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasCompras.length ? filasCompras : [{ "Sin datos": "" }]), "Compras de insumos");

  // Hoja 6: Productos vendidos
  const filasProductos = [...topProductos].sort((a, b) => b.cantidad - a.cantidad).map((p) => ({
    "Producto": p.nombre,
    "Cantidad": p.cantidad,
    "Importe (S/)": p.importe,
    "Costo (S/)": p.costo,
    "Ganancia (S/)": p.ganancia,
    "Aviso": p.sinCosto ? "Algunas unidades sin costo registrado" : ""
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasProductos.length ? filasProductos : [{ "Sin datos": "" }]), "Productos");

  XLSX.writeFile(libro, `reporte-alana_${rango.desde}_a_${rango.hasta}.xlsx`);
});

document.getElementById("btnImprimir").addEventListener("click", () => window.print());
