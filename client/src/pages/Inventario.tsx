import { useState, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ClipboardCheck, Search, Loader2, Check, AlertTriangle,
  Package, TrendingUp, Filter, Save, RotateCcw, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

interface ConteoItem {
  id: number;
  nombre: string;
  codigo: string;
  stock: number;        // sistema
  costoUnit: number;
  precioVenta: number;
  valorStock: number;
  clase: string;        // A, B, C
  categoria?: string;
  fisico: number | null; // ingresado por el usuario
}

export default function Inventario() {
  const [modo, setModo] = useState<"anual" | "ciclico_abc">("anual");
  const [proveedorFiltro, setProveedorFiltro] = useState("");
  const [proveedorActivo, setProveedorActivo] = useState<{ id: string; nombre: string } | null>(null);
  const [proveedoresLista, setProveedoresLista] = useState<any[]>([]);
  const [buscandoProv, setBuscandoProv] = useState(false);
  const [items, setItems] = useState<ConteoItem[]>([]);
  const [resumen, setResumen] = useState<any>(null);
  const [cargando, setCargando] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [soloDiferencias, setSoloDiferencias] = useState(false);
  const [filtroClase, setFiltroClase] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const guardarConteo = trpc.inventario.guardarConteo.useMutation();

  // Buscar proveedores
  const buscarProveedores = useCallback(async () => {
    setBuscandoProv(true);
    try {
      const provs = await utils.confirmaciones.listarProveedores.fetch({ filtro: proveedorFiltro });
      setProveedoresLista(Array.isArray(provs) ? provs : []);
    } catch {
      setProveedoresLista([]);
    }
    setBuscandoProv(false);
  }, [proveedorFiltro, utils]);

  // Cargar productos para conteo
  const cargarProductos = useCallback(async (idProveedor: string, nombreProv: string) => {
    setCargando(true);
    setProveedorActivo({ id: idProveedor, nombre: nombreProv });
    setProveedoresLista([]);
    try {
      const res = await utils.inventario.listar.fetch({ idProveedor });
      let productos = res.productos.map((p: any) => ({ ...p, fisico: null }));
      // En modo cíclico ABC, priorizar clase A (las más importantes)
      if (modo === "ciclico_abc") {
        productos = productos.sort((a: any, b: any) => {
          const orden: any = { A: 0, B: 1, C: 2 };
          return orden[a.clase] - orden[b.clase];
        });
      }
      setItems(productos);
      setResumen(res.resumen);
      if (productos.length === 0) toast.info("Este proveedor no tiene productos");
    } catch (e: any) {
      toast.error("Error cargando productos: " + (e.message || ""));
    }
    setCargando(false);
  }, [modo, utils]);

  const setFisico = (id: number, valor: string) => {
    const v = valor === "" ? null : parseInt(valor);
    setItems(prev => prev.map(it => it.id === id ? { ...it, fisico: isNaN(v as any) ? null : v } : it));
  };

  // Estadísticas en vivo
  const stats = useMemo(() => {
    const contados = items.filter(i => i.fisico !== null);
    const conDif = contados.filter(i => i.fisico !== i.stock);
    const valorDiferencias = conDif.reduce((acc, i) => acc + ((i.fisico! - i.stock) * i.costoUnit), 0);
    return {
      total: items.length,
      contados: contados.length,
      pendientes: items.length - contados.length,
      conDiferencia: conDif.length,
      valorDiferencias: Math.round(valorDiferencias * 100) / 100,
    };
  }, [items]);

  // Lista filtrada para mostrar
  const itemsFiltrados = useMemo(() => {
    let r = items;
    if (busqueda) {
      const b = busqueda.toLowerCase();
      r = r.filter(i => i.nombre.toLowerCase().includes(b) || i.codigo.toLowerCase().includes(b));
    }
    if (filtroClase) r = r.filter(i => i.clase === filtroClase);
    if (soloDiferencias) r = r.filter(i => i.fisico !== null && i.fisico !== i.stock);
    return r;
  }, [items, busqueda, filtroClase, soloDiferencias]);

  const guardar = async () => {
    const conteos = items.filter(i => i.fisico !== null).map(i => ({
      articuloId: i.id,
      nombre: i.nombre,
      stockSistema: i.stock,
      stockFisico: i.fisico!,
      diferencia: i.fisico! - i.stock,
    }));
    if (conteos.length === 0) { toast.error("No has contado ningún producto"); return; }
    try {
      const res = await guardarConteo.mutateAsync({
        tipo: modo,
        proveedor: proveedorActivo?.nombre,
        conteos,
      });
      toast.success(`Conteo guardado: ${res.totalContados} productos, ${res.conDiferencia} con diferencia`, { duration: 6000 });
    } catch (e: any) {
      toast.error("Error: " + (e.message || ""));
    }
  };

  const claseColor = (c: string) =>
    c === "A" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
    : c === "B" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
    : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-foreground pb-4">
        <div className="h-11 w-11 rounded-lg bg-primary/10 flex items-center justify-center">
          <ClipboardCheck className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-black uppercase tracking-tight">Inventario Físico</h1>
          <p className="text-xs text-muted-foreground">Conteo por proveedor y conteo cíclico ABC</p>
        </div>
      </div>

      {!proveedorActivo ? (
        <Card>
          <CardContent className="pt-6 space-y-5">
            {/* Selector de modo */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Tipo de conteo</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  onClick={() => setModo("anual")}
                  className={`text-left rounded-lg border-2 p-4 transition-all ${modo === "anual" ? "border-primary bg-primary/5" : "border-foreground/15 hover:border-foreground/30"}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Package className="h-4 w-4 text-primary" />
                    <span className="font-bold text-sm">Conteo Anual</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Conteo completo por proveedor. Ideal una vez al año, proveedor por proveedor.</p>
                </button>
                <button
                  onClick={() => setModo("ciclico_abc")}
                  className={`text-left rounded-lg border-2 p-4 transition-all ${modo === "ciclico_abc" ? "border-primary bg-primary/5" : "border-foreground/15 hover:border-foreground/30"}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    <span className="font-bold text-sm">Cíclico ABC</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Prioriza productos de mayor valor (clase A). Ideal cada 3 meses, sin parar la farmacia.</p>
                </button>
              </div>
            </div>

            {/* Selección de proveedor */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Proveedor a contar</p>
              <div className="flex gap-2">
                <Input
                  value={proveedorFiltro}
                  onChange={(e) => setProveedorFiltro(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") buscarProveedores(); }}
                  placeholder="Buscar proveedor (ej: Bago, Sanat)..."
                  className="flex-1"
                />
                <Button onClick={buscarProveedores} disabled={buscandoProv} className="gap-2">
                  {buscandoProv ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Buscar
                </Button>
              </div>

              {proveedoresLista.length > 0 && (
                <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
                  {proveedoresLista.map((prov: any) => (
                    <button
                      key={prov.id}
                      onClick={() => cargarProductos(String(prov.id), prov.nombre)}
                      className="w-full flex items-center justify-between bg-muted/40 hover:bg-primary/10 rounded-lg px-3 py-2.5 transition-colors text-left"
                    >
                      <span className="text-sm font-medium">{prov.nombre}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => cargarProductos("", "Todos los proveedores")}
                className="mt-3 text-xs text-primary hover:underline"
              >
                O contar TODO el inventario (todos los proveedores)
              </button>
            </div>
          </CardContent>
        </Card>
      ) : cargando ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Cargando productos de {proveedorActivo.nombre}...</p>
        </div>
      ) : (
        <>
          {/* Barra de resumen pegajosa */}
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-foreground/10 -mx-4 px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setProveedorActivo(null); setItems([]); setResumen(null); }} className="gap-1 text-xs h-8">
                  <RotateCcw className="h-3 w-3" /> Cambiar
                </Button>
                <span className="text-sm font-bold">{proveedorActivo.nombre}</span>
                <span className="text-[11px] px-2 py-0.5 rounded bg-primary/10 text-primary font-medium uppercase">{modo === "anual" ? "Anual" : "Cíclico ABC"}</span>
              </div>
              <Button onClick={guardar} disabled={guardarConteo.isPending || stats.contados === 0} className="gap-2 h-8 text-xs bg-green-700 hover:bg-green-800 text-white">
                {guardarConteo.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Guardar conteo
              </Button>
            </div>

            {/* Indicadores */}
            <div className="grid grid-cols-4 gap-2">
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className="text-lg font-black">{stats.contados}<span className="text-xs text-muted-foreground font-normal">/{stats.total}</span></p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Contados</p>
              </div>
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className="text-lg font-black text-amber-600">{stats.pendientes}</p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Pendientes</p>
              </div>
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className={`text-lg font-black ${stats.conDiferencia > 0 ? "text-red-600" : ""}`}>{stats.conDiferencia}</p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Diferencias</p>
              </div>
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className={`text-sm font-black ${stats.valorDiferencias < 0 ? "text-red-600" : stats.valorDiferencias > 0 ? "text-green-600" : ""}`}>
                  {stats.valorDiferencias > 0 ? "+" : ""}{stats.valorDiferencias.toFixed(0)}
                </p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Bs dif.</p>
              </div>
            </div>

            {/* Progreso */}
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${stats.total > 0 ? (stats.contados / stats.total) * 100 : 0}%` }} />
            </div>

            {/* Filtros */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[140px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar producto..." className="h-8 text-xs pl-7" />
              </div>
              {["A", "B", "C"].map(c => (
                <button
                  key={c}
                  onClick={() => setFiltroClase(filtroClase === c ? null : c)}
                  className={`text-[11px] px-2.5 py-1 rounded font-bold ${filtroClase === c ? claseColor(c) + " ring-2 ring-offset-1 ring-current" : claseColor(c)}`}
                  title={c === "A" ? "Alto valor (80% del total)" : c === "B" ? "Valor medio" : "Bajo valor"}
                >
                  {c} {resumen ? `(${c === "A" ? resumen.claseA : c === "B" ? resumen.claseB : resumen.claseC})` : ""}
                </button>
              ))}
              <button
                onClick={() => setSoloDiferencias(!soloDiferencias)}
                className={`text-[11px] px-2.5 py-1 rounded font-medium flex items-center gap-1 ${soloDiferencias ? "bg-red-600 text-white" : "bg-muted text-muted-foreground"}`}
              >
                <Filter className="h-3 w-3" /> Diferencias
              </button>
            </div>
          </div>

          {/* Lista de conteo */}
          <div className="space-y-1.5">
            {itemsFiltrados.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-10">No hay productos que coincidan.</p>
            ) : itemsFiltrados.map((item) => {
              const dif = item.fisico !== null ? item.fisico - item.stock : null;
              const contado = item.fisico !== null;
              return (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                    dif !== null && dif !== 0 ? "border-red-300 bg-red-50/50 dark:bg-red-950/20"
                    : contado ? "border-green-300 bg-green-50/50 dark:bg-green-950/20"
                    : "border-foreground/10"
                  }`}
                >
                  {/* Clase ABC */}
                  <span className={`text-[10px] font-black w-5 h-5 rounded flex items-center justify-center shrink-0 ${claseColor(item.clase)}`}>
                    {item.clase}
                  </span>

                  {/* Nombre y datos */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.nombre}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Cód: {item.codigo} · Costo {item.costoUnit.toFixed(2)} Bs
                    </p>
                  </div>

                  {/* Stock sistema */}
                  <div className="text-center shrink-0 w-14">
                    <p className="text-sm font-bold">{item.stock}</p>
                    <p className="text-[9px] uppercase text-muted-foreground">Sistema</p>
                  </div>

                  {/* Input físico */}
                  <div className="shrink-0 w-20">
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={item.fisico ?? ""}
                      onChange={(e) => setFisico(item.id, e.target.value)}
                      placeholder="Físico"
                      className={`h-9 text-center text-sm font-bold ${
                        dif !== null && dif !== 0 ? "border-red-400" : contado ? "border-green-400" : ""
                      }`}
                    />
                  </div>

                  {/* Diferencia */}
                  <div className="text-center shrink-0 w-12">
                    {dif !== null ? (
                      dif === 0 ? (
                        <Check className="h-4 w-4 text-green-600 mx-auto" />
                      ) : (
                        <span className={`text-sm font-black ${dif < 0 ? "text-red-600" : "text-blue-600"}`}>
                          {dif > 0 ? "+" : ""}{dif}
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Aviso de diferencias al final */}
          {stats.conDiferencia > 0 && (
            <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-lg p-3 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span className="text-amber-800 dark:text-amber-300">
                Hay <strong>{stats.conDiferencia}</strong> producto(s) con diferencia entre el stock del sistema y el físico.
                Revisa antes de guardar. El valor de la diferencia es <strong>{stats.valorDiferencias.toFixed(2)} Bs</strong>.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
