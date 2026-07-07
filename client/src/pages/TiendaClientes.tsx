import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";

/**
 * TIENDA PÚBLICA de VidaFarma — app de farmacia completa:
 * home comercial (ofertas + categorías), búsqueda dinámica, carrito multi-producto,
 * reserva con código. Simplicidad radical, mobile-first.
 */
type ItemCarrito = { nombre: string; precio: number; cantidad: number; imagen?: string | null };

const CATEGORIAS = [
  { txt: "Dolor y fiebre", q: "paracetamol" },
  { txt: "Gripe y tos", q: "jarabe" },
  { txt: "Vitaminas", q: "vitamina" },
  { txt: "Estómago", q: "omeprazol" },
  { txt: "Bebé", q: "pañal" },
  { txt: "Dermo", q: "crema" },
];

export default function TiendaClientes() {
  const [termino, setTermino] = useState("");
  const [buscado, setBuscado] = useState("");
  const [carrito, setCarrito] = useState<ItemCarrito[]>([]);
  const [verCarrito, setVerCarrito] = useState(false);
  const [sucursal, setSucursal] = useState("");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [exito, setExito] = useState<{ codigo: string; mensaje: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

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
  const { data: ofertasData } = trpc.tienda.ofertas.useQuery(undefined, { staleTime: 120000 });
  const reservar = trpc.tienda.reservar.useMutation();

  const totalItems = carrito.reduce((t, i) => t + i.cantidad, 0);
  const totalBs = carrito.reduce((t, i) => t + i.precio * i.cantidad, 0);

  const agregar = (p: { nombre: string; precio: number; imagen?: string | null }) => {
    setCarrito(prev => {
      const ex = prev.find(i => i.nombre === p.nombre);
      if (ex) return prev.map(i => i.nombre === p.nombre ? { ...i, cantidad: Math.min(20, i.cantidad + 1) } : i);
      return [...prev, { ...p, cantidad: 1 }];
    });
    setExito(null);
  };
  const cambiarCant = (nombre: string, delta: number) => {
    setCarrito(prev => prev
      .map(i => i.nombre === nombre ? { ...i, cantidad: i.cantidad + delta } : i)
      .filter(i => i.cantidad > 0));
  };

  const waLink = (prod?: string) => {
    const numero = config?.whatsappGeneral || config?.porSucursal?.[0]?.whatsapp || "";
    if (!numero) return null;
    return `https://wa.me/${numero}?text=${encodeURIComponent(`Hola VidaFarma 👋 quiero consultar por: ${prod || "un producto"}`)}`;
  };

  const confirmarReserva = async () => {
    setErrorMsg("");
    try {
      const r: any = await reservar.mutateAsync({
        items: carrito.map(({ imagen, ...i }) => i),
        sucursal, nombreCliente: nombre, telefono,
      });
      if (r?.error) { setErrorMsg(r.error); return; }
      setExito({ codigo: r.codigo, mensaje: r.mensaje });
      setCarrito([]); setVerCarrito(false); setNombre(""); setTelefono(""); setSucursal("");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setErrorMsg("No se pudo crear la reserva. Intenta de nuevo.");
    }
  };

  const colores = ["bg-emerald-500", "bg-teal-500", "bg-cyan-600", "bg-sky-600", "bg-indigo-500", "bg-violet-500"];
  const Avatar = ({ nombre, imagen, grande }: { nombre: string; imagen?: string | null; grande?: boolean }) => {
    const cls = grande ? "w-16 h-16 text-2xl" : "w-14 h-14 text-xl";
    if (imagen) {
      return <img src={imagen} alt={nombre} loading="lazy"
        className={`${cls} rounded-xl object-cover bg-gray-50 border border-gray-100 shrink-0`}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />;
    }
    let h = 0; for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) % colores.length;
    return <div className={`${cls} rounded-xl ${colores[h]} text-white flex items-center justify-center font-black shrink-0`}>{nombre.trim().charAt(0).toUpperCase()}</div>;
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

  const sucCorta = (s: string) => s.replace("Sucursal ", "").replace("Casa Matriz Cobol", "Cobol").replace("Casa Matriz", "Matriz");
  const enHome = buscado.length < 3;

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white pb-28">
      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Encabezado */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-600 text-white text-2xl font-black mb-2 shadow-lg">V</div>
          <h1 className="text-2xl font-black text-emerald-900">VidaFarma</h1>
          <p className="text-sm text-emerald-700">Tu farmacia, en tu celular</p>
        </div>

        {/* Buscador dinámico */}
        <input
          value={termino}
          onChange={e => setTermino(e.target.value)}
          placeholder="¿Qué producto buscas?"
          className="w-full h-14 px-5 rounded-2xl border-2 border-emerald-200 focus:border-emerald-500 outline-none text-base shadow-sm mb-4"
        />

        {/* Éxito de reserva */}
        {exito && (
          <div className="mb-5 p-5 rounded-2xl bg-emerald-600 text-white text-center shadow-lg">
            <p className="text-sm opacity-90">Tu código de reserva</p>
            <p className="text-4xl font-black tracking-wider my-2">{exito.codigo}</p>
            <p className="text-sm">{exito.mensaje}</p>
          </div>
        )}

        {/* HOME comercial: ofertas + categorías */}
        {enHome && (
          <>
            {(ofertasData?.ofertas?.length || 0) > 0 && (
              <div className="mb-5">
                <h2 className="font-black text-emerald-900 mb-2 flex items-center gap-2">🔥 Ofertas de la semana</h2>
                <div className="space-y-2">
                  {ofertasData!.ofertas.map((o: any, i: number) => (
                    <div key={i} className="p-3 rounded-2xl bg-white border-2 border-amber-200 shadow-sm flex items-center gap-3">
                      <Avatar nombre={o.nombre} imagen={o.imagen} />
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-gray-900 text-sm leading-tight">{o.nombre}</p>
                        <p className="text-[11px]">
                          <span className="line-through text-gray-400 mr-2">Bs {o.precioNormal.toFixed(2)}</span>
                          <span className="text-lg font-black text-red-600">Bs {o.precio.toFixed(2)}</span>
                        </p>
                        {o.hasta && <p className="text-[10px] text-gray-400">Hasta el {o.hasta}</p>}
                      </div>
                      <button onClick={() => agregar(o)} className="h-10 px-4 rounded-xl bg-emerald-600 text-white font-bold text-xs active:scale-95 shrink-0">
                        Agregar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <h2 className="font-black text-emerald-900 mb-2">Explora por categoría</h2>
            <div className="grid grid-cols-3 gap-2 mb-6">
              {CATEGORIAS.map(c => (
                <button key={c.txt} onClick={() => setTermino(c.q)}
                  className="h-16 rounded-2xl bg-white border border-emerald-100 shadow-sm text-xs font-bold text-emerald-900 active:scale-95 px-1">
                  {c.txt}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Resultados de búsqueda */}
        {isFetching && <p className="text-center text-sm text-emerald-700 py-6">Buscando…</p>}
        {!isFetching && !enHome && data?.mensaje && (
          <div className="text-center py-6">
            <p className="text-sm text-gray-500 mb-3">{data.mensaje}</p>
            {waLink(buscado) && (
              <a href={waLink(buscado)!} target="_blank" rel="noreferrer"
                 className="inline-block px-5 py-3 rounded-xl bg-green-500 text-white font-bold text-sm">
                Consultar por WhatsApp
              </a>
            )}
          </div>
        )}
        <div className="space-y-3">
          {!enHome && data?.productos?.map((p: any, i: number) => (
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
                    <span className="text-[10px] text-gray-500">{sucCorta(d.sucursal)}:</span>
                    <Estado estado={d.estado} />
                  </div>
                ))}
              </div>
              <button onClick={() => agregar(p)}
                className="w-full h-11 rounded-xl bg-emerald-600 text-white font-bold text-sm active:scale-95">
                Agregar al carrito
              </button>
            </div>
          ))}
        </div>

        <p className="text-center text-[10px] text-gray-400 mt-8">
          Los productos con receta se atienden en mostrador. Precios sujetos a confirmación en farmacia.
        </p>
      </div>

      {/* Barra flotante del carrito */}
      {totalItems > 0 && !verCarrito && (
        <button onClick={() => setVerCarrito(true)}
          className="fixed bottom-4 left-4 right-4 max-w-lg mx-auto h-14 rounded-2xl bg-emerald-700 text-white font-black shadow-2xl flex items-center justify-between px-5 active:scale-[0.98] z-40">
          <span>🛒 {totalItems} producto{totalItems > 1 ? "s" : ""}</span>
          <span>Bs {totalBs.toFixed(2)} · Ver carrito →</span>
        </button>
      )}

      {/* Carrito + checkout */}
      {verCarrito && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setVerCarrito(false)}>
          <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-black text-lg text-gray-900 mb-3">Tu carrito</h3>
            {carrito.map(i => (
              <div key={i.nombre} className="flex items-center gap-2 py-2 border-b border-gray-100">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900 leading-tight">{i.nombre}</p>
                  <p className="text-xs text-emerald-700 font-bold">Bs {(i.precio * i.cantidad).toFixed(2)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => cambiarCant(i.nombre, -1)} className="w-8 h-8 rounded-lg bg-gray-100 font-black">−</button>
                  <span className="w-6 text-center font-bold text-sm">{i.cantidad}</span>
                  <button onClick={() => cambiarCant(i.nombre, 1)} className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 font-black">+</button>
                </div>
              </div>
            ))}
            <div className="flex justify-between items-center py-3 font-black text-gray-900">
              <span>Total</span><span className="text-emerald-700 text-xl">Bs {totalBs.toFixed(2)}</span>
            </div>
            <label className="text-xs font-bold text-gray-500">¿Dónde lo recoges?</label>
            <div className="grid grid-cols-2 gap-2 mt-1 mb-3">
              {(config?.sucursales || []).map((s: string) => (
                <button key={s} onClick={() => setSucursal(s)}
                  className={`h-11 rounded-xl text-xs font-bold border-2 ${sucursal === s ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-gray-200 text-gray-600"}`}>
                  {sucCorta(s)}
                </button>
              ))}
            </div>
            <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Tu nombre"
                   className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 focus:border-emerald-500 outline-none text-sm mb-2" />
            <input value={telefono} onChange={e => setTelefono(e.target.value)} placeholder="Tu teléfono (WhatsApp)" inputMode="tel"
                   className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 focus:border-emerald-500 outline-none text-sm mb-3" />
            {errorMsg && <p className="text-xs text-red-600 mb-2">{errorMsg}</p>}
            <button onClick={confirmarReserva} disabled={reservar.isPending || !sucursal || carrito.length === 0}
                    className="w-full h-12 rounded-xl bg-emerald-600 text-white font-black disabled:opacity-50 active:scale-95">
              {reservar.isPending ? "Reservando…" : `Reservar todo (Bs ${totalBs.toFixed(2)})`}
            </button>
            <button onClick={() => setVerCarrito(false)} className="w-full h-10 mt-2 text-sm text-gray-500 font-bold">Seguir comprando</button>
          </div>
        </div>
      )}
    </div>
  );
}
