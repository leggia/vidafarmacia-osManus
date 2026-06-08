import { useState, useCallback, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Loader2,
  Trash2,
  Search,
  Plus,
  Save,
  ArrowLeft,
  Sparkles,
  Check,
  CheckCircle2,
  Calendar,
  Camera,
  Image as ImageIcon,
} from "lucide-react";
import { useLocation } from "wouter";
import ImageCropper from "@/components/ImageCropper";
import { toast } from "sonner";

interface ExtractedItem {
  productName: string;
  nombreFacturaOriginal?: string; // Nombre original que extrajo el LLM (para confirmaciones)
  quantity: number;
  unitCost: number;
  subtotal: number;
  expiryDate?: string | null;
  precioVentaSistema?: number | null; // precio_uno del sistema, para evaluar margen
  nuevoPrecioVenta?: number | null; // precio de venta editable (si se quiere actualizar)
  articuloId?: number | null; // id del producto del sistema (para historial)
  analisisCosto?: {
    esNuevo: boolean;
    costoAnterior: number | null;
    costoMinimo: number | null;
    subioRespectoAnterior: boolean;
    porcentajeSubida: number | null;
    vecesComprado: number;
  } | null;
}

interface ProductoNoEncontrado {
  nombre: string;
  nombreLimpio?: string;
  cantidad: number;
  precio?: number;
  busqueda?: string;
  sugerencia?: {
    id: number;
    nombre: string;
    codigo: string;
    score: number;
  };
}

// Margen de venta = (precioVenta - costo) / precioVenta * 100
// Devuelve null si no hay datos suficientes
function calcularMargen(costo: number, precioVenta: number | null | undefined): number | null {
  if (!precioVenta || precioVenta <= 0 || !costo || costo <= 0) return null;
  return ((precioVenta - costo) / precioVenta) * 100;
}

// Precio de venta sugerido para alcanzar un margen objetivo
function precioParaMargen(costo: number, margenObjetivo = 0.20): number {
  // precioVenta = costo / (1 - margen)
  return Math.round((costo / (1 - margenObjetivo)) * 100) / 100;
}

const MARGEN_MINIMO = 20; // % mínimo aceptable

