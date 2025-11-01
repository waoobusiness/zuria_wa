// src/cars/resolver.ts
import type { FastifyInstance, FastifyPluginOptions } from "fastify";

type Depth = "summary" | "full";
type Locale = "fr" | "de" | "it" | "en";

const BASE = "https://www.autoscout24.ch";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

const RE_DEALER_URL = /^https?:\/\/(?:www\.)?autoscout24\.ch\/(fr|de|it)\/s\/seller-(\d+)\/?/i;
const RE_VEHICLE_URL = /^https?:\/\/(?:www\.)?autoscout24\.ch\/(fr|de|it)\/d\/.+-(\d+)\/?/i;

type Dealer = {
  id: string;
  name?: string | null;
  profile_url: string;
  rating?: number | null;
  reviews_count?: number | null;
  address?: string | null;
  default_lang?: string | null;
};

type VehicleDetails = {
  power_ps?: number | null;
  power_kw?: number | null;
  drivetrain?: string | null;
  body_type?: string | null;
  engine_displacement_cm3?: number | null;
  cylinders?: number | null;
  gears?: number | null;
  catalog_price_chf?: number | null;
  co2_g_km?: number | null;
  consumption_l_100km?: number | null;
  efficiency_label?: string | null;
  colors?: { exterior?: string; interior?: string } | null;
  doors?: number | null;
  seats?: number | null;
  wagon_number?: string | null;
  import_parallel?: boolean | null;
  accident?: boolean | null;
  warranty?: string | null;
  ct_expertisee?: boolean | null;
  equipment_optional?: string[] | null;
  equipment_standard?: string[] | null;
  finance_texts?: string[] | null;
  description?: string | null;
  media?: string[] | null;
};

type VehicleItem = {
  id?: string | null;
  url: string;
  brand?: string | null;
  model?: string | null;
  title?: string | null;
  price_chf?: number | null;
  year_month_reg?: string | null;
  mileage_km?: number | null;
  fuel?: string | null;
  transmission?: string | null;
  thumbnail?: string | null;
  details?: VehicleDetails | null;
};

type ConnectOut = {
  platform: "autoscout24_ch";
  source_type: "vehicle" | "dealer";
  dealer: Dealer;
  inventory: { total: number; items: VehicleItem[] };
};

// ---------- helpers ----------
const abs = (href: string) =>
  href.startsWith("http") ? href : new URL(href, BASE).toString();

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } as any });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return await res.text();
}

function extractText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findDealerLinkInVehicle(html: string): string | undefined {
  // <a href="/fr|de|it/s/seller-XXXXX">
  const re = /href="\/(fr|de|it)\/s\/seller-(\d+)"/gi;
  const m = re.exec(html);
  return m ? abs(`/${m[1]}/s/seller-${m[2]}`) : undefined;
}

function extractListingLinks(html: string): Array<{ url: string; label?: string }> {
  // <a data-testid="listing-card-*" href="/fr/d/..." aria-label="...">
  const out: Array<{ url: string; label?: string }> = [];
  const re = /<a[^>]+data-testid="listing-card-[^"]+"[^>]*href="([^"]+)"[^>]*?(?:aria-label="([^"]*)")?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/\/(fr|de|it)\/d\//i.test(href)) {
      out.push({ url: abs(href), label: m[2] });
    }
  }
  return out;
}

