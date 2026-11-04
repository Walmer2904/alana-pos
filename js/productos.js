// ============================================================
// productos.js — Administración de productos (solo admin)
// ------------------------------------------------------------
// Las imágenes se guardan como texto base64 dentro del mismo
// documento (no usamos Firebase Storage). Por eso se reducen a
// 400x400 px en JPEG y se valida que pesen menos de ~200 KB
// (Firestore permite máximo 1 MB por documento).
// ============================================================

import {
  db, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, escaparHTML, aviso, confirmar, mensajeError
} from "./comun.js";

const TAM_MAX = 400;              // lado máximo en píxeles
const LIMITE_BASE64 = 200 * 1024; // ~200 KB de texto base64

// Elementos
const form = document.getElementById("formProducto");
const tituloForm = document.getElementById("tituloForm");
const inNombre = document.getElementById("nombre");
const inPrecio = document.getElementById("precio");
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

  if (filtrados.length === 0) {
    tabla.innerHTML = `<tr><td colspan="6" class="vacio">${productos.length ? "Ningún producto coincide con la búsqueda." : "Aún no hay productos. Agrega el primero con el formulario."}</td></tr>`;
    return;
  }

  tabla.innerHTML = filtrados.map((p) => `
    <tr>
      <td>${p.imagen
        ? `<img class="miniatura" src="${p.imagen}" alt="">`
        : `<div class="miniatura"></div>`}</td>
      <td><strong>${escaparHTML(p.nombre)}</strong></td>
      <td>${escaparHTML(p.categoria)}</td>
      <td class="num">${soles(p.precio)}</td>
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
    </tr>`).join("");
}

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
  inCategoria.value = p.categoria || "";
  inActivo.checked = !!p.activo;
  inImagen.value = "";
  imagenBase64 = p.imagen || "";
  mostrarVistaPrevia();
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
  infoImagen.textContent = "Se reduce automáticamente a 400×400 px.";
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
  infoImagen.textContent = "Se reduce automáticamente a 400×400 px.";
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
    infoImagen.textContent = "Se reduce automáticamente a 400×400 px.";
    mostrarError(error.message || "No se pudo procesar la imagen.");
  }
});

/**
 * Reduce la imagen a máximo 400x400 (manteniendo proporción) y la
 * convierte a JPEG base64. Si aún pesa más de 200 KB, baja la calidad.
 */
function redimensionarImagen(archivo) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
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

      let calidad = 0.7;
      let resultado = canvas.toDataURL("image/jpeg", calidad);
      while (resultado.length > LIMITE_BASE64 && calidad > 0.3) {
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
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen. Prueba con un archivo JPG o PNG."));
    };
    img.src = url;
  });
}

// Guardar (crear o actualizar)
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  ocultarError();

  const nombre = inNombre.value.trim();
  const precio = redondear(parseFloat(inPrecio.value));
  const categoria = inCategoria.value.trim();

  if (!nombre) return mostrarError("Escribe el nombre del producto.", inNombre);
  if (!Number.isFinite(precio) || precio <= 0) return mostrarError("Escribe un precio válido mayor que 0.", inPrecio);
  if (!categoria) return mostrarError("Escribe o elige una categoría.", inCategoria);

  const duplicado = productos.find((p) =>
    p.id !== editandoId && (p.nombre || "").trim().toLowerCase() === nombre.toLowerCase()
  );
  if (duplicado) return mostrarError(`Ya existe un producto llamado "${duplicado.nombre}".`, inNombre);

  const datos = {
    nombre,
    precio,
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
