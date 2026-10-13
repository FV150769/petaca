// Edge Function "atajo": Petaca desde los Atajos del iPhone (y Siri), sin abrir la app. Se publica sin verificación de JWT
// porque el Atajo no tiene sesión; por eso cada camino se cuida solo:
// - Desde el panel, con la sesión iniciada: {accion:"crear"} arma una clave nueva para el Atajo (la anterior deja de andar) y
//   la devuelve una sola vez; {accion:"quitar"} la borra; {accion:"estado"} dice si hay una y cuándo se usó.
// - Desde el Atajo, con la clave en el encabezado "Clave": {accion:"gasto", monto, categoria?, detalle?, medio?},
//   {accion:"ingreso", monto, medio?, ahorro?}, {accion:"nota", texto}, {accion:"queda"}, {accion:"agenda"} y
//   {accion:"categorias"}. Contesta en texto, así el Atajo lo muestra y Siri lo lee en voz alta.
// Lo que se carga va a una bandeja (atajo_bandeja): la página lo suma al abrirse. Escribir directo en panel_state podría pisar
// lo que el celular cargó sin conexión. "¿Cuánto me queda?" y la agenda salen del resumen que la página guarda al sincronizar
// (data.res), más lo que todavía está en la bandeja.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
// Al Atajo se le contesta en texto: lo que se muestra (o lee Siri) es la respuesta entera, sin pasos de más.
function texto(t: string, status = 200) {
  return new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function b64u(a: Uint8Array) {
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function huella(clave: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clave)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Día de hoy en Argentina (UTC-3, sin horario de verano)
function hoyAR(dias = 0) {
  return new Date(Date.now() - 3 * 3600e3 + dias * 864e5).toISOString().slice(0, 10);
}
const sinTildes = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function plata(n: number) {
  return (n < 0 ? "−" : "") + "$" + Math.round(Math.abs(n)).toLocaleString("es-AR");
}
// Montos como los dice o escribe la gente: 8000, "8.000", "8,000", "8 mil", "8,5 mil", "1,5 palos", "$ 12.500,50".
// Igual que en la página: un punto o una coma seguido de 3 cifras separa los miles.
function monto(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : NaN;
  let s = sinTildes(String(v ?? "")).replace(/\$|ars|pesos?/g, "").trim();
  let x = 1;
  if (/\b(palos?|millon(es)?|m)\b/.test(s)) x = 1e6;
  else if (/\b(mil|k|lucas?)\b/.test(s)) x = 1e3;
  s = s.replace(/[a-z]+/g, "").replace(/\s+/g, "");
  s = s.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n * x : NaN;
}
function medio(v: unknown) {
  return /efect|cash|billete|mano/.test(sinTildes(String(v ?? ""))) ? "e" : "t";
}
function medioTxt(me: string) {
  return me === "e" ? "efectivo" : "transferencia";
}

async function usuario(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  return data?.user ?? null;
}

// Pedidos del panel (con la sesión iniciada)
async function panel(req: Request, body: any) {
  const u = await usuario(req);
  if (!u) return json({ error: "Iniciá sesión primero" }, 401);
  if (body.accion === "crear") {
    const clave = "pt_" + b64u(crypto.getRandomValues(new Uint8Array(24)));
    const { error } = await sb.from("atajo_claves").upsert({ user_id: u.id, hash: await huella(clave), creado: new Date().toISOString(), usado: null });
    if (error) return json({ error: "No pude crear la clave. Probá de nuevo en un rato." }, 500);
    return json({ clave });
  }
  if (body.accion === "quitar") {
    await sb.from("atajo_claves").delete().eq("user_id", u.id);
    return json({ ok: true });
  }
  if (body.accion === "estado") {
    const { data } = await sb.from("atajo_claves").select("creado,usado").eq("user_id", u.id).maybeSingle();
    return json({ vinculado: !!data, creado: data?.creado ?? null, usado: data?.usado ?? null });
  }
  return json({ error: "Pedido inválido" }, 400);
}

// Lo que todavía está en la bandeja cambia lo que te queda: los gastos restan y los ingresos suman (menos lo que se separa).
function pendientes(filas: any[], aho: number) {
  let q = 0, ef = 0;
  for (const f of filas) {
    const d = f.datos ?? {};
    if (f.tipo === "gasto") {
      q -= d.m;
      if (d.me === "e") ef -= d.m;
    } else if (f.tipo === "ingreso") {
      const neto = d.v * (1 - (d.p ?? aho) / 100);
      q += neto;
      if (d.me === "e") ef += neto;
    }
  }
  return { q, ef };
}

// "Te quedan $X en Día a día": del resumen que guardó la página, más lo que está en la bandeja.
function quedaTxt(res: any, filas: any[], aho: number, largo: boolean) {
  if (!res || typeof res.queda !== "number") return "";
  const p = pendientes(filas, aho), q = res.queda + p.q, ef = (res.ef || 0) + p.ef, cta = res.cuenta || "tu día a día";
  let t = q >= 0 ? "Te quedan " + plata(q) + " en " + cta : "Te pasaste " + plata(-q) + " en " + cta;
  if (!largo) return t + ".";
  if (ef) t += " (" + plata(q - ef) + " en transferencia y " + plata(ef) + " en efectivo)";
  t += ".";
  if (res.mes === hoyAR().slice(0, 7) && res.gastado >= 0) {
    const gp = filas.filter((f) => f.tipo === "gasto").reduce((s, f) => s + f.datos.m, 0);
    t += " Este mes gastaste " + plata(res.gastado + gp) + ".";
    const ojo = (Array.isArray(res.cats) ? res.cats : [])
      .map((c: any) => ({ c: c[0], p: Math.round((c[1] / c[2]) * 100) }))
      .filter((c: any) => c.p >= 80)
      .sort((a: any, b: any) => b.p - a.p)
      .slice(0, 3);
    if (ojo.length) t += " Ojo: " + ojo.map((c: any) => c.c + " va " + c.p + "% del presupuesto").join(", ") + ".";
  }
  const dias = Math.floor((Date.now() - (res.t || 0)) / 864e5);
  if (dias >= 2) t += " (Según lo que sincronizaste hace " + dias + " días.)";
  return t;
}

function agendaTxt(res: any) {
  const ag = res?.ag;
  if (!ag || !res.hoy) return "Todavía no tengo tu agenda: abrí Petaca una vez y después preguntame.";
  const dia = (f: string, n: string) => {
    if (f < res.hoy || f > String(res.hasta || res.hoy)) return n + ": no lo sé todavía (abrí Petaca para actualizar tu agenda).";
    const a: string[] = Array.isArray(ag[f]) ? ag[f] : [];
    if (!a.length) return n + ": nada agendado.";
    return n + ": " + a.map((x) => {
      const [h, ...r] = String(x).split("|");
      return (h ? h + " " : "") + r.join("|");
    }).join(", ") + ".";
  };
  return dia(hoyAR(), "Hoy") + " " + dia(hoyAR(1), "Mañana");
}

// Pedidos del Atajo (con la clave)
async function atajo(clave: string, body: any) {
  if (!/^pt_[A-Za-z0-9_-]{32}$/.test(clave)) return texto("La clave no es válida. En Petaca: ⚙️ Configuración → Atajos del iPhone.", 401);
  const { data: k } = await sb.from("atajo_claves").select("user_id").eq("hash", await huella(clave)).maybeSingle();
  if (!k) return texto("Esa clave ya no anda. En Petaca: ⚙️ Configuración → Atajos del iPhone → Crear clave, y pegala en el atajo.", 401);
  const uid = k.user_id;
  await sb.from("atajo_claves").update({ usado: new Date().toISOString() }).eq("user_id", uid);

  const accion = sinTildes(String(body?.accion ?? "")).trim();
  const { data: ps } = await sb.from("panel_state").select("data").eq("user_id", uid).maybeSingle();
  const d: any = ps?.data ?? {};
  const cats = Object.keys(d.cfg?.BUDGET ?? {});
  const aho = Number(d.cfg?.AHO) >= 0 ? Number(d.cfg.AHO) : 10;
  const bandeja = async () => (await sb.from("atajo_bandeja").select("tipo,datos").eq("user_id", uid)).data ?? [];

  if (accion === "categorias") return texto((cats.length ? cats : ["Otros"]).join("\n"));
  if (accion === "queda") return texto(quedaTxt(d.res, await bandeja(), aho, true) || "Todavía no sé cuánto te queda: abrí Petaca una vez y después preguntame.");
  if (accion === "agenda") return texto(agendaTxt(d.res));

  // Lo que se carga: como mucho 30 cosas cada 10 minutos y 200 esperando en la bandeja.
  if (accion !== "gasto" && accion !== "ingreso" && accion !== "nota") {
    return texto("No entendí qué querés hacer. Opciones: gasto, ingreso, nota, queda, agenda o categorias.", 400);
  }
  const { count: recientes } = await sb.from("atajo_bandeja").select("id", { count: "exact", head: true })
    .eq("user_id", uid).gt("creado", new Date(Date.now() - 10 * 60e3).toISOString());
  if ((recientes ?? 0) >= 30) return texto("Pará un poco: mandaste muchas cosas seguidas. Probá en unos minutos.", 429);
  const { count: total } = await sb.from("atajo_bandeja").select("id", { count: "exact", head: true }).eq("user_id", uid);
  if ((total ?? 0) >= 200) return texto("Tenés muchas cosas esperando: abrí Petaca para que entren y después seguí.", 429);

  const f = hoyAR();
  let tipo = accion, datos: any, ok = "";
  if (accion === "gasto") {
    const m = monto(body.monto);
    if (!(m > 0 && m < 1e10)) return texto("No entendí el monto del gasto. Probá de nuevo, por ejemplo: 8500.", 400);
    const pedida = sinTildes(String(body.categoria ?? "")).trim();
    const c = cats.find((x) => sinTildes(x) === pedida) ?? "";
    const x = String(body.detalle ?? "").trim().slice(0, 60);
    datos = { f, m: Math.round(m * 100) / 100, c, x, me: medio(body.medio) };
    ok = "Anotado ✅ Gasto de " + plata(datos.m) + (c ? " en " + c : "") + (x ? " (" + x + ")" : "") + ", " + medioTxt(datos.me) + ".";
  } else if (accion === "ingreso") {
    const v = monto(body.monto);
    if (!(v > 0 && v < 1e10)) return texto("No entendí el monto del ingreso. Probá de nuevo, por ejemplo: 250000.", 400);
    const pa = parseFloat(String(body.ahorro ?? "").replace(",", "."));
    const p = body.ahorro != null && body.ahorro !== "" && pa >= 0 && pa <= 100 ? pa : null;
    datos = { f, v: Math.round(v * 100) / 100, me: medio(body.medio), p };
    const pp = p ?? aho;
    ok = "Anotado ✅ Ingreso de " + plata(datos.v) + ", " + medioTxt(datos.me) + "." + (pp ? " Separás " + pp + "% (" + plata(datos.v * pp / 100) + ") para ahorro." : "");
  } else {
    const t = String(body.texto ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!t) return texto("No me llegó la nota. Probá de nuevo.", 400);
    datos = { f, t };
    ok = "Anotado ✅ Cuando abras Petaca te muestro cómo lo entendí para que lo confirmes.";
  }
  const { error } = await sb.from("atajo_bandeja").insert({ user_id: uid, tipo, datos });
  if (error) return texto("No pude guardarlo. Probá de nuevo en un rato.", 500);
  if (tipo === "nota") return texto(ok);
  const q = quedaTxt(d.res, await bandeja(), aho, false);
  return texto(ok + (q ? " " + q : ""));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return texto("Usá POST (en el atajo: Obtener contenido de URL → Método: POST).", 405);
  const body = await req.json().catch(() => ({}));
  const clave = (req.headers.get("clave") ?? "").trim();
  try {
    if (clave) return await atajo(clave, body);
    return await panel(req, body);
  } catch (_) {
    return clave ? texto("Algo falló de mi lado. Probá de nuevo en un rato.", 500) : json({ error: "Algo falló. Probá de nuevo en un rato." }, 500);
  }
});
