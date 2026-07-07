import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * FOTOS DE PRODUCTOS (admin y regente).
 * Busca el producto, toma o elige la foto desde el celular, se comprime sola
 * (~600px, JPEG) y queda visible en la tienda de clientes al instante.
 */
export default function FotosProductos() {
  const [busqueda, setBusqueda] = useState("");
  const [termino, setTermino] = useState("");
  const [subiendoId, setSubiendoId] = useState<number | null>(null);
  const [refrescos, setRefrescos] = useState<Record<number, number>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const productoActivo = useRef<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTermino(busqueda.trim()), 350);
    return () => clearTimeout(t);
  }, [busqueda]);

  const { data: resultados, isFetching } = trpc.consulta.buscarProductos.useQuery(
    { buscar: termino },
    { enabled: termino.length >= 2, staleTime: 30_000 }
  );
  const subir = trpc.fotos.subir.useMutation();
  const quitar = trpc.fotos.quitar.useMutation();

  // Comprimir en el navegador: máx 600px, JPEG calidad 0.72 (~50-80KB)
  const comprimir = (file: File): Promise<{ base64: string; mime: string }> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 600;
        const escala = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * escala);
        canvas.height = Math.round(img.height * escala);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
        resolve({ base64: dataUrl.split(",")[1], mime: "image/jpeg" });
      };
      img.onerror = () => reject(new Error("No se pudo leer la imagen"));
      img.src = URL.createObjectURL(file);
    });

  const elegirFoto = (articuloId: number) => {
    productoActivo.current = articuloId;
    fileRef.current?.click();
  };

  const onArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const id = productoActivo.current;
    if (!file || !id) return;
    setSubiendoId(id);
    try {
      const { base64, mime } = await comprimir(file);
      await subir.mutateAsync({ articuloId: id, base64, mime });
      setRefrescos(prev => ({ ...prev, [id]: Date.now() }));
      toast.success("Foto guardada. Ya se ve en la tienda.");
    } catch (err: any) {
      toast.error(err?.message || "No se pudo subir la foto");
    } finally {
      setSubiendoId(null);
    }
  };

  const quitarFoto = async (articuloId: number) => {
    try {
      await quitar.mutateAsync({ articuloId });
      setRefrescos(prev => ({ ...prev, [articuloId]: Date.now() }));
      toast.success("Foto quitada");
    } catch (err: any) {
      toast.error(err?.message || "No se pudo quitar");
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1 className="text-xl font-black mb-1">Fotos de productos</h1>
      <p className="text-xs text-muted-foreground mb-4">
        Busca el producto y súbele una foto desde tu celular. Se comprime sola y aparece en la tienda de clientes.
      </p>
      <input
        value={busqueda}
        onChange={e => setBusqueda(e.target.value)}
        placeholder="Buscar producto…"
        className="w-full h-12 px-4 rounded-xl border-2 border-emerald-200 focus:border-emerald-500 outline-none text-sm mb-4"
        autoFocus
      />
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onArchivo} />
      {isFetching && <p className="text-sm text-muted-foreground py-4 text-center">Buscando…</p>}
      <div className="space-y-2">
        {(resultados || []).slice(0, 15).map((p: any) => {
          const cb = refrescos[p.id] ? `?v=${refrescos[p.id]}` : "";
          return (
            <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl bg-white border">
              <img
                src={`/api/foto-producto/${p.id}${cb}`}
                alt=""
                className="w-14 h-14 rounded-lg object-cover bg-gray-100 border"
                onError={(e) => { (e.target as HTMLImageElement).src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="#f3f4f6"/><text x="28" y="34" font-size="22" text-anchor="middle" fill="#9ca3af">📷</text></svg>'); }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{p.nombre}</p>
                <p className="text-[11px] text-muted-foreground">Bs {p.precioVenta}</p>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => elegirFoto(p.id)}
                  disabled={subiendoId === p.id}
                  className="h-9 px-3 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-50">
                  {subiendoId === p.id ? "Subiendo…" : "📷 Foto"}
                </button>
                <button
                  onClick={() => quitarFoto(p.id)}
                  className="h-9 px-2.5 rounded-lg border text-xs text-gray-500">
                  Quitar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
