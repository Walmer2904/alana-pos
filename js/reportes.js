// ============================================================
// reportes.js — Reportes de ventas (solo admin)
// ------------------------------------------------------------
// La consulta filtra SOLO por el campo "fecha" (rango >= y <), así
// Firestore no necesita índices compuestos. Todo lo demás (totales,
// métodos, productos, días) se calcula en el navegador.
// Usa Chart.js (gráfico) y SheetJS (Excel), cargados por CDN en
// reportes.html como variables globales: Chart y XLSX.
// ============================================================

import { db, collection, getDocs, query, where, orderBy, Timestamp } from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, soloFecha, escaparHTML, aviso,
  mensajeError, claveDiaLima, inicioDiaLima, sumarDias, diaSemana,
  calcularTotales, METODOS, NOMBRES_METODO
} from "./comun.js";

// Elementos
const textoRango = document.getElementById("textoRango");
const filtrosRapidos = document.getElementById("filtrosRapidos");
const formRango = document.getElementById("formRango");
const inDesde = document.getElementById("desde");
const inHasta = document.getElementById("hasta");
const btnExcel = document.getElementById("btnExcel");
const tablaTop = document.getElementById("tablaTop");
const tablaDetalle = document.getElementById("tablaDetalle");

// Estado
let rango = null;        // { desde: "AAAA-MM-DD", hasta: "AAAA-MM-DD" } (ambos incluidos)
let ventas = [];         // ventas del rango (incluye anuladas)
let topProductos = [];
let porDia = [];         // [{ clave, total, num }]
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

