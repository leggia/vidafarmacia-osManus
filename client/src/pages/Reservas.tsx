import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/**
 * PANEL DE RESERVAS para el staff (vendedoras, regente, admin).
 * Tabs por estado, código grande para verificar al cliente, WhatsApp directo,
 * y cambio de estado en un toque. Se refresca solo cada 30s.
 */
const TABS = [
  { id: "pendiente", txt: "Pendientes" },
  { id: "lista", txt: "Listas" },
  { id: "entregada", txt: "Entregadas" },
] as const;

export default function Reservas() {
  const [tab, setTab] = useState<string>("pendiente");
  const utils = trpc.useUtils();
  const { data: reservas, isFetching } = trpc.tienda.listarReservas.useQuery(
    { estado: tab },
    { refetchInterval: 30000 }
  );
  const cambiar = trpc.tienda.cambiarEstado.useMutation({
    onSuccess: () => { utils.tienda.listarReservas.invalidate(); },
    onError: (e) => toast.error("No se pudo actualizar: " + (e.message || "")),
  });

  const marcar = (id: number, estado: string, txt: string) => {
    cambiar.mutate({ id, estado });
    toast.success(txt);
  };

  const hace = (fecha: string) => {
    const min = Math.floor((Date.now() - new Date(fecha).getTime()) / 60000);
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} día(s)`;
  };

  const itemsDe = (r: any): Array<{ nombre: string; precio: number; cantidad: number }> => {
    try {
      const it = typeof r.items === "string" ? JSON.parse(r.items) : r.items;
      return Array.isArray(it) ? it : [];
    } catch { return []; }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-xl font-black mb-1">Reservas de clientes</h1>
      <p className="text-xs text-muted-foreground mb-4">El cliente presenta su código; verifica y entrega.</p>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`h-10 px-4 rounded-xl text-sm font-bold ${tab === t.id ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground"}`}>
            {t.txt}
          </button>
        ))}
      </div>

      {isFetching && !reservas && <p className="text-sm text-muted-foreground py-8 text-center">Cargando…</p>}
      {reservas?.length === 0 && (
        <p className="text-sm text-muted-foreground py-10 text-center">No hay reservas {TABS.find(t => t.id === tab)?.txt.toLowerCase()}.</p>
      )}

      <div className="space-y-3">
        {(reservas || []).map((r: any) => {
          const items = itemsDe(r);
          return (
            <div key={r.id} className="p-4 rounded-2xl bg-white dark:bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-2xl font-black tracking-wider text-emerald-700">{r.codigo}</span>
                <span className="text-[10px] text-muted-foreground">{hace(r.creadoEn)}</span>
              </div>
              {items.length > 0 ? (
                <div className="mb-2 space-y-0.5">
                  {items.map((i, j) => (
                    <p key={j} className="text-sm"><b>{i.cantidad}×</b> {i.nombre} <span className="text-muted-foreground text-xs">(Bs {(i.precio * i.cantidad).toFixed(2)})</span></p>
                  ))}
                </div>
              ) : (
                <p className="text-sm font-medium mb-2">{r.producto}</p>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
                <span>{r.nombreCliente} · <a className="text-emerald-700 font-bold" href={`https://wa.me/${String(r.telefono).replace(/[^\d]/g, "")}`} target="_blank" rel="noreferrer">{r.telefono}</a></span>
                <span className="font-bold">{r.sucursal?.replace("Sucursal ", "")} · Bs {Number(r.precio).toFixed(2)}</span>
              </div>
              <div className="flex gap-2">
                {tab === "pendiente" && (
                  <>
                    <button onClick={() => marcar(r.id, "lista", "Marcada como lista para recoger")}
                      className="flex-1 h-10 rounded-xl bg-sky-600 text-white text-xs font-bold active:scale-95">📦 Lista</button>
                    <button onClick={() => marcar(r.id, "entregada", "Entregada ✔")}
                      className="flex-1 h-10 rounded-xl bg-emerald-600 text-white text-xs font-bold active:scale-95">✔ Entregada</button>
                    <button onClick={() => marcar(r.id, "cancelada", "Reserva cancelada")}
                      className="h-10 px-3 rounded-xl bg-gray-100 dark:bg-muted text-gray-500 text-xs font-bold active:scale-95">✕</button>
                  </>
                )}
                {tab === "lista" && (
                  <button onClick={() => marcar(r.id, "entregada", "Entregada ✔")}
                    className="flex-1 h-10 rounded-xl bg-emerald-600 text-white text-xs font-bold active:scale-95">✔ Entregada</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
