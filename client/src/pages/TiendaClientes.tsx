import { useState, useEffect } from "react";
import { Home, Search, Receipt, Gift } from "lucide-react";
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
  const [cupon, setCupon] = useState("");

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
  const { data: yo } = trpc.auth.me.useQuery(undefined, { staleTime: 300000 });
  const esCliente = !!yo?.email;
  const { data: misReservas } = trpc.tienda.misReservas.useQuery(undefined, { enabled: esCliente, staleTime: 60000 });
  const { data: recompra } = trpc.tienda.recompra.useQuery(undefined, { enabled: esCliente, staleTime: 60000 });
  const { data: puntos } = trpc.tienda.misPuntos.useQuery(undefined, { enabled: esCliente, staleTime: 60000 });
  const [verMisReservas, setVerMisReservas] = useState(false);
  const [pagoActivo, setPagoActivo] = useState<any>(null);
  const reservar = trpc.tienda.reservar.useMutation();
  const iniciarPago = trpc.tienda.iniciarPago.useMutation();

  useEffect(() => { if (yo?.name && !nombre) setNombre(yo.name); }, [yo]);

  const totalItems = carrito.reduce((t, i) => t + i.cantidad, 0);
  const subtotalBs = carrito.reduce((t, i) => t + i.precio * i.cantidad, 0);
  const { data: preview } = trpc.tienda.previewTotal.useQuery(
    { items: carrito.map(({ imagen, ...i }) => i), cupon: cupon.trim() || undefined },
    { enabled: verCarrito && carrito.length > 0, staleTime: 0 }
  );
  const totalBs = preview?.total ?? subtotalBs;

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
        sucursal, nombreCliente: nombre, telefono, cupon: cupon.trim() || undefined,
      });
      if (r?.error) { setErrorMsg(r.error); return; }
      setExito({ codigo: r.codigo, mensaje: r.mensaje });
      setCarrito([]); setVerCarrito(false); setNombre(""); setTelefono(""); setSucursal(""); setCupon("");
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
        {/* Barra superior: logo pequeño + cuenta */}
        <div className="flex items-center justify-between mb-4">
          <img src="/vidafarma-logo.png" alt="VidaFarma" className="h-9 w-auto" />
          {esCliente ? (
            <button onClick={() => setVerMisReservas(true)}
              className="flex items-center gap-1.5 h-9 px-3 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold active:scale-95">
              🧾 Mis reservas{(misReservas?.reservas?.length || 0) > 0 ? ` (${misReservas!.reservas.length})` : ""}
            </button>
          ) : (
            <a href="/api/oauth/google/cliente"
              className="flex items-center gap-2 h-9 px-4 rounded-full bg-white border-2 border-emerald-500 text-emerald-700 text-xs font-bold shadow-sm active:scale-95">
              <svg width="14" height="14" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41 35.3 44 30.1 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
              Iniciar sesión
            </a>
          )}
        </div>

        {/* Encabezado con lema mejorado + símbolo de marca */}
        <div className="text-center mb-5 relative">
          <img src="/vidafarma-simbolo.png" alt="" className="w-10 h-10 mx-auto mb-1 opacity-90" />
          <h1 className="text-xl font-black text-gray-900">Tu salud, más cerca que nunca</h1>
          <p className="text-sm text-gray-500 mt-0.5">Busca, reserva y recoge en tu sucursal</p>
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
            {esCliente && puntos && (
              <div className="mb-5 p-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs opacity-90">Tus puntos VidaFarma</p>
                    <p className="text-3xl font-black">{puntos.puntos}</p>
                  </div>
                  <div className="text-right">
                    {puntos.vales > 0 && <p className="text-sm font-bold">🎟️ {puntos.vales} vale(s) de Bs {puntos.valorVale}</p>}
                    <p className="text-[11px] opacity-90">Te faltan {puntos.faltanParaVale} pts para tu próximo vale</p>
                    <p className="text-[10px] opacity-75 mt-0.5">Ganas puntos en tienda y en mostrador</p>
                  </div>
                </div>
                <div className="mt-2 h-2 rounded-full bg-white/25 overflow-hidden">
                  <div className="h-full bg-white rounded-full" style={{ width: `${Math.min(100, ((1000 - puntos.faltanParaVale) / 1000) * 100)}%` }} />
                </div>
              </div>
            )}
            {(ofertasData?.ofertas?.length || 0) > 0 && (
              <div className="mb-5">
                <h2 className="font-black text-gray-900 mb-2 flex items-center gap-2">🔥 Ofertas de la semana</h2>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x snap-mandatory">
                  {ofertasData!.ofertas.map((o: any, i: number) => (
                    <div key={i} className="snap-start shrink-0 w-44 p-3 rounded-2xl bg-white border-2 border-amber-200 shadow-sm flex flex-col">
                      <div className="relative">
                        <Avatar nombre={o.nombre} imagen={o.imagen} grande />
                        <span className="absolute -top-1 -right-1 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-red-500 text-white shadow">
                          -{Math.round((1 - o.precio / o.precioNormal) * 100)}%
                        </span>
                      </div>
                      <p className="font-bold text-gray-900 text-xs leading-tight mt-2 line-clamp-2 min-h-[2rem]">{o.nombre}</p>
                      <div className="mt-1">
                        <span className="line-through text-gray-400 text-[10px]">Bs {o.precioNormal.toFixed(2)}</span>
                        <p className="text-lg font-black text-red-600 leading-none">Bs {o.precio.toFixed(2)}</p>
                      </div>
                      {o.hasta && <p className="text-[9px] text-gray-400 mt-0.5">Hasta {o.hasta}</p>}
                      <button onClick={() => agregar(o)} className="mt-2 h-9 rounded-xl bg-emerald-600 text-white font-bold text-xs active:scale-95">
                        Agregar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {esCliente && (recompra?.productos?.length || 0) > 0 && (
              <div className="mb-5">
                <h2 className="font-black text-emerald-900 mb-2">🔁 Pedir de nuevo</h2>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {recompra!.productos.map((n: string, i: number) => (
                    <button key={i} onClick={() => setTermino(n)}
                      className="shrink-0 h-10 px-3 rounded-xl bg-white border border-emerald-100 text-xs font-bold text-emerald-900 active:scale-95">
                      {n.length > 22 ? n.slice(0, 22) + "…" : n}
                    </button>
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
                  {p.descripcion && <p className="text-[11px] text-gray-500 leading-tight mt-0.5">{p.descripcion}</p>}
                  {p.enOferta ? (
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="text-xs line-through text-gray-400">Bs {p.precioNormal.toFixed(2)}</span>
                      <span className="text-xl font-black text-red-600">Bs {p.precio.toFixed(2)}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">OFERTA</span>
                    </div>
                  ) : (
                    <p className="text-xl font-black text-emerald-700 mt-0.5">Bs {p.precio.toFixed(2)}</p>
                  )}
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

      {/* Barra flotante del carrito (encima de la navegación inferior) */}
      {totalItems > 0 && !verCarrito && (
        <button onClick={() => setVerCarrito(true)}
          className="fixed bottom-20 left-4 right-4 max-w-lg mx-auto h-14 rounded-2xl bg-emerald-700 text-white font-black shadow-2xl flex items-center justify-between px-5 active:scale-[0.98] z-40">
          <span>🛒 {totalItems} producto{totalItems > 1 ? "s" : ""}</span>
          <span>Bs {totalBs.toFixed(2)} · Ver carrito →</span>
        </button>
      )}

      {/* Mis reservas */}
      {verMisReservas && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setVerMisReservas(false)}>
          <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-black text-lg text-gray-900 mb-3">Mis reservas</h3>
            {(misReservas?.reservas?.length || 0) === 0 && <p className="text-sm text-gray-500 py-6 text-center">Aún no tienes reservas.</p>}
            {misReservas?.reservas?.map((r: any, i: number) => (
              <div key={i} className="py-3 border-b border-gray-100">
                <div className="flex justify-between items-center">
                  <span className="font-black text-emerald-700">{r.codigo}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{r.estado}</span>
                </div>
                <p className="text-sm text-gray-700 mt-1">{r.resumen}</p>
                <p className="text-xs text-gray-400">{r.sucursal?.replace("Sucursal ", "")} · Bs {r.total.toFixed(2)} · {r.fecha}</p>
                {r.estado === "pendiente" && (
                  <button
                    onClick={async () => { const p = await iniciarPago.mutateAsync({ reservaId: r.id }); setPagoActivo({ ...p, total: r.total, codigo: r.codigo }); }}
                    className="mt-2 h-9 px-4 rounded-lg bg-emerald-600 text-white text-xs font-bold active:scale-95">
                    💳 Pagar en línea
                  </button>
                )}
              </div>
            ))}
            <button onClick={() => setVerMisReservas(false)} className="w-full h-11 mt-4 rounded-xl bg-emerald-600 text-white font-bold">Cerrar</button>
          </div>
        </div>
      )}

      {/* Pago QR */}
      {pagoActivo && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setPagoActivo(null)}>
          <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 text-center" onClick={e => e.stopPropagation()}>
            <h3 className="font-black text-lg text-gray-900 mb-1">Pagar reserva {pagoActivo.codigo}</h3>
            <p className="text-2xl font-black text-emerald-700 mb-3">Bs {Number(pagoActivo.total || pagoActivo.monto || 0).toFixed(2)}</p>
            {pagoActivo.modo === "qr" && pagoActivo.qrImagen && (
              <>
                <img src={pagoActivo.qrImagen.startsWith("data:") ? pagoActivo.qrImagen : `data:image/png;base64,${pagoActivo.qrImagen}`}
                     alt="QR de pago" className="w-56 h-56 mx-auto rounded-xl border" />
                <p className="text-sm text-gray-600 mt-3">Escanea este QR con la app de tu banco. Tu pago se confirma automáticamente.</p>
              </>
            )}
            {pagoActivo.modo === "manual" && (
              <div className="text-left text-sm">
                {pagoActivo.datosPago?.qrEstatico && (
                  <img src={pagoActivo.datosPago.qrEstatico} alt="QR" className="w-48 h-48 mx-auto rounded-xl border mb-3" />
                )}
                <div className="bg-gray-50 rounded-xl p-3 space-y-1">
                  {pagoActivo.datosPago?.titular && <p><b>Titular:</b> {pagoActivo.datosPago.titular}</p>}
                  {pagoActivo.datosPago?.banco && <p><b>Banco:</b> {pagoActivo.datosPago.banco}</p>}
                  {pagoActivo.datosPago?.cuenta && <p><b>Cuenta:</b> {pagoActivo.datosPago.cuenta}</p>}
                </div>
                <p className="text-gray-600 mt-3">{pagoActivo.mensaje}</p>
                <p className="text-xs text-gray-400 mt-2">Cuando pagues, avísanos por WhatsApp con tu comprobante y código {pagoActivo.codigo}.</p>
              </div>
            )}
            {pagoActivo.yaPagado && <p className="text-emerald-700 font-bold">{pagoActivo.mensaje}</p>}
            {pagoActivo.error && <p className="text-red-600">{pagoActivo.error}</p>}
            <button onClick={() => setPagoActivo(null)} className="w-full h-11 mt-4 rounded-xl bg-gray-100 text-gray-600 font-bold">Cerrar</button>
          </div>
        </div>
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
            {/* Cupón */}
            <div className="flex gap-2 mt-3 mb-2">
              <input value={cupon} onChange={e => setCupon(e.target.value.toUpperCase())} placeholder="¿Tienes un cupón?"
                     className="flex-1 h-11 px-3 rounded-xl border-2 border-gray-200 focus:border-emerald-500 outline-none text-sm uppercase" />
            </div>
            {preview?.error && <p className="text-xs text-amber-600 mb-1">{preview.error}</p>}
            {/* Desglose */}
            <div className="py-2 space-y-1 text-sm">
              <div className="flex justify-between text-gray-500"><span>Subtotal</span><span>Bs {subtotalBs.toFixed(2)}</span></div>
              {preview?.descuentos?.map((d: any, i: number) => (
                <div key={i} className="flex justify-between text-emerald-700"><span>{d.concepto}</span><span>− Bs {d.monto.toFixed(2)}</span></div>
              ))}
              <div className="flex justify-between items-center pt-1 font-black text-gray-900 border-t">
                <span>Total</span><span className="text-emerald-700 text-xl">Bs {totalBs.toFixed(2)}</span>
              </div>
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

      {/* Barra de navegación inferior (estilo app: como CVS/Walgreens) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 shadow-[0_-2px_10px_rgba(0,0,0,0.04)] z-30">
        <div className="max-w-lg mx-auto flex items-center justify-around h-16">
          <button onClick={() => { setTermino(""); setBuscado(""); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            className={`flex flex-col items-center gap-0.5 ${enHome ? "text-emerald-600" : "text-gray-400"}`}>
            <Home className="w-5 h-5" /><span className="text-[10px] font-bold">Inicio</span>
          </button>
          <button onClick={() => document.querySelector<HTMLInputElement>('input[placeholder*="producto"]')?.focus()}
            className="flex flex-col items-center gap-0.5 text-gray-400">
            <Search className="w-5 h-5" /><span className="text-[10px] font-bold">Buscar</span>
          </button>
          <button onClick={() => esCliente ? setVerMisReservas(true) : (window.location.href = "/api/oauth/google/cliente")}
            className="flex flex-col items-center gap-0.5 text-gray-400 relative">
            <Receipt className="w-5 h-5" /><span className="text-[10px] font-bold">Reservas</span>
            {(misReservas?.reservas?.filter((r: any) => r.estado === "pendiente" || r.estado === "lista").length || 0) > 0 && (
              <span className="absolute -top-1 right-2 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>
          <button onClick={() => esCliente ? setVerMisReservas(true) : (window.location.href = "/api/oauth/google/cliente")}
            className="flex flex-col items-center gap-0.5 text-gray-400">
            <Gift className="w-5 h-5" /><span className="text-[10px] font-bold">Puntos{esCliente && puntos ? ` ${puntos.puntos}` : ""}</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