// ------------------------------------------------------------
// Carga de datos
// ------------------------------------------------------------
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
    const q = query(
      collection(db, "ventas"),
      where("fecha", ">=", inicio),
      where("fecha", "<", fin),
      orderBy("fecha", "asc")
    );
    const snap = await getDocs(q);
    ventas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    procesar();
  } catch (error) {
    console.error(error);
    aviso(mensajeError(error), "error");
    tablaDetalle.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(error))}</td></tr>`;
  }
}

// ------------------------------------------------------------
// Cálculos y dibujo
// ------------------------------------------------------------
function procesar() {
  const validas = ventas.filter((v) => !v.anulada);
  const totales = calcularTotales(ventas);
  const anuladas = ventas.length - validas.length;

  // Indicadores
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

  // Productos más vendidos (agrupa por id; si no hay id, por nombre)
  const mapa = new Map();
  for (const v of validas) {
    for (const it of v.items || []) {
      const clave = it.productoId || it.nombre;
      const acc = mapa.get(clave) || { nombre: it.nombre, cantidad: 0, importe: 0 };
      acc.cantidad += Number(it.cantidad) || 0;
      acc.importe += Number(it.subtotal) || 0;
      mapa.set(clave, acc);
    }
  }
  topProductos = [...mapa.values()]
    .map((p) => ({ ...p, importe: redondear(p.importe) }))
    .sort((a, b) => b.cantidad - a.cantidad || b.importe - a.importe);

  tablaTop.innerHTML = topProductos.length
    ? topProductos.slice(0, 15).map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escaparHTML(p.nombre)}</td>
          <td class="num">${p.cantidad}</td>
          <td class="num">${soles(p.importe)}</td>
        </tr>`).join("")
    : '<tr><td colspan="4" class="vacio">Sin datos.</td></tr>';

  // Ventas por día (todos los días del rango, aunque tengan 0)
  const totalesDia = new Map();
  for (const v of validas) {
    const clave = claveDiaLima(v.fecha);
    const acc = totalesDia.get(clave) || { total: 0, num: 0 };
    acc.total += Number(v.total) || 0;
    acc.num++;
    totalesDia.set(clave, acc);
  }
  porDia = [];
  for (let c = rango.desde; c <= rango.hasta; c = sumarDias(c, 1)) {
    const acc = totalesDia.get(c) || { total: 0, num: 0 };
    porDia.push({ clave: c, total: redondear(acc.total), num: acc.num });
  }
  dibujarGrafico();

  // Tabla detallada (más reciente primero)
  const detalle = [...ventas].reverse();
  tablaDetalle.innerHTML = detalle.length
    ? detalle.map((v) => `
        <tr class="${v.anulada ? "anulada" : ""}">
          <td>${fechaHora(v.fecha)}</td>
          <td>${v.id.slice(-6).toUpperCase()}</td>
          <td>${(v.items || []).map((it) => `${it.cantidad}× ${escaparHTML(it.nombre)}`).join(", ")}</td>
          <td>${NOMBRES_METODO[v.metodoPago] || escaparHTML(v.metodoPago)}</td>
          <td class="num">${soles(v.total)}</td>
          <td>${escaparHTML(v.usuarioNombre || "—")}</td>
          <td>${v.anulada ? '<span class="etiqueta-estado rojo">Anulada</span>' : '<span class="etiqueta-estado verde">Válida</span>'}</td>
        </tr>`).join("")
    : '<tr><td colspan="7" class="vacio">No hay ventas en este periodo.</td></tr>';

  btnExcel.disabled = ventas.length === 0;
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
  const datos = porDia.map((d) => d.total);

  if (grafico) grafico.destroy();
  grafico = new Chart(document.getElementById("grafico"), {
    type: "bar",
    data: {
      labels: etiquetas,
      datasets: [{
        label: "Total vendido",
        data: datos,
        backgroundColor: "#FFD21F",
        borderColor: "#141414",
        borderWidth: 2,
        hoverBackgroundColor: "#F0288C",
        borderRadius: 6,
        maxBarThickness: 48
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${soles(ctx.parsed.y)} · ${porDia[ctx.dataIndex].num} ventas`
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
// Exportar a Excel
// ------------------------------------------------------------
btnExcel.addEventListener("click", () => {
  if (typeof XLSX === "undefined") {
    aviso("No se pudo cargar la librería de Excel. Revisa tu internet.", "error");
    return;
  }
  const totales = calcularTotales(ventas);
  const libro = XLSX.utils.book_new();

  // Hoja 1: Resumen
  const resumen = [
    ["ALANA - Reporte de ventas"],
    ["Desde", rango.desde, "Hasta", rango.hasta],
    [],
    ["Total vendido (S/)", totales.total],
    ["N.º de ventas", totales.numVentas],
    ["Ticket promedio (S/)", totales.numVentas ? redondear(totales.total / totales.numVentas) : 0],
    ["Ventas anuladas", ventas.filter((v) => v.anulada).length],
    [],
    ["Método de pago", "Total (S/)"],
    ...METODOS.map((m) => [NOMBRES_METODO[m], totales.porMetodo[m]]),
    [],
    ["Día", "N.º ventas", "Total (S/)"],
    ...porDia.map((d) => [d.clave, d.num, d.total])
  ];
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(resumen), "Resumen");

  // Hoja 2: Ventas (una fila por venta)
  const filasVentas = ventas.map((v) => ({
    "Fecha y hora": fechaHora(v.fecha),
    "Ticket": v.id.slice(-6).toUpperCase(),
    "Detalle": (v.items || []).map((it) => `${it.cantidad}x ${it.nombre}`).join(", "),
    "Método": NOMBRES_METODO[v.metodoPago] || v.metodoPago,
    "Total (S/)": Number(v.total) || 0,
    "Recibido (S/)": Number(v.montoRecibido) || 0,
    "Vuelto (S/)": Number(v.vuelto) || 0,
    "Atendió": v.usuarioNombre || "",
    "Estado": v.anulada ? "Anulada" : "Válida"
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasVentas), "Ventas");

  // Hoja 3: Productos vendidos
  const filasProductos = topProductos.map((p) => ({
    "Producto": p.nombre,
    "Cantidad": p.cantidad,
    "Importe (S/)": p.importe
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasProductos), "Productos");

  XLSX.writeFile(libro, `reporte-alana_${rango.desde}_a_${rango.hasta}.xlsx`);
});

document.getElementById("btnImprimir").addEventListener("click", () => window.print());
