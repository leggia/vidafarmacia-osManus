// Diccionario marca comercial → principio activo, para el ~20% de productos cuya
// descripción en 365 no trae el principio activo. Cubre las marcas más vendidas en
// Bolivia. Se usa como RESPALDO: si la búsqueda de un principio activo no aparece en
// nombre ni descripción, se expande con las marcas equivalentes de este mapa.
// Mantener en minúsculas y sin tildes en las claves de principio activo.

// principioActivo -> [marcas comerciales conocidas]
export const PRINCIPIO_A_MARCAS: Record<string, string[]> = {
  "paracetamol": ["panadol", "tylenol", "mejoral", "termonat", "winadol", "acetaminofen", "acetaminofén", "dolofin", "febrizol"],
  "ibuprofeno": ["advil", "motrin", "ibupirac", "actron", "buprex", "dolgen", "ibucap"],
  "diclofenaco": ["voltaren", "cataflam", "dioxaflex", "flexidol", "dolflex", "clofen"],
  "aspirina": ["aspirina", "acido acetilsalicilico", "ácido acetilsalicílico", "asawin", "ecotrin", "cardioaspirina"],
  "amoxicilina": ["amoxil", "amoxidal", "trimoxal", "hiconcil", "clamoxyl"],
  "amoxicilina acido clavulanico": ["augmentin", "amoxidal duo", "clavulin", "curam", "fulgram"],
  "azitromicina": ["zithromax", "azitrolan", "azibiot", "sumamed", "azitral"],
  "cefalexina": ["keflex", "ceporex", "cefalexina"],
  "ciprofloxacino": ["ciproxina", "ciprofloxacina", "baycip", "cifran"],
  "omeprazol": ["losec", "prilosec", "omepron", "gastrimut", "ulcozol"],
  "ranitidina": ["zantac", "ranidine", "ranitidina"],
  "loratadina": ["clarityne", "claritin", "loratadina", "lisino", "alergaliv"],
  "cetirizina": ["zyrtec", "reactine", "cetirizina", "alerlisin"],
  "loperamida": ["imodium", "loperamida", "regulan"],
  "metformina": ["glucophage", "dabex", "glafornil", "metformina", "diabex"],
  "losartan": ["cozaar", "losartan", "losacor", "aratan", "hyzaar"],
  "enalapril": ["renitec", "enalapril", "lotrial", "glioten"],
  "atorvastatina": ["lipitor", "atorvastatina", "ateroclar", "lipibec"],
  "salbutamol": ["ventolin", "salbutamol", "aerolin", "asmavent"],
  "metronidazol": ["flagyl", "metronidazol", "colpofilin"],
  "naproxeno": ["naprosyn", "flanax", "naproxeno", "apronax", "alnovate"],
  "ketoprofeno": ["profenid", "ketoprofeno", "fastum"],
  "dexametasona": ["decadron", "dexametasona", "alin"],
  "prednisona": ["meticorten", "prednisona", "deltisona"],
  "clotrimazol": ["canesten", "clotrimazol", "gynocanesten"],
  "fluconazol": ["diflucan", "fluconazol", "flunal"],
  "aciclovir": ["zovirax", "aciclovir", "acivir"],
  "ambroxol": ["mucosolvan", "ambroxol", "mucoangin", "fluibron"],
  "bromhexina": ["bisolvon", "bromhexina"],
  "dextrometorfano": ["robitussin", "dextrometorfano", "romilar"],
  "ondansetron": ["zofran", "ondansetron", "vomistop"],
  "metoclopramida": ["primperan", "metoclopramida", "reglan"],
  "hioscina": ["buscapina", "hioscina", "butilhioscina", "espasmo"],
  "simeticona": ["dimetil", "simeticona", "flatoril", "gaseosan"],
  "domperidona": ["motilium", "domperidona"],
  "levotiroxina": ["eutirox", "levotiroxina", "synthroid", "t4"],
  "amlodipino": ["norvasc", "amlodipino", "amlodac"],
  "hidroclorotiazida": ["hidroclorotiazida", "diur", "hctz"],
  "insulina": ["insulina", "lantus", "humulin", "novorapid", "insulatard"],
  "sildenafil": ["viagra", "sildenafil", "magnus"],
  "vitamina c": ["vitamina c", "acido ascorbico", "ácido ascórbico", "redoxon", "cebion"],
  "complejo b": ["complejo b", "bedoyecta", "neurobion", "dolo neurobion"],
  "ibuprofeno paracetamol": ["dolstop", "carrico"],
};

// Índice inverso normalizado (marca -> principio activo) para búsquedas rápidas.
const normal = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const MARCA_A_PRINCIPIO: Record<string, string> = {};
for (const [pa, marcas] of Object.entries(PRINCIPIO_A_MARCAS)) {
  for (const m of marcas) MARCA_A_PRINCIPIO[normal(m)] = pa;
}

// Dado un término de búsqueda, devuelve términos EXTRA para ampliar la búsqueda:
// - si buscan un principio activo -> agrega sus marcas
// - si buscan una marca -> agrega su principio activo (y las otras marcas hermanas)
export function expandirBusqueda(termino: string): string[] {
  const t = normal(termino);
  const extras = new Set<string>();
  // ¿Es un principio activo conocido?
  for (const [pa, marcas] of Object.entries(PRINCIPIO_A_MARCAS)) {
    if (normal(pa) === t || normal(pa).includes(t) && t.length >= 4) {
      for (const m of marcas) extras.add(m);
    }
  }
  // ¿Es una marca conocida?
  if (MARCA_A_PRINCIPIO[t]) {
    const pa = MARCA_A_PRINCIPIO[t];
    extras.add(pa);
    for (const m of PRINCIPIO_A_MARCAS[pa]) extras.add(m);
  }
  extras.delete(t);
  return Array.from(extras).slice(0, 20);
}

// Para el filtro de controlados: dado un nombre de marca, devuelve su principio
// activo si lo conocemos (así un controlado vendido como marca se detecta aunque
// la descripción no lo diga).
export function principioDeMarca(nombre: string): string | null {
  const n = normal(nombre);
  for (const marca of Object.keys(MARCA_A_PRINCIPIO)) {
    if (n.includes(marca)) return MARCA_A_PRINCIPIO[marca];
  }
  return null;
}
