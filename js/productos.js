// ============================================================
// productos.js — Administración de productos (solo admin)
// ------------------------------------------------------------
// Las imágenes se guardan como texto base64 dentro del mismo
// documento (no usamos Firebase Storage). Por eso se reducen a
// 250x250 px en JPEG calidad 0.6 (objetivo: menos de 25 KB), para
// gastar poco del plan gratuito cada vez que se descargan los productos.
// Límite duro: ~200 KB (Firestore permite máximo 1 MB por documento).
// ============================================================

import {
  db, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, escaparHTML, aviso, confirmar, mensajeError,
  tieneCosto, gananciaUnidad, porcentaje
} from "./comun.js";

const TAM_MAX = 250;              // lado máximo en píxeles
const CALIDAD_JPEG = 0.6;         // calidad JPEG inicial
const CALIDAD_MINIMA = 0.4;       // si pasa del objetivo, se baja hasta aquí
const OBJETIVO_BASE64 = 25 * 1024; // objetivo: menos de ~25 KB
const LIMITE_BASE64 = 200 * 1024; // límite duro: ~200 KB de texto base64
const TEXTO_AYUDA_IMAGEN = "Se reduce automáticamente a 250×250 px.";

// Elementos
const form = document.getElementById("formProducto");
const tituloForm = document.getElementById("tituloForm");
const inNombre = document.getElementById("nombre");
const inPrecio = document.getElementById("precio");
const inCosto = document.getElementById("costo");
const infoGanancia = document.getElementById("infoGanancia");
const bannerSinCosto = document.getElementById("bannerSinCosto");
const inCategoria = document.getElementById("categoria");
const inImagen = document.getElementById("imagen");
const inActivo = document.getElementById("activo");
const vistaPrevia = document.getElementById("vistaPrevia");
const infoImagen = document.getElementById("infoImagen");
const btnQuitarImagen = document.getElementById("btnQuitarImagen");
const btnGuardar = document.getElementById("btnGuardar");
const btnCancelar = document.getElementById("btnCancelar");
const errorForm = document.getElementById("errorForm");
const inBuscar = document.getElementById("buscar");
const tabla = document.getElementById("tablaProductos");
const contador = document.getElementById("contador");
const listaCategorias = document.getElementById("listaCategorias");

// Estado
let productos = [];        // lista completa en tiempo real
let editandoId = null;     // id del producto que se edita (null = nuevo)
let imagenBase64 = "";     // imagen lista para guardar

protegerPagina(() => {
  escucharProductos();
}, true);

// ------------------------------------------------------------
// Lectura en tiempo real
// ------------------------------------------------------------
function escucharProductos() {
  onSnapshot(
    collection(db, "productos"),
    (snap) => {
      productos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      // Orden alfabético por categoría y nombre (en el navegador, sin índices)
      productos.sort((a, b) =>
        (a.categoria || "").localeCompare(b.categoria || "", "es") ||
        (a.nombre || "").localeCompare(b.nombre || "", "es")
      );
      actualizarCategorias();
      dibujarTabla();
    },
    (error) => {
      console.error(error);
      aviso(mensajeError(error), "error");
    }
  );
}

function actualizarCategorias() {
  const categorias = [...new Set(productos.map((p) => p.categoria).filter(Boolean))];
  listaCategorias.innerHTML = categorias.map((c) => `<option value="${escaparHTML(c)}">`).join("");
}