// Detecta si el dispositivo es móvil
const esMobil = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// Comprime una imagen grande (foto de celular) antes de subir.
// Las fotos de celular pesan 3-8MB; comprimir acelera subida y procesamiento.
async function comprimirImagen(file: File, maxLado = 1600, calidad = 0.8): Promise<File> {
  // Solo comprimir imágenes (no PDF)
  if (!file.type.startsWith("image/")) return file;
  // Si ya es pequeña, no comprimir
  if (file.size < 800 * 1024) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      // Redimensionar manteniendo proporción
      if (width > maxLado || height > maxLado) {
        if (width > height) {
          height = Math.round((height * maxLado) / width);
          width = maxLado;
        } else {
          width = Math.round((width * maxLado) / height);
          height = maxLado;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) { resolve(file); return; }
          // Si la compresión no ayudó, usar el original
          if (blob.size >= file.size) { resolve(file); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
        },
        "image/jpeg",
        calidad
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// Convierte fecha MM/YYYY o DD/MM/YYYY a formato YYYY-MM-DD para input date
function convertExpiryDate(date: string | null | undefined): string | null {
  if (!date) return null;
  // Formato MM/YYYY → último día del mes YYYY-MM-DD
  const mmYYYY = date.match(/^(\d{1,2})\/(\d{4})$/);
  if (mmYYYY) {
    const mes = mmYYYY[1].padStart(2, "0");
    const anio = mmYYYY[2];
    const ultimoDia = new Date(Number(anio), Number(mes), 0).getDate();
    return `${anio}-${mes}-${ultimoDia}`;
  }
  // Formato YYYY/MM/DD → YYYY-MM-DD
  const yyyyMMDD = date.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (yyyyMMDD) {
    return `${yyyyMMDD[1]}-${yyyyMMDD[2].padStart(2, "0")}-${yyyyMMDD[3].padStart(2, "0")}`;
  }
  // Formato DD/MM/YYYY → YYYY-MM-DD
  const ddMMYYYY = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddMMYYYY) {
    return `${ddMMYYYY[3]}-${ddMMYYYY[2].padStart(2, "0")}-${ddMMYYYY[1].padStart(2, "0")}`;
  }
  return date;
}

export default function NuevaCompra() {
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { data: branchesData } = trpc.branches.list.useQuery();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cropUrl, setCropUrl] = useState<string | null>(null); // imagen pendiente de recortar
  const [branchId, setBranchId] = useState<string>("");
  const [receiptNumber, setReceiptNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [supplierOriginal, setSupplierOriginal] = useState(""); // nombre extraído por el LLM (clave de aprendizaje)
  const [descuentoGlobal, setDescuentoGlobal] = useState(0);
  const [descuentoGlobalPct, setDescuentoGlobalPct] = useState(0);
  const [totalFacturaReal, setTotalFacturaReal] = useState(0);
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [extracted, setExtracted] = useState(false);
  const [compraGuardada, setCompraGuardada] = useState(false); // ya se registró o guardó como borrador
  const [borradorGuardadoId, setBorradorGuardadoId] = useState<number | null>(null);
  const [showExpiry, setShowExpiry] = useState(false);
  const [receiptType, setReceiptType] = useState<"BOLETA" | "FACTURA">("FACTURA");
  const [almacenNombre, setAlmacenNombre] = useState("ALMACEN PRINCIPAL");
  const [productosNoEncontrados, setProductosNoEncontrados] = useState<ProductoNoEncontrado[]>([]);
  const [productosEmparejados, setProductosEmparejados] = useState<Record<string, string>>({});
  const [busquedaProducto, setBusquedaProducto] = useState<Record<number, string>>({});
  const [resultadosBusqueda, setResultadosBusqueda] = useState<Record<number, any[]>>({});
  const [buscando, setBuscando] = useState<Record<number, boolean>>({});
  const [filaEmparejando, setFilaEmparejando] = useState<number | null>(null);
  const [filaCreando, setFilaCreando] = useState<number | null>(null);
  const [sinFiltroProveedor, setSinFiltroProveedor] = useState<Record<number, boolean>>({});
  const [mostrarProveedores, setMostrarProveedores] = useState(false);
  const [proveedoresEncontrados, setProveedoresEncontrados] = useState<any[]>([]);
  const [buscandoProveedor, setBuscandoProveedor] = useState(false);
  const [proveedorConfirmado, setProveedorConfirmado] = useState<{ id: number; nombre: string } | null>(null);
  const [nuevoProducto, setNuevoProducto] = useState<{ nombre: string; precioVenta: number; idcategoria: number | null; categoriaNombre: string }>({ nombre: "", precioVenta: 0, idcategoria: null, categoriaNombre: "" });
  const [creandoProducto, setCreandoProducto] = useState(false);

  const utils = trpc.useUtils();

  // Protección contra cierre/recarga accidental cuando hay trabajo sin registrar.
  // Se mantiene activa hasta que la compra se REGISTRE definitivamente (no solo borrador).
  const hayTrabajoSinGuardar = extracted && items.length > 0 && !compraGuardada;
  useEffect(() => {
    if (!hayTrabajoSinGuardar) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // requerido por algunos navegadores para mostrar el diálogo
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hayTrabajoSinGuardar]);

  // Cargar un borrador existente si la URL trae ?borrador=ID
  const [borradorCargado, setBorradorCargado] = useState(false);
  useEffect(() => {
    if (borradorCargado) return;
    const params = new URLSearchParams(window.location.search);
    const borradorId = params.get("borrador");
    if (!borradorId) return;
    setBorradorCargado(true);
    (async () => {
      try {
        const compra: any = await utils.client.purchases.getById.query({ id: parseInt(borradorId) });
        if (!compra) { toast.error("No se encontró el borrador"); return; }
        const p = compra.purchase ?? compra;
        const its = compra.items ?? [];
        if (p.supplier) { setSupplier(p.supplier); setSupplierOriginal(p.supplier); }
        if (p.receiptNumber) setReceiptNumber(p.receiptNumber);
        if (p.almacenNombre) setAlmacenNombre(p.almacenNombre);
        if (its.length > 0) {
          setItems(its.map((it: any) => ({
            productName: it.productName,
            nombreFacturaOriginal: it.productName,
            quantity: it.quantity,
            unitCost: parseFloat(String(it.unitCost)) || 0,
            subtotal: parseFloat(String(it.subtotal)) || 0,
            expiryDate: it.expiryDate || null,
          })));
          setShowExpiry(its.some((it: any) => it.expiryDate));
          setExtracted(true);
          setBorradorGuardadoId(parseInt(borradorId));
          toast.success("Borrador cargado. Continúa donde lo dejaste.");
        }
      } catch (e: any) {
        toast.error("Error cargando el borrador: " + (e.message || ""));
      }
    })();
  }, [borradorCargado, utils]);

  // Auto-buscar cuando aparecen productos no encontrados
  const buscarProducto = async (idx: number, term: string, proveedorNombre: string, idProveedor?: number) => {
    if (!term || term.length < 3) return;
    setBuscando(prev => ({ ...prev, [idx]: true }));
    try {
      const resultados = await utils.confirmaciones.buscarArticulo.fetch({
        termino: term,
        nombreProveedor: proveedorNombre,
        idProveedor: idProveedor && idProveedor > 0 ? idProveedor : undefined,
      });
      setResultadosBusqueda(prev => ({ ...prev, [idx]: Array.isArray(resultados) ? resultados : [] }));
    } catch (e) {
      console.error("Error buscando:", e);
    }
    setBuscando(prev => ({ ...prev, [idx]: false }));
  };

  const uploadAndExtract = trpc.purchases.uploadAndExtract.useMutation();
  const createPurchase = trpc.purchases.create.useMutation();
  const confirmarEmparejamiento = trpc.confirmaciones.confirmar.useMutation();
  const crearProductoMut = trpc.confirmaciones.crearProducto.useMutation();
  const buscarArticuloQuery = trpc.confirmaciones.buscarArticulo.useQuery;

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (!selected) return;

      const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/heic', 'image/heif'];
      if (!validTypes.includes(selected.type) && !selected.type.startsWith("image/")) {
        toast.error('Solo imágenes (JPG, PNG) o PDF');
        return;
      }

      const maxSize = 25 * 1024 * 1024; // 25MB antes de comprimir (fotos de celular)
      if (selected.size > maxSize) {
        toast.error('Archivo muy grande (máx 25MB)');
        return;
      }

      // Si es imagen, abrir el recortador primero (omitir dedos, bordes oscuros)
      if (selected.type.startsWith("image/")) {
        const url = URL.createObjectURL(selected);
        setCropUrl(url);
        return;
      }

      // PDF u otros: procesar directo
      setFile(selected);
      setExtracted(false);
      setItems([]);
      const url = URL.createObjectURL(selected);
      setPreviewUrl(url);
    },
    []
  );

  // Tras recortar: comprimir y dejar listo para extraer
  const procesarImagenFinal = useCallback(async (imgFile: File) => {
    let archivoFinal = imgFile;
    try {
      const original = imgFile.size;
      archivoFinal = await comprimirImagen(imgFile);
      if (archivoFinal.size < original) {
        console.log(`[Imagen] Comprimida: ${Math.round(original/1024)}KB → ${Math.round(archivoFinal.size/1024)}KB`);
      }
    } catch {
      archivoFinal = imgFile;
    }
    setFile(archivoFinal);
    setExtracted(false);
    setItems([]);
    const url = URL.createObjectURL(archivoFinal);
    setPreviewUrl(url);
  }, []);

  const handleExtract = useCallback(async () => {
    if (!file) return;
    setIsExtracting(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(",")[1];
          const result = await uploadAndExtract.mutateAsync({
            fileBase64: base64,
            fileName: file.name,
            mimeType: file.type,
          });
          if (result.items && result.items.length > 0) {
            const descGlobal = result.descuentoGlobal || 0;
            const sumaSubtotales = result.items.reduce((s: number, i: any) => s + (i.subtotal || 0), 0);
            // Factor de descuento global (ej: 0.05 = 5%). Se aplica a cada costo unitario.
            const factorDesc = (descGlobal > 0 && sumaSubtotales > 0) ? (descGlobal / sumaSubtotales) : 0;
            const mappedItems = result.items.map((i: any) => {
              const costoBase = i.unitCost || 0;
              // Distribuir el descuento global: bajar el costo unitario proporcionalmente
              const costoConDesc = factorDesc > 0 ? Math.round(costoBase * (1 - factorDesc) * 10000) / 10000 : costoBase;
              const subtotalConDesc = factorDesc > 0 ? Math.round((i.subtotal || 0) * (1 - factorDesc) * 100) / 100 : (i.subtotal || 0);
              return {
                ...i,
                unitCost: costoConDesc,
                costoSinDescuento: costoBase, // referencia
                subtotal: subtotalConDesc,
                nombreFacturaOriginal: i.productName,
                expiryDate: convertExpiryDate(i.expiryDate) || null,
              };
            });
        setItems(mappedItems);
        if (mappedItems.some((i: any) => i.expiryDate)) {
          setShowExpiry(true);
        }
            if (result.supplier) {
              setSupplier(result.supplier);
              setSupplierOriginal(result.supplier);
              // Buscar si ya aprendimos este proveedor antes
              try {
                const provConf = await utils.confirmaciones.buscarProveedorConfirmado.fetch({ nombreFactura: result.supplier });
                if (provConf) {
                  setSupplier(provConf.nombre);
                  setProveedorConfirmado({ id: parseInt(provConf.id) || 0, nombre: provConf.nombre });
                }
              } catch {}
            }
            if (result.receiptNumber) setReceiptNumber(result.receiptNumber);
            setDescuentoGlobal(descGlobal);
            setDescuentoGlobalPct(factorDesc > 0 ? Math.round(factorDesc * 1000) / 10 : 0);
            setTotalFacturaReal(result.totalFactura || 0);
            setExtracted(true);
            toast.success(`Se extrajeron ${result.items.length} productos de la imagen`);
            // Pre-buscar SOLO confirmaciones guardadas (match seguro, no por similitud)
            const provNombre = result.supplier || "";
            for (let i = 0; i < result.items.length; i++) {
              const nombre = result.items[i].productName;
              try {
                const conf = await utils.confirmaciones.buscarConfirmacion.fetch({
                  proveedor: provNombre,
                  nombreFactura: nombre,
                });
                if (conf && conf.nombreSistema) {
                  setProductosEmparejados(prev => ({ ...prev, [conf.nombreSistema]: nombre }));
                  // Traer el precio de venta del sistema para evaluar margen
                  let pv: number | null = null;
                  try {
                    const arts = await utils.confirmaciones.buscarArticulo.fetch({
                      termino: conf.nombreSistema,
                      nombreProveedor: provNombre,
                    });
                    const exacto = Array.isArray(arts) ? arts.find((a: any) => a.id === conf.id) || arts[0] : null;
                    if (exacto) pv = parseFloat(String(exacto.precio_uno ?? 0)) || null;
                  } catch {}
                  // Analizar el costo vs historial de compras
                  let analisis: any = null;
                  try {
                    analisis = await utils.confirmaciones.analizarPrecio.fetch({
                      articuloId: conf.id,
                      costoActual: result.items[i].unitCost || 0,
                    });
                  } catch {}
                  setItems(prev => prev.map((item, idx) =>
                    idx === i ? {
                      ...item,
                      productName: conf.nombreSistema,
                      precioVentaSistema: pv,
                      articuloId: conf.id,
                      analisisCosto: analisis && !analisis.esNuevo ? {
                        esNuevo: false,
                        costoAnterior: analisis.costoAnterior,
                        costoMinimo: analisis.costoMinimo,
                        subioRespectoAnterior: analisis.subioRespectoAnterior,
                        porcentajeSubida: analisis.porcentajeSubida,
                        vecesComprado: analisis.vecesComprado,
                      } : null,
                    } : item
                  ));
                }
              } catch {}
            }
          } else {
            toast.error("No se pudieron extraer productos de la imagen");
          }
        } catch (err: any) {
          toast.error(err.message || "Error al procesar la imagen");
        }
        setIsExtracting(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      toast.error(err.message || "Error al procesar la imagen");
      setIsExtracting(false);
    }
  }, [file, uploadAndExtract]);

  // Autoguardado silencioso de borrador (tras emparejar proveedor, o como respaldo).
  // No navega ni interrumpe; solo asegura que el trabajo no se pierda.
  const autoguardarBorrador = useCallback(async () => {
    if (!branchId || items.length === 0) return;
    try {
      const totalAmount = items.reduce((sum, i) => sum + i.subtotal, 0);
      const result: any = await createPurchase.mutateAsync({
        branchId: parseInt(branchId),
        receiptNumber, receiptType, supplier, almacenNombre, totalAmount,
        items: items.map(i => ({
          productName: i.productName, quantity: i.quantity, unitCost: i.unitCost,
          subtotal: i.subtotal, expiryDate: i.expiryDate || null,
          nuevoPrecioVenta: (i.nuevoPrecioVenta != null && i.nuevoPrecioVenta !== i.precioVentaSistema) ? i.nuevoPrecioVenta : null,
        })),
        imageUrl: uploadAndExtract.data?.imageUrl || null,
        imageKey: uploadAndExtract.data?.imageKey || null,
        confirmDirectly: false,
      });
      if (result?.id) setBorradorGuardadoId(result.id);
      setCompraGuardada(true); // ya hay respaldo; quita la alerta de cierre
      toast.success("Borrador guardado automáticamente", { duration: 2500 });
    } catch (e) {
      // Silencioso: si falla el autoguardado, no interrumpir al usuario
      console.error("Error en autoguardado:", e);
    }
  }, [branchId, items, descuentoGlobal, receiptNumber, receiptType, supplier, almacenNombre, borradorGuardadoId, createPurchase, uploadAndExtract]);

  // Navegación protegida: si hay trabajo sin registrar, confirma y autoguarda borrador
  const salirProtegido = useCallback(async () => {
    if (hayTrabajoSinGuardar) {
      const ok = window.confirm(
        "Tienes una compra sin terminar.\n\n" +
        "Si sales ahora sin registrarla, se guardará como BORRADOR para que puedas retomarla después.\n\n" +
        "¿Salir de todas formas?"
      );
      if (!ok) return;
      // Guardar como borrador antes de salir
      await autoguardarBorrador();
    }
    setLocation("/compras");
  }, [hayTrabajoSinGuardar, autoguardarBorrador, setLocation]);

  const handleSubmit = useCallback(
    async (confirmDirectly: boolean) => {
      if (!branchId) {
        toast.error("Seleccione una sucursal");
        return;
      }
      if (items.length === 0) {
        toast.error("Agregue al menos un producto");
        return;
      }
      // Solo al confirmar (sincronizar): exigir que todos estén emparejados
      if (confirmDirectly) {
        const sinEmparejar = items.filter(it => productosEmparejados[it.productName] === undefined);
        if (sinEmparejar.length > 0) {
          toast.error(`No se puede registrar: ${sinEmparejar.length} producto(s) sin emparejar. Empareja todos antes de confirmar la compra completa.`, { duration: 6000 });
          return;
        }
      }
      setIsSubmitting(true);
      try {
        const totalAmount = items.reduce((sum, i) => sum + i.subtotal, 0);
        const result = await createPurchase.mutateAsync({
          branchId: parseInt(branchId),
          receiptNumber,
          receiptType,
          supplier,
          almacenNombre,
          totalAmount,
          items: items.map(i => ({
            productName: i.productName,
            quantity: i.quantity,
            unitCost: i.unitCost,
            subtotal: i.subtotal,
            expiryDate: i.expiryDate || null,
            nuevoPrecioVenta: (i.nuevoPrecioVenta != null && i.nuevoPrecioVenta !== i.precioVentaSistema) ? i.nuevoPrecioVenta : null,
          })),
          imageUrl: uploadAndExtract.data?.imageUrl || null,
          imageKey: uploadAndExtract.data?.imageKey || null,
          confirmDirectly,
          borradorIdEliminar: confirmDirectly ? borradorGuardadoId : null,
        });
        setCompraGuardada(true); // registrada o guardada: quitar protección de cierre
        if (confirmDirectly) {
          const r = result as any;
          if (r?.syncSuccess) {
            toast.success(
              `✓ Compra registrada en inventarios365.com` +
              (r.syncIngresoId ? ` (Ingreso ID: ${r.syncIngresoId})` : ""),
              { duration: 7000 }
            );
            // Actualizar emparejamientos si vienen en la respuesta
            if (r.productosEmparejados?.length > 0) {
              const mapa: Record<string, string> = {};
              for (const p of r.productosEmparejados) {
                // Key = nombre en sistema (lo que muestra la tabla)
                // Value = nombre original factura (para tooltip)
                mapa[p.nombreSistema] = p.nombreFactura;
              }
              setProductosEmparejados(mapa);
              // Actualizar items con nombres del sistema
              setItems(prev => prev.map(item => {
                const emp = r.productosEmparejados.find((p: any) => p.nombreFactura === item.productName);
                return emp ? { ...item, productName: emp.nombreSistema } : item;
              }));
            }
            if (r.productosNoEncontrados?.length > 0) {
              setProductosNoEncontrados(r.productosNoEncontrados);
              toast.warning(`${r.productosNoEncontrados.length} producto(s) no encontrados — revisa el panel`, { duration: 8000 });
              r.productosNoEncontrados.forEach((p: any, idx: number) => {
                const primeraPalabra = (p.nombreLimpio || p.nombre.replace(/^\d+\s+/, "")).split(" ")[0];
                buscarProducto(idx, primeraPalabra, supplier || "");
              });
              setIsSubmitting(false);
              return;
            }
            // Todo OK — redirigir inmediatamente
            setIsSubmitting(false);
            // Invalidar cache en background sin bloquear
            utils.purchases.list.invalidate().catch(() => {});
            utils.dashboard.stats.invalidate().catch(() => {});
            setTimeout(() => setLocation("/compras"), 100);
            return;
          } else if (r?.productosNoEncontrados?.length > 0) {
            setProductosNoEncontrados(r.productosNoEncontrados);
            if (!r?.syncSuccess) {
              toast.warning(`⚠️ ${r.syncMessage}`, { duration: 8000 });
            }
            setIsSubmitting(false);
            return;
          } else if (r?.syncMessage) {
            toast.warning(
              `Compra confirmada, pero sin sincronizar: ${r.syncMessage}`,
              { duration: 8000 }
            );
          } else {
            toast.success("Compra confirmada exitosamente");
          }
        } else {
          toast.success("Compra guardada como borrador");
        }
        setLocation("/compras");
      } catch (err: any) {
        toast.error(err.message || "Error al registrar la compra");
      }
      setIsSubmitting(false);
    },
    [branchId, items, receiptNumber, receiptType, supplier, almacenNombre, createPurchase, setLocation, uploadAndExtract.data, utils, productosEmparejados]
  );

  const updateItem = (index: number, field: keyof ExtractedItem, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === "quantity" || field === "unitCost") {
        updated[index].subtotal = updated[index].quantity * updated[index].unitCost;
      }
      return updated;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  // Un producto está emparejado si su nombre actual existe como clave en productosEmparejados
  // (productosEmparejados mapea nombreSistema → nombreFactura)
  const itemEmparejado = (item: ExtractedItem) =>
    productosEmparejados[item.productName] !== undefined;
  const todosEmparejados = items.length > 0 && items.every(itemEmparejado);
  const cantidadSinEmparejar = items.filter(it => !itemEmparejado(it)).length;

  const addEmptyItem = () => {
    setItems((prev) => [
      ...prev,
      { productName: "", quantity: 1, unitCost: 0, subtotal: 0, expiryDate: null },
    ]);
  };

  const totalAmount = items.reduce((sum, i) => sum + i.subtotal, 0);

  return (
    <div className="space-y-6">
      {/* Recortador de imagen (móvil) */}
      {cropUrl && (
        <ImageCropper
          imageUrl={cropUrl}
          onConfirm={(cropped) => {
            URL.revokeObjectURL(cropUrl);
            setCropUrl(null);
            procesarImagenFinal(cropped);
          }}
          onCancel={() => {
            // Si cancela el recorte, usar la imagen original sin recortar
            fetch(cropUrl)
              .then((r) => r.blob())
              .then((b) => {
                procesarImagenFinal(new File([b], "factura.jpg", { type: b.type || "image/jpeg" }));
              })
              .finally(() => {
                URL.revokeObjectURL(cropUrl);
                setCropUrl(null);
              });
          }}
        />
      )}
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-foreground pb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={salirProtegido}
          className="gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">
            Nueva Compra
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Suba una foto o PDF de la factura para extracción automática
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Upload & Preview */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Imagen de Factura
              </CardTitle>
            </CardHeader>
            <CardContent>
              {previewUrl ? (
                <div className="space-y-3">
                  <div className="border border-foreground/10 rounded overflow-hidden">
                    <img
                      src={previewUrl}
                      alt="Factura"
                      className="w-full h-auto max-h-80 object-contain bg-muted"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleExtract}
                      disabled={isExtracting || extracted}
                      className="flex-1 gap-2 font-semibold uppercase tracking-wider text-xs"
                    >
                      {isExtracting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : extracted ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      {isExtracting ? "Extrayendo..." : extracted ? "Extraído" : "Extraer con IA"}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        setFile(null);
                        setPreviewUrl(null);
                        setExtracted(false);
                        setItems([]);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Botón de cámara (prominente, ideal en móvil) */}
                  <button
                    onClick={() => cameraInputRef.current?.click()}
                    className="w-full border-2 border-dashed border-primary/40 bg-primary/5 rounded-lg p-6 text-center cursor-pointer hover:border-primary hover:bg-primary/10 transition-colors active:scale-[0.99]"
                  >
                    <Camera className="h-10 w-10 mx-auto text-primary mb-2" />
                    <p className="text-sm font-semibold text-primary">Tomar foto de la factura</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {esMobil ? "Abre la cámara de tu celular" : "Usa la cámara del dispositivo"}
                    </p>
                  </button>

                  {/* Separador */}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="flex-1 h-px bg-foreground/10" />
                    <span>o</span>
                    <div className="flex-1 h-px bg-foreground/10" />
                  </div>

                  {/* Botón de subir archivo (galería / PDF) */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full border border-foreground/20 rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors active:scale-[0.99] flex items-center justify-center gap-2"
                  >
                    <ImageIcon className="h-5 w-5 text-muted-foreground" />
                    <div className="text-left">
                      <p className="text-sm font-medium">Subir desde galería o PDF</p>
                      <p className="text-xs text-muted-foreground">JPG, PNG o PDF</p>
                    </div>
                  </button>
                </div>
              )}
              {/* Input de cámara: capture abre la cámara trasera directo en móvil */}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileSelect}
                className="hidden"
              />
              {/* Input de archivo: galería o PDF */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                onChange={handleFileSelect}
                className="hidden"
              />
            </CardContent>
          </Card>

          {/* Purchase Info */}
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Datos de Compra
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Sucursal</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar sucursal" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesData?.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Tipo de Comprobante</Label>
                <Select value={receiptType} onValueChange={(v: any) => setReceiptType(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FACTURA">FACTURA</SelectItem>
                    <SelectItem value="BOLETA">BOLETA</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Almacén</Label>
                <Select value={almacenNombre} onValueChange={setAlmacenNombre}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALMACEN PRINCIPAL">ALMACEN PRINCIPAL</SelectItem>
                    <SelectItem value="Almacen Lanza">Almacen Lanza</SelectItem>
                    <SelectItem value="Almacen Petrolera">Almacen Petrolera</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">N° Comprobante</Label>
                <Input
                  value={receiptNumber}
                  onChange={(e) => setReceiptNumber(e.target.value)}
                  placeholder="Ej: 36324"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Proveedor</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      value={supplier}
                      onChange={(e) => setSupplier(e.target.value)}
                      placeholder="Ej: Bago"
                      className={proveedorConfirmado ? "border-green-500 bg-green-50 dark:bg-green-950 pr-7" : ""}
                    />
                    {proveedorConfirmado && (
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500 text-sm font-bold">✓</span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0 border-blue-300 text-blue-600 dark:border-blue-700"
                    title="Buscar proveedor en el sistema"
                    onClick={async () => {
                      if (mostrarProveedores) { setMostrarProveedores(false); return; }
                      setMostrarProveedores(true);
                      setBuscandoProveedor(true);
                      try {
                        const provs = await utils.confirmaciones.listarProveedores.fetch({ filtro: supplier || "" });
                        setProveedoresEncontrados(Array.isArray(provs) ? provs : []);
                      } catch {
                        setProveedoresEncontrados([]);
                      }
                      setBuscandoProveedor(false);
                    }}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>

                {/* Panel de selección de proveedor */}
                {mostrarProveedores && (
                  <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-md p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={supplier}
                        onChange={(e) => setSupplier(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Enter") {
                            setBuscandoProveedor(true);
                            try {
                              const provs = await utils.confirmaciones.listarProveedores.fetch({ filtro: supplier || "" });
                              setProveedoresEncontrados(Array.isArray(provs) ? provs : []);
                            } catch { setProveedoresEncontrados([]); }
                            setBuscandoProveedor(false);
                          }
                        }}
                        placeholder="Buscar proveedor..."
                        className="text-sm h-8 flex-1"
                      />
                      <Button
                        size="sm"
                        className="h-8 bg-blue-600 hover:bg-blue-700 text-white px-3"
                        disabled={buscandoProveedor}
                        onClick={async () => {
                          setBuscandoProveedor(true);
                          try {
                            const provs = await utils.confirmaciones.listarProveedores.fetch({ filtro: supplier || "" });
                            setProveedoresEncontrados(Array.isArray(provs) ? provs : []);
                          } catch { setProveedoresEncontrados([]); }
                          setBuscandoProveedor(false);
                        }}
                      >
                        {buscandoProveedor ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {proveedoresEncontrados.length === 0 && !buscandoProveedor && (
                        <p className="text-xs text-muted-foreground py-1">Sin resultados. Escribe y busca el proveedor.</p>
                      )}
                      {proveedoresEncontrados.map((prov: any) => (
                        <div key={prov.id} className="flex items-center justify-between bg-white dark:bg-gray-900 rounded px-2 py-1.5 border border-gray-200 dark:border-gray-700">
                          <p className="text-xs font-medium truncate flex-1">{prov.nombre}</p>
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white ml-2"
                            onClick={async () => {
                              const nombreOrig = supplierOriginal || supplier;
                              setSupplier(prov.nombre);
                              setProveedorConfirmado({ id: prov.id, nombre: prov.nombre });
                              setMostrarProveedores(false);
                              toast.success(`Proveedor: ${prov.nombre}. Se recordará.`);
                              // Aprender el emparejamiento para futuras facturas
                              try {
                                await utils.client.confirmaciones.confirmarProveedor.mutate({
                                  nombreFactura: nombreOrig,
                                  proveedorId: String(prov.id),
                                  proveedorNombre: prov.nombre,
                                });
                              } catch {}
                              // Autoguardar borrador: ya emparejado el proveedor, proteger el trabajo
                              autoguardarBorrador();
                            }}
                          >
                            Usar
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Items Table */}
        <div className="lg:col-span-2">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-wider">
                  Productos ({items.length})
                </CardTitle>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowExpiry(!showExpiry)}
                    className={`gap-1 text-xs uppercase tracking-wider font-semibold ${showExpiry ? "bg-primary text-primary-foreground" : ""}`}
                  >
                    <Calendar className="h-3 w-3" />
                    {showExpiry ? "Ocultar Venc." : "Fecha Venc."}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addEmptyItem}
                    className="gap-1 text-xs uppercase tracking-wider font-semibold"
                  >
                    <Plus className="h-3 w-3" />
                    Agregar
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {items.length > 0 ? (
                <div className="space-y-2">
                  {/* Table Header (scroll horizontal solo aquí en móvil) */}
                  <div className="overflow-x-auto -mx-2 px-2">
                  <div className={`min-w-[560px] grid gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground pb-2 border-b border-foreground/10 ${showExpiry ? "grid-cols-13" : "grid-cols-12"}`}>
                    <div className={showExpiry ? "col-span-4" : "col-span-5"}>Producto</div>
                    <div className="col-span-2">Cantidad</div>
                    <div className="col-span-2">Costo Unit.</div>
                    {showExpiry && <div className="col-span-3">Vencimiento</div>}
                    <div className="col-span-1 text-right">Subtotal</div>
                    <div className="col-span-2" />
                  </div>
                  </div>
                  {/* Items */}
                  {items.map((item, idx) => (
                    <div key={idx}>
                    <div className="overflow-x-auto -mx-2 px-2">
                    <div
                      className={`min-w-[560px] grid gap-2 items-center py-1 ${showExpiry ? "grid-cols-13" : "grid-cols-12"}`}
                    >
                      <div className={showExpiry ? "col-span-4" : "col-span-5"}>
                        <div className="relative">
                          <Input
                            value={item.productName}
                            onChange={(e) => updateItem(idx, "productName", e.target.value)}
                            className={`text-sm h-9 ${productosEmparejados[item.productName] !== undefined ? "border-green-500 bg-green-50 dark:bg-green-950 pr-7" : ""}`}
                            placeholder="Nombre del producto"
                            title={productosEmparejados[item.productName] ? `Factura original: ${productosEmparejados[item.productName]}` : ""}
                          />
                          {productosEmparejados[item.productName] !== undefined && (
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500 text-sm font-bold">✓</span>
                          )}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, "quantity", parseInt(e.target.value) || 0)}
                          className="text-sm h-9"
                          min={0}
                        />
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          value={item.unitCost}
                          onChange={(e) => updateItem(idx, "unitCost", parseFloat(e.target.value) || 0)}
                          className="text-sm h-9"
                          min={0}
                          step="0.01"
                        />
                      </div>
                      {showExpiry && (
                        <div className="col-span-3">
                          <Input
                            type="date"
                            value={item.expiryDate || ""}
                            onChange={(e) => updateItem(idx, "expiryDate", e.target.value || null)}
                            className="text-sm h-9"
                          />
                        </div>
                      )}
                      <div className="col-span-1 text-right text-sm font-semibold whitespace-nowrap">
                        {item.subtotal.toFixed(2)}
                      </div>
                      <div className="col-span-2 flex justify-end items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className={`h-8 w-8 shrink-0 border ${filaEmparejando === idx ? "bg-blue-600 text-white border-blue-600" : "border-blue-300 text-blue-600 dark:border-blue-700"}`}
                          title="Emparejar con producto del sistema"
                          onClick={() => {
                            if (filaEmparejando === idx) {
                              setFilaEmparejando(null);
                            } else {
                              setFilaEmparejando(idx);
                              const term = (item.productName || "").split(" ")[0];
                              setBusquedaProducto(prev => ({ ...prev, [idx]: term }));
                              buscarProducto(idx, term, supplier || "");
                            }
                          }}
                        >
                          <Search className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground"
                          onClick={() => removeItem(idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    </div>

                    {/* Alerta de costo elevado vs historial */}
                    {item.analisisCosto && !item.analisisCosto.esNuevo && (() => {
                      const a = item.analisisCosto!;
                      const subio = a.subioRespectoAnterior && (a.porcentajeSubida ?? 0) >= 5;
                      return (
                        <div className={`text-[11px] rounded px-2 py-1.5 mb-1 mt-1 ${subio ? "bg-orange-50 dark:bg-orange-950/40 border border-orange-300 dark:border-orange-800 text-orange-800 dark:text-orange-300" : "bg-muted/40 border border-foreground/10 text-muted-foreground"}`}>
                          {subio ? (
                            <span>📈 <strong>El costo subió {a.porcentajeSubida}%</strong> vs la compra anterior ({a.costoAnterior?.toFixed(2)} → {item.unitCost.toFixed(2)} Bs). Considera revisar el precio de venta.</span>
                          ) : (
                            <span>📊 Comprado {a.vecesComprado} {a.vecesComprado === 1 ? "vez" : "veces"} · Mínimo histórico: <strong>{a.costoMinimo?.toFixed(2)} Bs</strong> · Anterior: {a.costoAnterior?.toFixed(2)} Bs</span>
                          )}
                        </div>
                      );
                    })()}

                    {/* Margen de venta + precio editable */}
                    {item.precioVentaSistema != null && (() => {
                      const precioActual = item.nuevoPrecioVenta ?? item.precioVentaSistema ?? 0;
                      const margen = calcularMargen(item.unitCost, precioActual);
                      const sugerido = precioParaMargen(item.unitCost, 0.20);
                      const bajo = margen !== null && margen < MARGEN_MINIMO;
                      const modificado = item.nuevoPrecioVenta != null && item.nuevoPrecioVenta !== item.precioVentaSistema;
                      return (
                        <div className={`text-[11px] rounded px-2 py-2 mb-1 mt-1 ${bajo ? "bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800" : "bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800"}`}>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">Precio venta:</span>
                              <Input
                                type="number"
                                step="0.01"
                                value={precioActual}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value) || 0;
                                  setItems(prev => prev.map((it, i) => i === idx ? { ...it, nuevoPrecioVenta: v } : it));
                                }}
                                className={`h-7 w-24 text-xs ${bajo ? "border-red-400" : ""}`}
                              />
                              <span className="text-muted-foreground">Bs</span>
                              {modificado && (
                                <span className="text-[10px] text-amber-600 dark:text-amber-400">(se actualizará)</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={bajo ? "text-red-700 dark:text-red-300 font-medium" : "text-green-700 dark:text-green-400 font-medium"}>
                                {bajo ? "⚠️" : "✓"} Margen: {margen !== null ? `${margen.toFixed(1)}%` : "—"}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-1.5 text-[10px] text-muted-foreground">
                            <span>Costo factura: {item.unitCost.toFixed(2)} Bs · Sistema: {item.precioVentaSistema.toFixed(2)} Bs</span>
                            <button
                              type="button"
                              className="text-blue-600 dark:text-blue-400 hover:underline"
                              onClick={() => setItems(prev => prev.map((it, i) => i === idx ? { ...it, nuevoPrecioVenta: sugerido } : it))}
                              title="Usar el precio sugerido como punto de partida (editable)"
                            >
                              💡 Sugerido 20%: {sugerido.toFixed(2)} Bs
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Panel inline de emparejamiento */}
                    {filaEmparejando === idx && (
                      <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-md p-3 mb-2 mt-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <Input
                            value={busquedaProducto[idx] ?? ""}
                            onChange={(e) => setBusquedaProducto(prev => ({ ...prev, [idx]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") buscarProducto(idx, busquedaProducto[idx] || "", sinFiltroProveedor[idx] ? "" : (supplier || ""), sinFiltroProveedor[idx] ? undefined : (proveedorConfirmado?.id));
                            }}
                            placeholder="Buscar producto (ej: fluconazol)..."
                            className="text-sm h-9 flex-1"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            className="h-9 text-xs whitespace-nowrap bg-blue-600 hover:bg-blue-700 text-white px-3"
                            disabled={buscando[idx]}
                            onClick={() => buscarProducto(idx, busquedaProducto[idx] || "", sinFiltroProveedor[idx] ? "" : (supplier || ""), sinFiltroProveedor[idx] ? undefined : (proveedorConfirmado?.id))}
                          >
                            {buscando[idx] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                          </Button>
                        </div>

                        {/* Toggle de filtro por proveedor */}
                        {supplier && (
                          <div className="flex items-center justify-between gap-2 bg-white dark:bg-gray-900 rounded px-2 py-1.5 border border-blue-200 dark:border-blue-800">
                            <span className="text-[11px] text-muted-foreground">
                              {sinFiltroProveedor[idx]
                                ? "🔓 Buscando en TODO el inventario"
                                : <>🔒 Filtrando por: <strong>{supplier}</strong></>}
                            </span>
                            <button
                              type="button"
                              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-medium whitespace-nowrap"
                              onClick={() => {
                                const nuevo = !sinFiltroProveedor[idx];
                                setSinFiltroProveedor(prev => ({ ...prev, [idx]: nuevo }));
                                // Re-buscar con el nuevo filtro
                                buscarProducto(idx, busquedaProducto[idx] || "", nuevo ? "" : (supplier || ""), nuevo ? undefined : (proveedorConfirmado?.id));
                              }}
                            >
                              {sinFiltroProveedor[idx] ? "Filtrar por proveedor" : "Quitar filtro"}
                            </button>
                          </div>
                        )}
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {(resultadosBusqueda[idx] || []).length === 0 && !buscando[idx] && (
                            <p className="text-xs text-muted-foreground py-2">
                              {busquedaProducto[idx]
                                ? "Sin resultados. Prueba otro término o quita el filtro de proveedor."
                                : "Escribe el nombre del producto y busca."}
                            </p>
                          )}
                          {(resultadosBusqueda[idx] || []).map((art: any) => (
                            <div
                              key={art.id}
                              className="flex items-center justify-between bg-white dark:bg-gray-900 rounded px-2 py-1.5 border border-gray-200 dark:border-gray-700"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium truncate">{art.nombre}</p>
                                <p className="text-[11px] text-muted-foreground">Código: {art.codigo}</p>
                              </div>
                              <Button
                                size="sm"
                                className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white ml-2 whitespace-nowrap"
                                onClick={async () => {
                                  const nombreFactura = item.nombreFacturaOriginal || productosEmparejados[item.productName] || item.productName;
                                  await confirmarEmparejamiento.mutateAsync({
                                    proveedor: supplier || "Desconocido",
                                    nombreFactura: nombreFactura,
                                    articuloId: art.id,
                                    articuloNombre: art.nombre,
                                    articuloCodigo: art.codigo,
                                  });
                                  setProductosEmparejados(prev => {
                                    const n = { ...prev };
                                    delete n[item.productName];
                                    n[art.nombre] = nombreFactura;
                                    return n;
                                  });
                                  updateItem(idx, "productName", art.nombre);
                                  // Guardar el precio de venta del sistema para evaluar margen
                                  const pv = parseFloat(String(art.precio_uno ?? 0)) || null;
                                  // Analizar costo vs historial
                                  let analisis: any = null;
                                  try {
                                    analisis = await utils.confirmaciones.analizarPrecio.fetch({
                                      articuloId: art.id,
                                      costoActual: item.unitCost || 0,
                                    });
                                  } catch {}
                                  setItems(prev => prev.map((it, i) => i === idx ? {
                                    ...it,
                                    precioVentaSistema: pv,
                                    articuloId: art.id,
                                    analisisCosto: analisis && !analisis.esNuevo ? {
                                      esNuevo: false,
                                      costoAnterior: analisis.costoAnterior,
                                      costoMinimo: analisis.costoMinimo,
                                      subioRespectoAnterior: analisis.subioRespectoAnterior,
                                      porcentajeSubida: analisis.porcentajeSubida,
                                      vecesComprado: analisis.vecesComprado,
                                    } : null,
                                  } : it));
                                  toast.success(`✅ Emparejado con "${art.nombre}". Se recordará siempre.`, { duration: 5000 });
                                  setFilaEmparejando(null);
                                  setResultadosBusqueda(prev => { const n = { ...prev }; delete n[idx]; return n; });
                                }}
                              >
                                Usar este
                              </Button>
                            </div>
                          ))}
                        </div>

                        {/* Crear producto nuevo si no se encuentra */}
                        {filaCreando !== idx ? (
                          <button
                            className="w-full mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline py-1.5 border-t border-blue-200 dark:border-blue-800"
                            onClick={async () => {
                              const costo = item.unitCost || 0;
                              const precioSugerido = precioParaMargen(costo, 0.20);
                              setNuevoProducto({ nombre: item.productName, precioVenta: precioSugerido, idcategoria: null, categoriaNombre: "Sugiriendo..." });
                              setFilaCreando(idx);
                              // Pedir categoría sugerida por IA
                              try {
                                const sug = await utils.confirmaciones.sugerirCategoria.fetch({ nombreProducto: item.productName });
                                setNuevoProducto(prev => ({ ...prev, idcategoria: sug.idcategoria, categoriaNombre: sug.nombre || "Sin categoría" }));
                              } catch {
                                setNuevoProducto(prev => ({ ...prev, categoriaNombre: "Error al sugerir" }));
                              }
                            }}
                          >
                            ➕ No existe — Crear producto nuevo
                          </button>
                        ) : (
                          <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-800 space-y-2">
                            <div>
                              <label className="text-[11px] text-muted-foreground">Nombre del producto (editable)</label>
                              <Input
                                value={nuevoProducto.nombre}
                                onChange={(e) => setNuevoProducto(prev => ({ ...prev, nombre: e.target.value }))}
                                className="h-8 text-xs font-medium"
                                placeholder="Nombre del producto"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[11px] text-muted-foreground">Costo unitario</label>
                                <Input value={item.unitCost.toFixed(2)} disabled className="h-8 text-xs" />
                              </div>
                              <div>
                                <label className="text-[11px] text-muted-foreground">Precio venta (margen 20%)</label>
                                <Input
                                  type="number"
                                  value={nuevoProducto.precioVenta}
                                  onChange={(e) => setNuevoProducto(prev => ({ ...prev, precioVenta: parseFloat(e.target.value) || 0 }))}
                                  className="h-8 text-xs"
                                  step="0.01"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground">Categoría sugerida</label>
                              <p className="text-xs font-medium bg-white dark:bg-gray-900 rounded px-2 py-1.5 border border-gray-200 dark:border-gray-700">
                                {nuevoProducto.categoriaNombre}
                                {nuevoProducto.idcategoria && <span className="text-muted-foreground"> (ID: {nuevoProducto.idcategoria})</span>}
                              </p>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white flex-1"
                                disabled={creandoProducto || !nuevoProducto.idcategoria}
                                onClick={async () => {
                                  if (!nuevoProducto.idcategoria) { toast.error("Esperando categoría sugerida..."); return; }
                                  if (!nuevoProducto.nombre.trim()) { toast.error("El nombre no puede estar vacío"); return; }
                                  setCreandoProducto(true);
                                  try {
                                    const nombreFinal = nuevoProducto.nombre.trim();
                                    const res = await crearProductoMut.mutateAsync({
                                      nombre: nombreFinal,
                                      costoUnitario: item.unitCost,
                                      precioVenta: nuevoProducto.precioVenta,
                                      idcategoria: nuevoProducto.idcategoria,
                                      nombreProveedor: supplier || undefined,
                                      stockMinimo: 10,
                                    });
                                    if (res.success) {
                                      // Auto-emparejar el producto recién creado consigo mismo
                                      const nombreFactura = item.nombreFacturaOriginal || item.productName;
                                      await confirmarEmparejamiento.mutateAsync({
                                        proveedor: supplier || "Desconocido",
                                        nombreFactura,
                                        articuloId: res.id || 0,
                                        articuloNombre: nombreFinal,
                                        articuloCodigo: "",
                                      });
                                      // Actualizar el nombre del item al nombre final del producto
                                      updateItem(idx, "productName", nombreFinal);
                                      setProductosEmparejados(prev => ({ ...prev, [nombreFinal]: nombreFactura }));
                                      toast.success(`✅ Producto "${nombreFinal}" creado y emparejado.`, { duration: 5000 });
                                      setFilaCreando(null);
                                      setFilaEmparejando(null);
                                    } else {
                                      toast.error(`No se pudo crear: ${res.message}`);
                                    }
                                  } catch (e: any) {
                                    toast.error(`Error: ${e.message}`);
                                  }
                                  setCreandoProducto(false);
                                }}
                              >
                                {creandoProducto ? <Loader2 className="h-3 w-3 animate-spin" /> : "Crear y emparejar"}
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setFilaCreando(null)}>
                                Cancelar
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    </div>
                  ))}
                  {/* Total */}
                  <div className="border-t-2 border-foreground pt-3 mt-3 space-y-1">
                    {descuentoGlobal > 0 && (
                      <div className="flex justify-between items-center text-xs text-orange-600">
                        <span>Descuento global aplicado ({descuentoGlobalPct}%)</span>
                        <span>− {descuentoGlobal.toFixed(2)} BS distribuido en productos</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-bold uppercase tracking-wider">Total {descuentoGlobal > 0 ? "a pagar" : ""}</span>
                      <span className="text-2xl font-black">{totalAmount.toFixed(2)} BS</span>
                    </div>
                    {totalFacturaReal > 0 && Math.abs(totalAmount - totalFacturaReal) > 1 && (
                      <p className="text-xs text-red-600 text-right">
                        ⚠️ No cuadra con el total de la factura ({totalFacturaReal.toFixed(2)} BS). Revisa precios o descuentos.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-foreground/20 rounded">
                  <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Suba una imagen y use la IA para extraer los productos
                    automáticamente, o agregue productos manualmente.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Submit Buttons */}
          {items.length > 0 && (
            <div className="flex justify-end gap-3 mt-4">
              <Button
                variant="outline"
                onClick={salirProtegido}
                className="uppercase tracking-wider text-xs font-semibold"
              >
                Cancelar
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSubmit(false)}
                disabled={isSubmitting}
                className="gap-2 uppercase tracking-wider text-xs font-semibold"
                title="Guarda la compra como borrador. Los emparejamientos que ya hiciste quedan guardados."
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Guardar Borrador
              </Button>
              <Button
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting || !todosEmparejados}
                title={!todosEmparejados ? `Faltan ${cantidadSinEmparejar} producto(s) por emparejar` : ""}
                className="gap-2 uppercase tracking-wider text-xs font-semibold bg-green-700 hover:bg-green-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Confirmar y Sincronizar
              </Button>
            </div>
          )}
          {extracted && !todosEmparejados && (
            <p className="text-xs text-amber-600 dark:text-amber-400 text-right mt-2">
              ⚠️ Faltan {cantidadSinEmparejar} producto(s) por emparejar. Usa la lupa 🔍 en cada fila para emparejarlos con el sistema antes de registrar la compra completa.
            </p>
          )}
          {extracted && items.length > 6 && (
            <p className="text-xs text-muted-foreground text-right mt-1">
              💡 Factura larga: cada emparejamiento que haces se guarda al instante. Si recargas o vuelves a subir esta factura, recordará lo ya emparejado.
            </p>
          )}
        </div>
      </div>

      {/* Panel de Productos No Encontrados */}
      {productosNoEncontrados.length > 0 && (
        <div className="border border-yellow-400 rounded-lg bg-yellow-50 dark:bg-yellow-950 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 text-sm uppercase tracking-wider">
              ⚠️ {productosNoEncontrados.length} Producto(s) No Encontrados en el Sistema
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setProductosNoEncontrados([])} className="text-yellow-700 hover:text-yellow-900 text-xs">
              Cerrar
            </Button>
          </div>
          <p className="text-xs text-yellow-700 dark:text-yellow-300">
            Búscalos para emparejar con el sistema (se recordará para siempre) o créalos como nuevos productos.
          </p>
          {productosNoEncontrados.length === 0 && (
            <div className="bg-green-50 dark:bg-green-950 border border-green-300 rounded p-3 flex items-center justify-between">
              <p className="text-sm text-green-700 font-medium">✅ Todos los productos emparejados</p>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white text-xs"
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting}
              >
                {isSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : "🚀 Registrar compra ahora"}
              </Button>
            </div>
          )}
          <div className="space-y-4">
            {productosNoEncontrados.map((p, idx) => (
              <div key={idx} className="bg-white dark:bg-gray-900 rounded-lg p-3 border border-yellow-200 space-y-3">
                {/* Datos del producto en la factura */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm">📄 {p.nombreLimpio || p.nombre.replace(/^\d+\s+/, "")}</p>
                    {p.nombreLimpio && p.nombreLimpio !== p.nombre && (
                      <p className="text-xs text-muted-foreground">Código factura: {p.nombre.match(/^\d+/)?.[0]}</p>
                    )}
                    <p className="text-xs text-muted-foreground">Cant: {p.cantidad}{p.precio ? ` | Precio unit: Bs. ${p.precio}` : ""}</p>
                  </div>
                  <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">No encontrado</span>
                </div>

                {/* Sugerencia del sistema */}
                {p.sugerencia && (
                  <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 rounded p-2 space-y-1">
                    <p className="text-xs text-blue-700 dark:text-blue-300 font-medium">
                      💡 Sugerencia ({Math.round(p.sugerencia.score * 100)}% similitud):
                    </p>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-medium">{p.sugerencia.nombre}</p>
                        <p className="text-xs text-muted-foreground">Código: {p.sugerencia.codigo}</p>
                      </div>
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                        onClick={async () => {
                          await confirmarEmparejamiento.mutateAsync({
                            proveedor: supplier || "Desconocido",
                            nombreFactura: p.nombre,
                            articuloId: p.sugerencia!.id,
                            articuloNombre: p.sugerencia!.nombre,
                            articuloCodigo: p.sugerencia!.codigo,
                          });
                          // Actualizar mapa de emparejamientos y nombre en tabla
                          setProductosEmparejados(prev => ({ ...prev, [p.nombre]: p.sugerencia!.nombre }));
                          setItems(prev => prev.map(item =>
                            item.productName === p.nombre
                              ? { ...item, productName: p.sugerencia!.nombre }
                              : item
                          ));
                          toast.success(`✅ Confirmado: "${p.nombre}" → "${p.sugerencia!.nombre}"`, { duration: 5000 });
                          setProductosNoEncontrados(prev => prev.filter((_, i) => i !== idx));
                        }}
                      >
                        ✅ Confirmar
                      </Button>
                    </div>
                  </div>
                )}

                {/* Búsqueda */}
                <div className="flex gap-2">
                  <Input
                    placeholder="Buscar producto (ej: fluconazol sanat)..."
                    className="h-8 text-xs"
                    value={busquedaProducto[idx] ?? (p.nombreLimpio || p.nombre.replace(/^\d+\s+/, "")).split(" ")[0]}
                    onChange={(e) => setBusquedaProducto(prev => ({ ...prev, [idx]: e.target.value }))}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter") {
                        const term = busquedaProducto[idx] || p.nombre;
                        await buscarProducto(idx, term, supplier || "");
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs whitespace-nowrap"
                    disabled={buscando[idx]}
                    onClick={async () => {
                      const term = busquedaProducto[idx] || p.nombre;
                      await buscarProducto(idx, term, supplier || "");
                    }}
                  >
                    {buscando[idx] ? <Loader2 className="h-3 w-3 animate-spin" /> : "🔍 Buscar"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 text-xs whitespace-nowrap bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={() => window.open("https://vidafarmacia.inventarios365.com/main", "_blank")}
                  >
                    ➕ Crear nuevo
                  </Button>
                </div>

                {/* Resultados de búsqueda */}
                {resultadosBusqueda[idx]?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium">Selecciona el producto correcto:</p>
                    {resultadosBusqueda[idx].map((art: any) => (
                      <div key={art.id} className="flex items-center justify-between bg-green-50 dark:bg-green-950 border border-green-200 rounded px-3 py-2">
                        <div>
                          <p className="text-xs font-medium">{art.nombre}</p>
                          <p className="text-xs text-muted-foreground">Código: {art.codigo} | ID: {art.id}</p>
                        </div>
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
                          onClick={async () => {
                            await confirmarEmparejamiento.mutateAsync({
                              proveedor: supplier || "Desconocido",
                              nombreFactura: p.nombre,
                              articuloId: art.id,
                              articuloNombre: art.nombre,
                              articuloCodigo: art.codigo,
                            });
                            // Actualizar mapa y nombre en tabla
                            setProductosEmparejados(prev => ({ ...prev, [p.nombre]: art.nombre }));
                            setItems(prev => prev.map(item =>
                              item.productName === p.nombre
                                ? { ...item, productName: art.nombre }
                                : item
                            ));
                            toast.success(`✅ Emparejado: "${p.nombre}" → "${art.nombre}". Se recordará siempre.`, { duration: 6000 });
                            setProductosNoEncontrados(prev => prev.filter((_, i) => i !== idx));
                            setResultadosBusqueda(prev => { const n = {...prev}; delete n[idx]; return n; });
                          }}
                        >
                          ✅ Confirmar
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {resultadosBusqueda[idx]?.length === 0 && busquedaProducto[idx] && !buscando[idx] && (
                  <p className="text-xs text-red-500">No se encontraron resultados. Intenta otro término o crea el producto.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