function extractTextFacts(text: string) {
  const o: any = {};
  const ym = text.match(/(\d{2})\.(\d{4})/);
  if (ym) o.year_month_reg = `${ym[2]}-${ym[1]}`;
  const km = text.match(/(\d{1,3}[’'\s]?\d{3})\s*km/i);
  if (km) o.mileage_km = parseInt(km[1].replace(/[^0-9]/g, ""), 10);
  if (/Automatique|Automatik|Automatic/i.test(text)) o.transmission = "Automatique";
  if (/Manuelle|Schaltgetriebe|Manual/i.test(text)) o.transmission = "Manuelle";
  const chf = text.match(/CHF\s*([0-9’'\s]+)/i);
  if (chf) o.price_chf = parseInt(chf[1].replace(/[^0-9]/g, ""), 10);
  const fuels = ["Essence","Diesel","Hybride","Électrique","Benzin","Hybrid","Elektrisch","Elektro"];
  for (const f of fuels) if (text.includes(f)) { o.fuel = f; break; }
  const ps = text.match(/(\d+)\s*PS\s*\((\d+)\s*kW\)/i);
  if (ps) { o.power_ps = parseInt(ps[1], 10); o.power_kw = parseInt(ps[2], 10); }
  const eff = text.match(/\b([A-G])\b\s*(Étiquette|Energie|Effizienz|energy)/i);
  if (eff) o.efficiency_label = eff[1];
  return o;
}

function brandModelFromUrl(url: string) {
  const m = /\/d\/([^-\/]+)-([a-z0-9\-]+)/i.exec(url);
  if (!m) return {};
  const cap = (s?: string) =>
    s ? s.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : s;
  return { brand: cap(m[1]?.replace(/-/g," ")), model: cap(m[2]?.replace(/-/g," ")) };
}

async function parseVehiclePage(url: string) {
  const html = await fetchHtml(url);
  const text = extractText(html);
  const dealerUrl = findDealerLinkInVehicle(html);
  if (!dealerUrl) throw new Error("Dealer link not found on vehicle page");

  const id = (RE_VEHICLE_URL.exec(url)?.[2]) || null;
  const h1m = /<h1[^>]*>(.*?)<\/h1>/i.exec(html);
  const title = h1m ? h1m[1].replace(/<[^>]+>/g, "").trim() : undefined;

  const facts = extractTextFacts(text);
  const { brand, model } = brandModelFromUrl(url);

  const pics: string[] = [];
  const reImg = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let mi: RegExpExecArray | null;
  while ((mi = reImg.exec(html))) {
    const src = mi[1];
    if (/(autoscout24|cloudfront|cdn)/i.test(src)) pics.push(src);
  }

  const item: VehicleItem = {
    id, url, title,
    brand: facts.brand || brand,
    model: facts.model || model,
    price_chf: facts.price_chf ?? undefined,
    year_month_reg: facts.year_month_reg ?? undefined,
    mileage_km: facts.mileage_km ?? undefined,
    fuel: facts.fuel ?? undefined,
    transmission: facts.transmission ?? undefined,
    thumbnail: pics[0],
    details: null
  };

  return { dealerUrl, item, text, html };
}

function buildDetailsFrom(text: string, html: string, includeMedia: boolean): VehicleDetails {
  const kv = (label: string) => {
    const r = new RegExp(label + "\\s*([\\w’'°/\\.\\-\\s\\(\\)]+)", "i");
    const m = r.exec(text);
    return m ? m[1].trim() : undefined;
  };
  const toInt = (s?: string) => (s && /\d/.test(s) ? parseInt(s.replace(/[^0-9]/g, ""), 10) : undefined);

  const d: VehicleDetails = {};
  const ps = text.match(/(\d+)\s*PS\s*\((\d+)\s*kW\)/i);
  if (ps) { d.power_ps = parseInt(ps[1], 10); d.power_kw = parseInt(ps[2], 10); }
  const cons = text.match(/(\d+[.,]?\d*)\s*l\/100\s*km/i);
  if (cons) d.consumption_l_100km = parseFloat(cons[1].replace(",", "."));
  const co2 = text.match(/(\d+)\s*g\/km/i);
  if (co2) d.co2_g_km = parseInt(co2[1], 10);
  const eff = text.match(/\b([A-G])\b\s*(Étiquette|Energie|Effizienz|energy)/i);
  if (eff) d.efficiency_label = eff[1];

  d.engine_displacement_cm3 = toInt(kv("Cylindrée") || kv("Hubraum"));
  d.cylinders = toInt(kv("Cylindres") || kv("Zylinder"));
  d.gears = toInt(kv("Vitesses") || kv("Gänge"));
  d.catalog_price_chf = toInt(kv("Prix catalogue") || kv("Listenpreis"));
  d.doors = toInt(kv("Portes") || kv("Türen"));
  d.seats = toInt(kv("Sièges") || kv("Sitzplätze"));
  if (/4x4|4 roues motrices|Allrad/i.test(text)) d.drivetrain = "4x4";
  if (/SUV|Tout-terrain/i.test(text)) d.body_type = "SUV / Tout-terrain";

  const ext = /Extérieure\s+([A-Za-zÀ-ÿ\s\-]+)/i.exec(text)?.[1]?.trim();
  const int = /Intérieure\s+([A-Za-zÀ-ÿ\s\-]+)/i.exec(text)?.[1]?.trim();
  if (ext || int) d.colors = { exterior: ext, interior: int };

  d.wagon_number = /N° de wagon\s+([A-Za-z0-9\-]+)/i.exec(text)?.[1] || undefined;

  const yesNo = (lab: string) => {
    const v = kv(lab)?.toLowerCase();
    if (!v) return undefined;
    if (["oui", "ja", "yes"].includes(v)) return true;
    if (["non", "nein", "no"].includes(v)) return false;
    return undefined;
  };
  d.import_parallel = yesNo("Importation directe/parallèle") ?? undefined;
  d.accident = yesNo("Véhicule accidenté") ?? undefined;
  d.ct_expertisee = yesNo("Expertisée") ?? undefined;
  d.warranty = kv("Garantie") ?? undefined;

  const finance = text.match(
    /(Ab\s+[0-9’'\.\s\-]+CHF\s+pro\s+Monat[^\n]*)|(À\s+partir\s+de\s+CHF\s*[0-9’'\.\s]+[^\n]*par\s+mois[^\n]*)/gi
  );
  d.finance_texts = finance ? [...new Set(finance.map(x => x.trim()))] : null;

  if (includeMedia) {
    const imgs: string[] = [];
    const reImg = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = reImg.exec(html))) {
      const src = m[1];
      if (/(autoscout24|cloudfront|cdn)/i.test(src)) imgs.push(src);
    }
    d.media = imgs.length ? imgs : null;
  }

  const paras = text.split(/(?<=\.)\s+/).filter(s => s.length > 60);
  d.description = paras.sort((a,b) => b.length - a.length)[0] || null;

  return d;
}

async function parseDealerPage(url: string): Promise<Dealer> {
  const html = await fetchHtml(url);
  const text = extractText(html);

  const name = /<h1[^>]*>(.*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g,"").trim() || null;
  const rate = /(\d\.\d)\s*\((\d+)\)/.exec(text);
  const rating = rate ? parseFloat(rate[1]) : null;
  const reviews = rate ? parseInt(rate[2], 10) : null;
  const addr = text.match(/\b\d{4}\s+[A-Za-zÀ-ÿ\-]+/);
  const address = addr ? addr[0] : null;
  const m = RE_DEALER_URL.exec(url);

  return {
    id: m ? `seller-${m[2]}` : url,
    name,
    profile_url: url,
    rating,
    reviews_count: reviews,
    address,
    default_lang: "fr",
  };
}

async function paginateInventory(dealerUrl: string, maxPages = 80) {
  const items: Array<{url:string; label?:string}> = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? dealerUrl : `${dealerUrl}?page=${page}`;
    const html = await fetchHtml(url);
    const found = extractListingLinks(html).filter(x => !seen.has(x.url));
    if (!found.length) break;
    found.forEach(x => seen.add(x.url));
    items.push(...found);
  }
  return items;
}

async function summarize(url: string, label?: string): Promise<VehicleItem> {
  try {
    const r = await parseVehiclePage(url);
    return r.item;
  } catch {
    const id = RE_VEHICLE_URL.exec(url)?.[2] || null;
    return { id, url, title: label };
  }
}

async function scrapeFull(url: string, includeMedia: boolean): Promise<VehicleItem> {
  const { item, text, html } = await parseVehiclePage(url);
  const details = buildDetailsFrom(text, html, includeMedia);
  if (!item.thumbnail && details.media?.length) item.thumbnail = details.media[0]!;
  item.details = details;
  return item;
}

export default async function resolverPlugin(app: FastifyInstance, _opts: FastifyPluginOptions) {
  app.get("/connect/health", async () => ({ ok: true, scope: "cars", version: "1.0.0" }));

  app.post<{ Body: { url: string; depth?: Depth; include_media?: boolean; locale?: Locale } }>(
    "/connect",
    async (req, reply) => {
      const { url, depth = "full", include_media = true } = req.body || {};
      if (!url || (!RE_VEHICLE_URL.test(url) && !RE_DEALER_URL.test(url))) {
        return reply.status(400).send({ detail: "URL invalide: fournir un lien AutoScout24 (fiche véhicule ou page vendeur)." });
      }
      try {
        let dealerUrl: string;
        let source_type: "vehicle" | "dealer" = "dealer";

        if (RE_VEHICLE_URL.test(url)) {
          const v = await parseVehiclePage(url);
          dealerUrl = v.dealerUrl;
          source_type = "vehicle";
        } else {
          dealerUrl = url;
          source_type = "dealer";
        }

        const dealer = await parseDealerPage(dealerUrl);
        const cards = await paginateInventory(dealerUrl);

        // pool (5 en //) pour limiter la charge
        const pool = async <T>(arr: Array<any>, fn: (x:any)=>Promise<T>, size=5) => {
          const out: T[] = [];
          for (let i=0; i<arr.length; i+=size) {
            const part = await Promise.all(arr.slice(i, i+size).map(x => fn(x)));
            out.push(...part);
          }
          return out;
        };

        const items = await pool(
          cards,
          ({ url, label }) => (depth === "full" ? scrapeFull(url, include_media) : summarize(url, label)),
          5
        );

        const payload: ConnectOut = {
          platform: "autoscout24_ch",
          source_type,
          dealer,
          inventory: { total: items.length, items },
        };

        return reply.send(payload);
      } catch (e: any) {
        return reply.status(500).send({ detail: String(e?.message || e) });
      }
    }
  );
}
