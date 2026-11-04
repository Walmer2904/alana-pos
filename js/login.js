// ============================================================
// login.js — Pantalla de inicio de sesión (index.html)
// ============================================================

import { auth, onAuthStateChanged, signInWithEmailAndPassword } from "./firebase.js";

const form = document.getElementById("formLogin");
const inputCorreo = document.getElementById("correo");
const inputClave = document.getElementById("clave");
const btnIngresar = document.getElementById("btnIngresar");
const cajaError = document.getElementById("errorLogin");

// Si ya hay una sesión abierta, ir directo a Ventas.
onAuthStateChanged(auth, (user) => {
  if (user) window.location.replace("ventas.html");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  ocultarError();

  const correo = inputCorreo.value.trim();
  const clave = inputClave.value;

  if (!correo || !clave) {
    mostrarError("Escribe tu correo y tu contraseña.");
    return;
  }
  if (!navigator.onLine) {
    mostrarError("No hay conexión a internet. Revisa tu red e inténtalo de nuevo.");
    return;
  }

  btnIngresar.disabled = true;
  btnIngresar.textContent = "Ingresando…";
  try {
    await signInWithEmailAndPassword(auth, correo, clave);
    // onAuthStateChanged se encarga de redirigir.
  } catch (error) {
    console.error("Error de login:", error.code);
    mostrarError(traducirError(error.code));
    btnIngresar.disabled = false;
    btnIngresar.textContent = "Ingresar";
    inputClave.select();
  }
});

/** Convierte los códigos de Firebase Auth en mensajes claros. */
function traducirError(codigo) {
  switch (codigo) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return "Correo o contraseña incorrectos.";
    case "auth/invalid-email":
      return "El correo no tiene un formato válido.";
    case "auth/user-disabled":
      return "Este usuario está deshabilitado. Consulta con el administrador.";
    case "auth/too-many-requests":
      return "Demasiados intentos fallidos. Espera unos minutos e inténtalo otra vez.";
    case "auth/network-request-failed":
      return "No hay conexión a internet. Revisa tu red e inténtalo de nuevo.";
    case "auth/unauthorized-domain":
      return "Este dominio no está autorizado en Firebase (Authentication > Configuración > Dominios autorizados).";
    default:
      return "No se pudo iniciar sesión. Inténtalo de nuevo.";
  }
}

function mostrarError(texto) {
  cajaError.textContent = texto;
  cajaError.classList.remove("oculto");
}
function ocultarError() {
  cajaError.classList.add("oculto");
}
