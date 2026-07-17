import { useState, useEffect } from "react";
import { Home, Search, Receipt, Gift, ShoppingCart, User } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * TIENDA PÚBLICA de VidaFarma — app de farmacia completa:
 * home comercial (ofertas + categorías), búsqueda dinámica, carrito multi-producto,
 * reserva con código. Simplicidad radical, mobile-first.
 */
type ItemCarrito = { nombre: string; precio: number; cantidad: number; imagen?: string | null };

const CATEGORIAS = [
  { txt: "Dolor y fiebre", q: "paracetamol", emoji: "🤕" },
  { txt: "Gripe y tos", q: "jarabe", emoji: "🤧" },
  { txt: "Vitaminas", q: "vitamina", emoji: "💊" },
  { txt: "Estómago", q: "omeprazol", emoji: "🩹" },
  { txt: "Bebé", q: "pañal", emoji: "🍼" },
  { txt: "Dermo", q: "crema", emoji: "🧴" },
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

  // Búsqueda INMEDIATA (categorías, chips de recompra): actualiza ambos estados a la
  // vez, sin esperar el debounce, para que el resultado aparezca al primer toque.
  const buscarInmediato = (q: string) => {
    const limpio = q.trim();
    setTermino(limpio);
    setBuscado(limpio);
    setExito(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const { data, isFetching, refetch } = trpc.tienda.buscar.useQuery(
    { termino: buscado },
    { enabled: buscado.length >= 3, staleTime: 60000 }
  );

  // Si los resultados llegaron sin disponibilidad (stock cargándose en segundo
  // plano la primera vez), reintentar una vez a los 2s para mostrar el semáforo.
  useEffect(() => {
    if (!data?.productos?.length) return;
    const todosConsultar = data.productos.every((p: any) =>
      p.disponibilidad?.every((d: any) => d.estado === "consultar"));
    if (todosConsultar) {
      const t = setTimeout(() => refetch(), 2000);
      return () => clearTimeout(t);
    }
  }, [data]);
  const { data: config } = trpc.tienda.config.useQuery(undefined, { staleTime: 300000 });
  const { data: ofertasData } = trpc.tienda.ofertas.useQuery(undefined, { staleTime: 120000 });
  const { data: masVendidos } = trpc.tienda.masVendidos.useQuery(undefined, { staleTime: 300000 });
  const { data: yo } = trpc.auth.me.useQuery(undefined, { staleTime: 300000 });
  const esCliente = !!yo?.email;
  const { data: misReservas } = trpc.tienda.misReservas.useQuery(undefined, { enabled: esCliente, staleTime: 60000 });
  const { data: recompra } = trpc.tienda.recompra.useQuery(undefined, { enabled: esCliente, staleTime: 60000 });
  const { data: puntos } = trpc.tienda.misPuntos.useQuery(undefined, { enabled: esCliente, staleTime: 60000 });
  const [verMisReservas, setVerMisReservas] = useState(false);
  const [verCuenta, setVerCuenta] = useState(false);
  const cerrarSesion = trpc.auth.logout.useMutation({ onSuccess: () => window.location.reload() });
  // Pedidos "activos" = los que el cliente todavía espera (pendiente o lista para
  // recoger). Es el número que importa mostrar en el icono.
  const pedidosActivos = (misReservas?.reservas || []).filter(
    (r: any) => r.estado === "pendiente" || r.estado === "lista"
  ).length;
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

  // Tarjeta de producto tipo grid (estilo CVS): foto grande, precio, disponibilidad, botón.
  const TarjetaProducto = ({ p }: { p: any }) => {
    const mejorEstado = p.disponibilidad?.some((d: any) => d.estado === "disponible") ? "disponible"
      : p.disponibilidad?.some((d: any) => d.estado === "ultimas") ? "ultimas"
      : p.disponibilidad?.some((d: any) => d.estado === "agotado") ? "agotado" : "consultar";
    return (
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden flex flex-col">
        <div className="relative bg-gray-50 aspect-square flex items-center justify-center p-3">
          {p.imagen ? (
            <img src={p.imagen} alt={p.nombre} loading="lazy" className="w-full h-full object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          ) : (
            <Avatar nombre={p.nombre} imagen={null} grande />
          )}
          {p.enOferta && (
            <span className="absolute top-2 left-2 text-[10px] font-black px-2 py-0.5 rounded-full bg-red-500 text-white shadow">
              -{Math.round((1 - p.precio / p.precioNormal) * 100)}%
            </span>
          )}
        </div>
        <div className="p-3 flex flex-col flex-1">
          <p className="font-semibold text-gray-900 text-xs leading-tight line-clamp-2 min-h-[2rem]">{p.nombre}</p>
          {p.descripcion && <p className="text-[10px] text-gray-400 leading-tight line-clamp-1 mt-0.5">{p.descripcion}</p>}
          <div className="mt-1.5 mb-2">
            {p.enOferta ? (
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-black text-red-600">Bs {p.precio.toFixed(2)}</span>
                <span className="line-through text-gray-400 text-[10px]">Bs {p.precioNormal.toFixed(2)}</span>
              </div>
            ) : (
              <span className="text-lg font-black text-emerald-700">Bs {p.precio.toFixed(2)}</span>
            )}
          </div>
          <div className="mt-auto">
            <div className="mb-2"><Estado estado={mejorEstado} /></div>
            <button onClick={() => agregar(p)}
              className="w-full h-9 rounded-xl bg-emerald-600 text-white font-bold text-xs active:scale-95">
              Agregar
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-white pb-28">
      {/* Barra superior FIJA. Cada icono tiene UNA función propia y distinta:
          Cuenta · Mis pedidos · Carrito. (Antes el usuario y la campana abrían
          los dos lo mismo, y el carrito vacío era un clic muerto sin respuesta.) */}
      <div className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-gray-100">
        <div className="max-w-lg mx-auto px-4 h-14 flex items-center justify-between">
          <img src="/vidafarma-logo.png" alt="VidaFarma" className="h-8 w-auto" />
          <div className="flex items-center gap-1">
            {/* 1. CUENTA — inicia sesión, o abre tu panel (puntos, cerrar sesión) */}
            {esCliente ? (
              <button onClick={() => setVerCuenta(true)}
                className="w-10 h-10 rounded-full flex items-center justify-center text-gray-600 active:scale-90"
                aria-label="Mi cuenta" title="Mi cuenta">
                <User className="w-5 h-5" />
              </button>
            ) : (
              <a href="/api/oauth/google/cliente"
                className="h-9 px-3 rounded-full flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 active:scale-95"
                aria-label="Iniciar sesión" title="Iniciar sesión">
                <User className="w-4 h-4" /> Entrar
              </a>
            )}

            {/* 2. MIS PEDIDOS — el estado de tus reservas (antes era una campana,
                   que significa "notificaciones" y confundía) */}
            <button onClick={() => esCliente ? setVerMisReservas(true) : (window.location.href = "/api/oauth/google/cliente")}
              className="w-10 h-10 rounded-full flex items-center justify-center text-gray-600 active:scale-90 relative"
              aria-label="Mis pedidos" title="Mis pedidos">
              <Receipt className="w-5 h-5" />
              {pedidosActivos > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-sky-600 text-white text-[10px] font-black flex items-center justify-center">
                  {pedidosActivos}
                </span>
              )}
            </button>

            {/* 3. CARRITO — siempre responde: si está vacío, lo dice (no se queda mudo) */}
            <button onClick={() => setVerCarrito(true)}
              className="w-10 h-10 rounded-full flex items-center justify-center text-gray-600 active:scale-90 relative"
              aria-label={totalItems > 0 ? `Carrito con ${totalItems} producto(s)` : "Carrito vacío"} title="Carrito">
              <ShoppingCart className="w-5 h-5" />
              {totalItems > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-600 text-white text-[10px] font-black flex items-center justify-center">
                  {totalItems}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Encabezado con lema */}
        <div className="text-center mb-5">
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

        {/* HOME comercial estilo profesional */}
        {enHome && (
          <>
            {/* Tarjeta de recompensas (estilo "Savings & rewards" de CVS) */}
            {esCliente && puntos ? (
              <div className="mb-5 p-4 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-lg">
                <p className="text-xs font-bold opacity-90 mb-2">Puntos y recompensas</p>
                <div className="flex items-end justify-between">
                  <div className="flex items-end gap-4">
                    <div>
                      <p className="text-3xl font-black leading-none">{puntos.puntos}</p>
                      <p className="text-[10px] opacity-80 mt-1">puntos</p>
                    </div>
                    <div className="border-l border-white/30 pl-4">
                      <p className="text-3xl font-black leading-none">{puntos.vales}</p>
                      <p className="text-[10px] opacity-80 mt-1">vale{puntos.vales !== 1 ? "s" : ""} de Bs {puntos.valorVale}</p>
                    </div>
                  </div>
                  <button onClick={() => setVerMisReservas(true)} className="h-9 px-4 rounded-full bg-white text-emerald-700 text-xs font-black active:scale-95">
                    Ver todo
                  </button>
                </div>
                <div className="mt-3 h-2 rounded-full bg-white/25 overflow-hidden">
                  <div className="h-full bg-white rounded-full transition-all" style={{ width: `${Math.min(100, ((1000 - puntos.faltanParaVale) / 1000) * 100)}%` }} />
                </div>
                <p className="text-[10px] opacity-80 mt-1.5">Te faltan {puntos.faltanParaVale} pts para tu próximo vale · Ganas puntos en tienda y mostrador</p>
              </div>
            ) : (
              <a href="/api/oauth/google/cliente" className="block mb-5 p-4 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-lg active:scale-[0.99]">
                <p className="font-black text-base">Únete y gana puntos 🎁</p>
                <p className="text-xs opacity-90 mt-0.5">Inicia sesión y acumula puntos en cada compra, canjéalos por vales de descuento.</p>
              </a>
            )}

            {/* Categorías con íconos */}
            <div className="grid grid-cols-3 gap-2 mb-6">
              {CATEGORIAS.map(c => (
                <button key={c.txt} onClick={() => buscarInmediato(c.q)}
                  className="flex flex-col items-center justify-center gap-1 h-20 rounded-2xl bg-white border border-gray-100 shadow-sm active:scale-95">
                  <span className="text-2xl">{c.emoji}</span>
                  <span className="text-[10px] font-bold text-gray-700 text-center leading-tight px-1">{c.txt}</span>
                </button>
              ))}
            </div>

            {/* Pedir de nuevo */}
            {esCliente && (recompra?.productos?.length || 0) > 0 && (
              <div className="mb-6">
                <h2 className="font-black text-gray-900 mb-2">Pedir de nuevo</h2>
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
                  {recompra!.productos.map((n: string, i: number) => (
                    <button key={i} onClick={() => buscarInmediato(n)}
                      className="shrink-0 h-10 px-3 rounded-full bg-white border border-gray-200 text-xs font-bold text-gray-700 active:scale-95">
                      🔁 {n.length > 20 ? n.slice(0, 20) + "…" : n}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Ofertas de la semana (carrusel) */}
            {(ofertasData?.ofertas?.length || 0) > 0 && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-black text-gray-900">🔥 Ofertas de la semana</h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x">
                  {ofertasData!.ofertas.map((o: any, i: number) => (
                    <div key={i} className="snap-start shrink-0 w-40">
                      <TarjetaProducto p={{ ...o, disponibilidad: [] }} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Lo más vendido (grid estilo Trending now de CVS) */}
            {(masVendidos?.productos?.length || 0) > 0 && (
              <div className="mb-6">
                <h2 className="font-black text-gray-900 mb-2">⭐ Lo más vendido</h2>
                <div className="grid grid-cols-2 gap-3">
                  {masVendidos!.productos.map((p: any, i: number) => (
                    <TarjetaProducto key={i} p={p} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Resultados de búsqueda (grid 2 columnas) */}
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
        {!enHome && (data?.productos?.length || 0) > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {data!.productos.map((p: any, i: number) => (
              <TarjetaProducto key={i} p={p} />
            ))}
          </div>
        )}

        <p className="text-center text-[10px] text-gray-400 mt-8">
          Los productos con receta se atienden en mostrador. Precios sujetos a confirmación en farmacia.
          {" · "}<a href="/privacidad" className="underline">Política de privacidad</a>
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
                    onClick={async () => { const p = await iniciarPago.mutateAsync({ reservaId: r.id, codigo: r.codigo }); setPagoActivo({ ...p, total: r.total, codigo: r.codigo }); }}
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
      {/* PANEL DE CUENTA — la función que le faltaba al icono de usuario:
          antes abría lo mismo que "Mis pedidos". Aquí van los datos del cliente,
          sus puntos y el cierre de sesión. */}
      {verCuenta && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setVerCuenta(false)}>
          <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
              <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
                <User className="w-6 h-6 text-emerald-700" />
              </div>
              <div className="min-w-0">
                <p className="font-black text-gray-900 truncate">{yo?.name || "Mi cuenta"}</p>
                {yo?.email && <p className="text-xs text-gray-500 truncate">{yo.email}</p>}
              </div>
            </div>

            {puntos && (
              <div className="my-4 p-4 rounded-2xl bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-100">
                <p className="text-xs font-bold text-emerald-800 uppercase tracking-wide">Tus puntos</p>
                <p className="text-3xl font-black text-emerald-700">{(puntos as any).puntos ?? 0}</p>
                {(puntos as any).faltanParaVale > 0 ? (
                  <p className="text-[11px] text-gray-600">
                    Te faltan <b>{(puntos as any).faltanParaVale}</b> puntos para un vale de Bs {(puntos as any).valorVale}.
                  </p>
                ) : (
                  <p className="text-[11px] font-bold text-emerald-700">🎉 ¡Ya tienes un vale disponible! Reclámalo en la sucursal.</p>
                )}
                {(puntos as any).vales > 0 && (
                  <p className="text-[11px] text-gray-600 mt-0.5">Vales ganados: <b>{(puntos as any).vales}</b></p>
                )}
              </div>
            )}

            <button onClick={() => { setVerCuenta(false); setVerMisReservas(true); }}
              className="w-full h-12 rounded-2xl bg-gray-50 text-gray-900 font-bold text-sm flex items-center justify-between px-4 active:scale-[0.98] mb-2">
              <span className="flex items-center gap-2"><Receipt className="w-4 h-4" /> Mis pedidos</span>
              {pedidosActivos > 0 && <span className="text-xs font-black text-sky-700">{pedidosActivos} activo(s)</span>}
            </button>

            <button onClick={() => cerrarSesion.mutate()} disabled={cerrarSesion.isPending}
              className="w-full h-12 rounded-2xl border border-gray-200 text-gray-600 font-bold text-sm flex items-center justify-center active:scale-[0.98] disabled:opacity-50">
              {cerrarSesion.isPending ? "Cerrando…" : "Cerrar sesión"}
            </button>
          </div>
        </div>
      )}

      {verCarrito && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50" onClick={() => setVerCarrito(false)}>
          <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-black text-lg text-gray-900 mb-3">Tu carrito</h3>
            {carrito.length === 0 && (
              <div className="text-center py-10">
                <ShoppingCart className="w-12 h-12 mx-auto text-gray-300 mb-3" />
                <p className="text-sm font-bold text-gray-900">Tu carrito está vacío</p>
                <p className="text-xs text-gray-500 mb-4">Busca un medicamento y agrégalo para reservarlo.</p>
                <button onClick={() => setVerCarrito(false)}
                  className="h-11 px-5 rounded-full bg-emerald-600 text-white text-sm font-black active:scale-95">
                  Buscar productos
                </button>
              </div>
            )}
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
