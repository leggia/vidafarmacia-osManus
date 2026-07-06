import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Search, Package, Loader2 } from "lucide-react";

/**
 * Página de SOLO CONSULTA (rol viewer): buscar productos y ver precio de venta + stock.
 * Pensada para contingencias (apagones largos, etc.) donde se necesita consultar
 * precios rápido sin dar acceso al resto del sistema.
 */
export default function Consulta() {
  const [busqueda, setBusqueda] = useState("");
  const [termino, setTermino] = useState("");

  // Debounce 350ms: busca mientras escribes sin disparar una consulta por tecla
  useEffect(() => {
    const t = setTimeout(() => setTermino(busqueda.trim()), 350);
    return () => clearTimeout(t);
  }, [busqueda]);

  const { data: resultados, isFetching } = trpc.consulta.buscarProductos.useQuery(
    { buscar: termino },
    { enabled: termino.length >= 2, staleTime: 30_000 }
  );

  // Búsqueda multi-palabra local sobre los resultados
  const filtrados = useMemo(() => {
    if (!resultados) return [];
    const palabras = termino.toLowerCase().split(/\s+/).filter(Boolean);
    return resultados.filter((p: any) => {
      const texto = `${p.nombre} ${p.codigo}`.toLowerCase();
      return palabras.every((w) => texto.includes(w));
    });
  }, [resultados, termino]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-xl mx-auto p-4 space-y-4">
        <div className="flex items-center gap-2 border-b border-foreground pb-3 pt-2">
          <Package className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-black uppercase tracking-tight">Consulta de precios</h1>
            <p className="text-[11px] text-muted-foreground">Precio de venta y stock disponible</p>
          </div>
        </div>

        {/* Buscador */}
        <div className="relative sticky top-2 z-10">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar producto (nombre o código)..."
            className="h-12 pl-10 text-base shadow-sm"
            autoFocus
          />
          {isFetching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 animate-spin text-muted-foreground" />}
        </div>

        {/* Resultados */}
        {termino.length < 2 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Search className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Escribe el nombre o código de un producto.</p>
          </div>
        ) : filtrados.length === 0 && !isFetching ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-sm">Sin resultados para "{termino}".</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtrados.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between bg-card border border-foreground/10 rounded-lg p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-sm leading-snug">{p.nombre}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Cód: {p.codigo} ·{" "}
                    <span className={p.stock > 0 ? "text-green-600" : "text-red-600"}>
                      {p.stock > 0 ? `${p.stock} en stock` : "Sin stock"}
                    </span>
                  </p>
                </div>
                <div className="text-right shrink-0 ml-3">
                  <p className="text-xl font-black text-primary">{p.precioVenta.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-foreground -mt-1">Bs</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
