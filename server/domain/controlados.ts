// Lógica PURA de medicamentos controlados (sin dependencias de BD ni frameworks),
// extraída de tienda.ts para poder testearla aislada (ver server/tests/smoke.ts y
// TESTING.md — caso de seguridad #1: un controlado NUNCA aparece en la tienda).
// Lista según normativa boliviana (psicotrópicos, estupefacientes, precursores):
// estos productos NO se ofertan online; se atienden en mostrador con receta y
// criterio de la regente.
import { principioDeMarca } from "../diccionario-principios";

export const CONTROLADOS = [
  // Benzodiacepinas
  "diazepam", "clonazepam", "alprazolam", "lorazepam", "midazolam", "bromazepam",
  "clobazam", "flunitrazepam", "nitrazepam", "triazolam", "cloxazolam", "ketazolam",
  "clordiazepoxido", "clordiazepóxido", "flurazepam", "tetrazepam",
  // Hipnóticos / sedantes
  "zolpidem", "zopiclona", "zaleplon", "fenobarbital", "pentobarbital", "secobarbital",
  // Opioides
  "tramadol", "codeina", "codeína", "morfina", "fentanil", "fentanilo", "oxicodona",
  "hidrocodona", "petidina", "meperidina", "metadona", "buprenorfina", "nalbufina",
  "tapentadol", "dextropropoxifeno", "tilidina",
  // Estimulantes / TDAH
  "metilfenidato", "anfetamina", "lisdexanfetamina", "modafinilo",
  // Anestésicos / otros de control
  "ketamina", "ergotamina", "flunarizina",
  // Anticonvulsivos de control
  "carbamazepina", "pregabalina", "gabapentina",
  // Precursores de uso restringido
  "pseudoefedrina", "efedrina", "misoprostol",
];

export const esControlado = (nombre: string, descripcion?: string | null): boolean => {
  const texto = `${nombre || ""} ${descripcion || ""}`.toLowerCase();
  if (CONTROLADOS.some(c => texto.includes(c))) return true;
  // Respaldo: si el nombre es una marca conocida cuyo principio activo es controlado
  const pa = principioDeMarca(nombre || "");
  return pa ? CONTROLADOS.some(c => pa.includes(c)) : false;
};