function dibujarTabla() {
  const texto = inBuscar.value.trim().toLowerCase();
  const filtrados = productos.filter((p) =>
    !texto ||
    (p.nombre || "").toLowerCase().includes(texto) ||
    (p.categoria || "").toLowerCase().includes(texto)
  );

  contador.textContent = `(${filtrados.length} de ${productos.length})`;

  // Banner: productos sin costo (la ganancia en Reportes saldría inexacta)
  const sinCosto = productos.filter((p) => !tieneCosto(p)).length;
  bannerSinCosto.classList.toggle("oculto", sinCosto === 0);
  bannerSinCosto.innerHTML = `<span>⚠ ${sinCosto} producto(s) no tienen costo de producción. La ganancia en Reportes saldrá inexacta hasta que lo registres (botón Editar).</span>`;

  if (filtrados.length === 0) {
    tabla.innerHTML = `<tr><td colspan="8" class="vacio">${productos.length ? "Ningún producto coincide con la búsqueda." : "Aún no hay productos. Agrega el primero con el formulario."}</td></tr>`;
    return;
  }

  tabla.innerHTML = filtrados.map((p) => {
    let costo = '<span class="etiqueta-estado amarillo">Falta costo</span>';
    let ganancia = "—";
    if (tieneCosto(p)) {
      const g = gananciaUnidad(p.precio, p.costo);
      costo = soles(p.costo);
      ganancia = `<span class="${g.monto <= 0 ? "texto-perdida" : "texto-ganancia"}">${soles(g.monto)}<br><small>${porcentaje(g.porcentaje)}</small></span>`;
    }
    return `
    <tr>
      <td>${p.imagen
        ? `<img class="miniatura" src="${p.imagen}" alt="">`
        : `<div class="miniatura"></div>`}</td>
      <td><strong>${escaparHTML(p.nombre)}</strong></td>
      <td>${escaparHTML(p.categoria)}</td>
      <td class="num">${soles(p.precio)}</td>
      <td class="num">${costo}</td>
      <td class="num">${ganancia}</td>
      <td>${p.activo
        ? '<span class="etiqueta-estado verde">Activo</span>'
        : '<span class="etiqueta-estado">Inactivo</span>'}</td>
      <td>
        <div class="acciones-fila">
          <button class="btn btn-claro btn-chico" data-accion="editar" data-id="${p.id}">Editar</button>
          <button class="btn btn-claro btn-chico" data-accion="estado" data-id="${p.id}">${p.activo ? "Desactivar" : "Activar"}</button>
          <button class="btn btn-peligro btn-chico" data-accion="eliminar" data-id="${p.id}">Eliminar</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

// Aviso en vivo de ganancia mientras se escribe precio/costo
function actualizarInfoGanancia() {
  const precio = parseFloat(inPrecio.value);
  const costo = parseFloat(inCosto.value);
  if (!Number.isFinite(precio) || !Number.isFinite(costo) || inCosto.value === "") {
    infoGanancia.classList.add("oculto");
    return;
  }
  const g = gananciaUnidad(precio, costo);
  infoGanancia.classList.remove("oculto");
  if (costo >= precio) {
    infoGanancia.className = "info-ganancia perdida";
    infoGanancia.textContent = "⚠ Este producto no deja ganancia";
  } else {
    infoGanancia.className = "info-ganancia";
    infoGanancia.textContent = `Ganancia por unidad: ${soles(g.monto)} (${porcentaje(g.porcentaje)})`;
  }
}
inPrecio.addEventListener("input", actualizarInfoGanancia);
inCosto.addEventListener("input", actualizarInfoGanancia);

inBuscar.addEventListener("input", dibujarTabla);

// Acciones de la tabla (delegación de eventos)
tabla.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const producto = productos.find((p) => p.id === btn.dataset.id);
  if (!producto) return;

  if (btn.dataset.accion === "editar") {
    cargarEnFormulario(producto);
  } else if (btn.dataset.accion === "estado") {
    try {
      await updateDoc(doc(db, "productos", producto.id), { activo: !producto.activo });
      aviso(producto.activo ? "Producto desactivado." : "Producto activado.");
    } catch (error) {
      aviso(mensajeError(error), "error");
    }
  } else if (btn.dataset.accion === "eliminar") {
    const ok = await confirmar(
      `¿Eliminar "${producto.nombre}"? Esta acción no se puede deshacer. Las ventas anteriores no se ven afectadas. Si solo quieres ocultarlo, usa "Desactivar".`,
      "Eliminar", true
    );
    if (!ok) return;
    try {
      await deleteDoc(doc(db, "productos", producto.id));
      if (editandoId === producto.id) limpiarFormulario();
      aviso("Producto eliminado.");
    } catch (error) {
      aviso(mensajeError(error), "error");
    }
  }
});

// ------------------------------------------------------------
// Formulario
// ------------------------------------------------------------
function cargarEnFormulario(p) {
  editandoId = p.id;
  tituloForm.textContent = "Editar producto";
  inNombre.value = p.nombre || "";
  inPrecio.value = p.precio ?? "";
  inCosto.value = tieneCosto(p) ? p.costo : "";
  inCategoria.value = p.categoria || "";
  inActivo.checked = !!p.activo;
  inImagen.value = "";
  imagenBase64 = p.imagen || "";
  mostrarVistaPrevia();
  actualizarInfoGanancia();
  btnCancelar.classList.remove("oculto");
  btnGuardar.textContent = "Guardar cambios";
  ocultarError();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  inNombre.focus();
}

function limpiarFormulario() {
  editandoId = null;
  form.reset();
  inActivo.checked = true;
  imagenBase64 = "";
  mostrarVistaPrevia();
  infoGanancia.classList.add("oculto");
  infoImagen.textContent = TEXTO_AYUDA_IMAGEN;
  tituloForm.textContent = "Nuevo producto";
  btnGuardar.textContent = "Guardar producto";
  btnCancelar.classList.add("oculto");
  ocultarError();
}

btnCancelar.addEventListener("click", limpiarFormulario);

function mostrarVistaPrevia() {
  if (imagenBase64) {
    vistaPrevia.innerHTML = `<img src="${imagenBase64}" alt="Vista previa del producto">`;
    btnQuitarImagen.classList.remove("oculto");
  } else {
    vistaPrevia.textContent = "Sin imagen";
    btnQuitarImagen.classList.add("oculto");
  }
}

btnQuitarImagen.addEventListener("click", () => {
  imagenBase64 = "";
  inImagen.value = "";
  infoImagen.textContent = TEXTO_AYUDA_IMAGEN;
  mostrarVistaPrevia();
});

// Al elegir una imagen: redimensionar y mostrar vista previa
inImagen.addEventListener("change", async () => {
  const archivo = inImagen.files[0];
  if (!archivo) return;
  if (!archivo.type.startsWith("image/")) {
    mostrarError("El archivo elegido no es una imagen.");
    inImagen.value = "";
    return;
  }
  infoImagen.textContent = "Procesando imagen…";
  try {
    imagenBase64 = await redimensionarImagen(archivo);
    const kb = Math.round(imagenBase64.length / 1024);
    infoImagen.textContent = `Imagen lista (${kb} KB).`;
    mostrarVistaPrevia();
    ocultarError();
  } catch (error) {
    console.error(error);
    imagenBase64 = "";
    inImagen.value = "";
    mostrarVistaPrevia();
    infoImagen.textContent = TEXTO_AYUDA_IMAGEN;
    mostrarError(error.message || "No se pudo procesar la imagen.");
  }
});

/** Comprime un archivo elegido desde la PC. */
async function redimensionarImagen(archivo) {
  const url = URL.createObjectURL(archivo);
  try {
    return await comprimirImagen(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Reduce una imagen (URL de archivo o base64) a máximo 250x250 manteniendo
 * la proporción y la convierte a JPEG base64 con calidad 0.6. Si pasa de
 * ~25 KB, baja la calidad hasta 0.4. Rechaza si supera ~200 KB.
 */
function comprimirImagen(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, TAM_MAX / img.width, TAM_MAX / img.height);
      const ancho = Math.round(img.width * escala);
      const alto = Math.round(img.height * escala);

      const canvas = document.createElement("canvas");
      canvas.width = ancho;
      canvas.height = alto;
      const ctx = canvas.getContext("2d");
      // Fondo blanco (las PNG transparentes quedarían negras en JPEG)
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, ancho, alto);
      ctx.drawImage(img, 0, 0, ancho, alto);

      let calidad = CALIDAD_JPEG;
      let resultado = canvas.toDataURL("image/jpeg", calidad);
      while (resultado.length > OBJETIVO_BASE64 && calidad > CALIDAD_MINIMA + 0.001) {
        calidad -= 0.1;
        resultado = canvas.toDataURL("image/jpeg", calidad);
      }
      if (resultado.length > LIMITE_BASE64) {
        reject(new Error("La imagen sigue siendo demasiado pesada. Prueba con otra foto."));
        return;
      }
      resolve(resultado);
    };
    img.onerror = () => {
      reject(new Error("No se pudo leer la imagen. Prueba con un archivo JPG o PNG."));
    };
    img.src = url;
  });
}

// ------------------------------------------------------------
// Optimizar imágenes existentes (solo admin; la página ya es solo admin)
// ------------------------------------------------------------
// Vuelve a comprimir las fotos guardadas con la configuración actual
// (250x250, JPEG 0.6). Solo actualiza un producto si la nueva imagen
// pesa menos que la actual, así no se gastan escrituras de más.
const btnOptimizar = document.getElementById("btnOptimizar");

btnOptimizar.addEventListener("click", async () => {
  const conImagen = productos.filter((p) => p.imagen);
  if (conImagen.length === 0) {
    aviso("No hay productos con imagen.", "info");
    return;
  }
  const ok = await confirmar(
    `Se volverán a comprimir las imágenes de ${conImagen.length} producto(s) a 250×250 px. ` +
    "Solo se guardan las que queden más livianas. ¿Continuar?",
    "Optimizar"
  );
  if (!ok) return;

  btnOptimizar.disabled = true;
  let optimizadas = 0;
  let errores = 0;
  let antesTotal = 0;
  let despuesTotal = 0;
  try {
    for (let i = 0; i < conImagen.length; i++) {
      const p = conImagen[i];
      btnOptimizar.textContent = `Optimizando ${i + 1} de ${conImagen.length}…`;
      try {
        const nueva = await comprimirImagen(p.imagen);
        antesTotal += p.imagen.length;
        // Guardar solo si ahorra al menos un 5 %
        if (nueva.length < p.imagen.length * 0.95) {
          await updateDoc(doc(db, "productos", p.id), { imagen: nueva });
          optimizadas++;
          despuesTotal += nueva.length;
        } else {
          despuesTotal += p.imagen.length;
        }
      } catch (error) {
        console.error(`No se pudo optimizar "${p.nombre}":`, error);
        errores++;
      }
    }
    const ahorroKb = Math.round((antesTotal - despuesTotal) / 1024);
    aviso(
      `Listo: ${optimizadas} imagen(es) optimizada(s), ahorro de ${ahorroKb} KB.` +
      (errores ? ` ${errores} no se pudieron procesar (ver consola).` : ""),
      errores ? "info" : "ok"
    );
  } finally {
    btnOptimizar.disabled = false;
    btnOptimizar.textContent = "Optimizar imágenes existentes";
  }
});

// Guardar (crear o actualizar)
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  ocultarError();

  const nombre = inNombre.value.trim();
  const precio = redondear(parseFloat(inPrecio.value));
  const costo = redondear(parseFloat(inCosto.value));
  const categoria = inCategoria.value.trim();

  if (!nombre) return mostrarError("Escribe el nombre del producto.", inNombre);
  if (!Number.isFinite(precio) || precio <= 0) return mostrarError("Escribe un precio válido mayor que 0.", inPrecio);
  if (inCosto.value.trim() === "" || !Number.isFinite(costo) || costo < 0) {
    return mostrarError("Escribe el costo de producción (0 o más).", inCosto);
  }
  if (!categoria) return mostrarError("Escribe o elige una categoría.", inCategoria);
  if (costo >= precio) {
    const seguir = await confirmar(
      `Este producto no deja ganancia: el costo (${soles(costo)}) es igual o mayor que el precio (${soles(precio)}). ¿Guardar de todos modos?`,
      "Guardar igual"
    );
    if (!seguir) { inCosto.focus(); return; }
  }

  const duplicado = productos.find((p) =>
    p.id !== editandoId && (p.nombre || "").trim().toLowerCase() === nombre.toLowerCase()
  );
  if (duplicado) return mostrarError(`Ya existe un producto llamado "${duplicado.nombre}".`, inNombre);

  const datos = {
    nombre,
    precio,
    costo,
    categoria,
    imagen: imagenBase64,
    activo: inActivo.checked
  };

  btnGuardar.disabled = true;
  try {
    if (editandoId) {
      await updateDoc(doc(db, "productos", editandoId), datos);
      aviso("Cambios guardados.");
    } else {
      await addDoc(collection(db, "productos"), { ...datos, creadoEn: serverTimestamp() });
      aviso("Producto agregado.");
    }
    limpiarFormulario();
    inNombre.focus();
  } catch (error) {
    console.error(error);
    mostrarError(mensajeError(error));
  } finally {
    btnGuardar.disabled = false;
  }
});

function mostrarError(texto, campo) {
  errorForm.textContent = texto;
  errorForm.classList.remove("oculto");
  if (campo) campo.focus();
}
function ocultarError() {
  errorForm.classList.add("oculto");
}
