import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";

/**
 * TIENDA PÚBLICA de VidaFarma (clientes, sin login).
 * Diseño: simplicidad radical — buscador grande, tarjetas claras, reserva en 2 campos.
 */
export default function TiendaClientes() {
  const [termino, setTermino] = useState("");
  const [buscado, setBuscado] = useState("");
  const [reservando, setReservando] = useState<{ producto: string; precio: number } | null>(null);
  const [sucursal, setSucursal] = useState("");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [exito, setExito] = useState<{ codigo: string; mensaje: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Búsqueda DINÁMICA: busca solo mientras escribes (debounce 400ms)
  useEffect(() => {
    const t = setTimeout(() => {
      const limpio = termino.trim();
      if (limpio.length >= 3) { setBuscado(limpio); setExito(null); }
      else if (limpio.length === 0) setBuscado("");
    }, 400);
    return () => clearTimeout(t);
  }, [termino]);

  const { data, isFetching } = trpc.tienda.buscar.useQuery(
    { termino: buscado },
    { enabled: buscado.length >= 3, staleTime: 60000 }
  );
  const { data: config } = trpc.tienda.config.useQuery(undefined, { staleTime: 300000 });
  const reservar = trpc.tienda.reservar.useMutation();

  const buscar = () => { setExito(null); setReservando(null); setBuscado(termino.trim()); };

  const waLink = (suc?: string, prod?: string) => {
    const numSuc = config?.porSucursal?.find(p => p.sucursal === suc)?.whatsapp;
    const numero = numSuc || config?.whatsappGeneral || "";
    if (!numero) return null;
    const texto = encodeURIComponent(`Hola VidaFarma 👋 quiero consultar por: ${prod || "un producto"}${suc ? ` (${suc})` : ""}`);
    return `https://wa.me/${numero}?text=${texto}`;
  };

  const confirmarReserva = async () => {
    setErrorMsg("");
    if (!reservando) return;
    try {
      const r: any = await reservar.mutateAsync({
        producto: reservando.producto, precio: reservando.precio,
        sucursal, nombreCliente: nombre, telefono,
      });
      if (r?.error) { setErrorMsg(r.error); return; }
      setExito({ codigo: r.codigo, mensaje: r.mensaje });
      setReservando(null); setNombre(""); setTelefono(""); setSucursal("");
    } catch (e: any) {
      setErrorMsg("No se pudo crear la reserva. Intenta de nuevo.");
    }
  };

  const colores = ["bg-emerald-500", "bg-teal-500", "bg-cyan-600", "bg-sky-600", "bg-indigo-500", "bg-violet-500"];
  const Avatar = ({ nombre, imagen }: { nombre: string; imagen?: string | null }) => {
    if (imagen) {
      return <img src={imagen} alt={nombre} loading="lazy"
        className="w-14 h-14 rounded-xl object-cover bg-gray-50 border border-gray-100 shrink-0"
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />;
    }
    let h = 0; for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) % colores.length;
    return (
      <div className={`w-14 h-14 rounded-xl ${colores[h]} text-white flex items-center justify-center text-xl font-black shrink-0`}>
        {nombre.trim().charAt(0).toUpperCase()}
      </div>
    );
  };

  const Estado = ({ estado }: { estado: string }) => {
    const cfg: Record<string, { txt: string; cls: string }> = {
      disponible: { txt: "Disponible", cls: "bg-emerald-100 text-emerald-800" },
      ultimas: { txt: "Últimas unidades", cls: "bg-amber-100 text-amber-800" },
      agotado: { txt: "Agotado", cls: "bg-gray-100 text-gray-500" },
      consultar: { txt: "Consultar", cls: "bg-gray-100 text-gray-500" },
    };
    const c = cfg[estado] || cfg.consultar;
    return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.cls}`}>{c.txt}</span>;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white">
      <div className="max-w-lg mx-auto px-4 py-8">
        {/* Encabezado */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-600 text-white text-3xl font-black mb-3 shadow-lg">V</div>
          <h1 className="text-2xl font-black text-emerald-900">VidaFarma</h1>
          <p className="text-sm text-emerald-700">Busca tu producto, resérvalo y recógelo</p>
        </div>

        {/* Buscador */}
        <div className="flex gap-2 mb-6">
          <input
            value={termino}
            onChange={e => setTermino(e.target.value)}
            onKeyDown={e => e.key === "Enter" && buscar()}
            placeholder="Escribe el producto… (busca solo)"
            className="flex-1 h-14 px-5 rounded-2xl border-2 border-emerald-200 focus:border-emerald-500 outline-none text-base shadow-sm"
          />
          <button onClick={buscar} className="h-14 px-6 rounded-2xl bg-emerald-600 text-white font-bold text-base shadow-sm active:scale-95">
            Buscar
          </button>
        </div>

        {/* Éxito de reserva */}
        {exito && (
          <div className="mb-6 p-5 rounded-2xl bg-emerald-600 text-white text-center shadow-lg">
            <p className="text-sm opacity-90">Tu código de reserva</p>
            <p className="text-4xl font-black tracking-wider my-2">{exito.codigo}</p>
            <p className="text-sm">{exito.mensaje}</p>
          </div>
        )}

        {/* Resultados */}
        {isFetching && <p className="text-center text-sm text-emerald-700 py-8">Buscando…</p>}
        {!isFetching && data?.mensaje && buscado && (
          <div className="text-center py-6">
            <p className="text-sm text-gray-500 mb-3">{data.mensaje}</p>
            {waLink(undefined, buscado) && (
              <a href={waLink(undefined, buscado)!} target="_blank" rel="noreferrer"
                 className="inline-block px-5 py-3 rounded-xl bg-green-500 text-white font-bold text-sm">
                Consultar por WhatsApp
              </a>
            )}
          </div>
        )}
        <div className="space-y-3">
          {data?.productos?.map((p: any, i: number) => (
            <div key={i} className="p-4 rounded-2xl bg-white border border-emerald-100 shadow-sm">
              <div className="flex items-start gap-3 mb-2">
                <Avatar nombre={p.nombre} imagen={p.imagen} />
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-gray-900 text-sm leading-tight">{p.nombre}</p>
                  <p className="text-xl font-black text-emerald-700">Bs {p.precio.toFixed(2)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {p.disponibilidad.map((d: any, j: number) => (
                  <div key={j} className="flex items-center gap-1">
                    <span className="text-[10px] text-gray-500">{d.sucursal.replace("Sucursal ", "").replace("Casa Matriz Cobol", "Cobol").replace("Casa Matriz", "Matriz")}:</span>
                    <Estado estado={d.estado} />
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setReservando({ producto: p.nombre, precio: p.precio }); setExito(null); setErrorMsg(""); }}
                  className="flex-1 h-11 rounded-xl bg-emerald-600 text-white font-bold text-sm active:scale-95">
                  Reservar
                </button>
                {waLink(undefined, p.nombre) && (
                  <a href={waLink(undefined, p.nombre)!} target="_blank" rel="noreferrer"
                     className="h-11 px-4 rounded-xl bg-green-500 text-white font-bold text-sm flex items-center">
                    WhatsApp
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Modal simple de reserva */}
        {reservando && (
          <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setReservando(null)}>
            <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
              <h3 className="font-black text-lg text-gray-900 mb-1">Reservar</h3>
              <p className="text-sm text-gray-600 mb-4">{reservando.producto} — <b>Bs {reservando.precio.toFixed(2)}</b></p>
              <label className="text-xs font-bold text-gray-500">¿Dónde lo recoges?</label>
              <div className="grid grid-cols-2 gap-2 mt-1 mb-3">
                {(config?.sucursales || []).map((s: string) => (
                  <button key={s} onClick={() => setSucursal(s)}
                    className={`h-11 rounded-xl text-xs font-bold border-2 ${sucursal === s ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-gray-200 text-gray-600"}`}>
                    {s.replace("Sucursal ", "").replace("Casa Matriz Cobol", "Cobol").replace("Casa Matriz", "Matriz")}
                  </button>
                ))}
              </div>
              <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Tu nombre"
                     className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 focus:border-emerald-500 outline-none text-sm mb-2" />
              <input value={telefono} onChange={e => setTelefono(e.target.value)} placeholder="Tu teléfono (WhatsApp)" inputMode="tel"
                     className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 focus:border-emerald-500 outline-none text-sm mb-3" />
              {errorMsg && <p className="text-xs text-red-600 mb-2">{errorMsg}</p>}
              <button onClick={confirmarReserva} disabled={reservar.isPending || !sucursal}
                      className="w-full h-12 rounded-xl bg-emerald-600 text-white font-black disabled:opacity-50 active:scale-95">
                {reservar.isPending ? "Reservando…" : "Confirmar reserva"}
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-[10px] text-gray-400 mt-10">
          Los productos con receta se atienden en mostrador. Precios sujetos a confirmación en farmacia.
        </p>
      </div>
    </div>
  );
}
