import { WorkflowEntrypoint, DurableObject } from "cloudflare:workers";

const MERCHANT_NAME = "Fressnapf-Online-Shop DE";
const MERCHANT_WEBSITE = "https://www.fressnapf.de";
const AFFILIATE_NETWORK = "Awin";
const AFFILIATE_ID = "14757";

const DOG_FOOD_RE =
  /(hundefutter|hund|dog|canine|puppy|welpe|adult|senior|junior|trockenfutter|nassfutter|hundemahlzeit|barf)/i;

function money(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const n = Number(
    String(value)
      .trim()
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(
    String(value)
      .trim()
      .replace(",", ".")
  );

  return Number.isFinite(n) ? n : null;
}

function packageInfo(name: unknown): {
  size: number | null;
  unit: string | null;
} {
  const match = String(name || "").match(
    /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i
  );

  if (!match) {
    return {
      size: null,
      unit: null
    };
  }

  let size = Number(
    match[1].replace(",", ".")
  );

  let unit = match[2].toLowerCase();

  if (unit === "g") {
    size /= 1000;
    unit = "kg";
  }

  if (unit === "ml") {
    size /= 1000;
    unit = "l";
  }

  return {
    size,
    unit
  };
}

function isDogFood(
  row: Record<string, string>
): boolean {
  const text = [
    row.merchant_category,
    row.category_name,
    row.merchant_product_category_path,
    row.merchant_product_second_category,
    row.merchant_product_third_category,
    row.product_type,
    row.product_name,
    row.keywords
  ].join(" ");

  return DOG_FOOD_RE.test(text);
}

function canonicalKey(
  row: Record<string, string>
): string {
  const ean = String(
    row.ean ||
      row.product_GTIN ||
      ""
  ).trim();

  if (ean) {
    return `ean:${ean}`;
  }

  const brand = String(
    row.brand_name || ""
  )
    .trim()
    .toLowerCase();

  const name = String(
    row.product_name || ""
  )
    .trim()
    .toLowerCase();

  return `name:${brand}|${name}`;
}

class CSVParser {
  private onRow: (
    row: Record<string, string>
  ) => Promise<void>;

  private headers: string[] | null = null;
  private row: string[] = [];
  private field = "";
  private inQuotes = false;
  private pendingQuote = false;

  constructor(
    onRow: (
      row: Record<string, string>
    ) => Promise<void>
  ) {
    this.onRow = onRow;
  }

  async push(
    text: string,
    final = false
  ): Promise<void> {
    for (
      let i = 0;
      i < text.length;
      i++
    ) {
      const c = text[i];

      if (this.pendingQuote) {
        this.pendingQuote = false;

        if (c === '"') {
          this.field += '"';
          continue;
        }

        this.inQuotes = false;
      }

      if (this.inQuotes) {
        if (c === '"') {
          this.pendingQuote = true;
        } else {
          this.field += c;
        }

        continue;
      }

      if (c === '"') {
        this.inQuotes = true;
      } else if (c === ",") {
        this.row.push(this.field);
        this.field = "";
      } else if (c === "\n") {
        this.row.push(this.field);
        this.field = "";

        await this.finishRow();
      } else if (c !== "\r") {
        this.field += c;
      }
    }

    if (final) {
      if (this.pendingQuote) {
        this.pendingQuote = false;
        this.inQuotes = false;
      }

      if (
        this.field.length ||
        this.row.length
      ) {
        this.row.push(this.field);
        this.field = "";

        await this.finishRow();
      }
    }
  }

  private async finishRow(): Promise<void> {
    if (!this.headers) {
      this.headers = this.row.map(
        (x) => x.trim()
      );

      this.row = [];
      return;
    }

    const values = this.row;

    this.row = [];

    if (!values.length) {
      return;
    }

    const result: Record<
      string,
      string
    > = {};

    for (
      let i = 0;
      i < this.headers.length;
      i++
    ) {
      result[this.headers[i]] =
        values[i] ?? "";
    }

    await this.onRow(result);
  }
}

async function getMerchant(
  env: Env
): Promise<{ id: number }> {
  const result =
    await env.DB.prepare(`
      INSERT INTO merchants
        (
          name,
          website,
          affiliate_network,
          affiliate_id
        )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name)
      DO UPDATE SET
        website = excluded.website,
        affiliate_network =
          excluded.affiliate_network,
        affiliate_id =
          excluded.affiliate_id
      RETURNING id
    `)
      .bind(
        MERCHANT_NAME,
        MERCHANT_WEBSITE,
        AFFILIATE_NETWORK,
        AFFILIATE_ID
      )
      .first<{ id: number }>();

  if (!result?.id) {
    throw new Error(
      "Fressnapf-Händler konnte nicht angelegt werden."
    );
  }

  return result;
}

async function createImport(
  env: Env,
  merchantId: number
): Promise<{ id: number }> {
  const result =
    await env.DB.prepare(`
      INSERT INTO imports
        (
          merchant_id,
          source_name,
          status
        )
      VALUES (?, ?, 'running')
      RETURNING id
    `)
      .bind(
        merchantId,
        SOURCE_NAME
      )
      .first<{ id: number }>();

  if (!result?.id) {
    throw new Error(
      "Import-Datensatz konnte nicht erstellt werden."
    );
  }

  return result;
}

const SOURCE_NAME =
  "Fressnapf Awin Feed";

async function importFeed(
  env: Env
): Promise<Record<string, unknown>> {
  if (!env.FRESSNAPF_FEED_URL) {
    throw new Error(
      "FRESSNAPF_FEED_URL fehlt."
    );
  }

  const merchant =
    await getMerchant(env);

  const importRecord =
    await createImport(
      env,
      merchant.id
    );

  let productsFound = 0;
  let productsImported = 0;
  let productsMatched = 0;

  try {
    const response = await fetch(
      env.FRESSNAPF_FEED_URL,
      {
        headers: {
          "User-Agent":
            "WAUVERO/1.0 Feed Import"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `Fressnapf Feed HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error(
        "Fressnapf Feed liefert keinen Datenstrom."
      );
    }

    let body = response.body;

    const contentEncoding =
      response.headers.get(
        "content-encoding"
      );

    const contentType =
      response.headers.get(
        "content-type"
      );

    if (
      contentEncoding?.includes("gzip") ||
      contentType?.includes("gzip") ||
      env.FRESSNAPF_FEED_URL
        .toLowerCase()
        .includes(".gz")
    ) {
      body = body.pipeThrough(
        new DecompressionStream("gzip")
      );
    }

    const reader =
      body.getReader();

    const decoder =
      new TextDecoder("utf-8");

    let batch:
      Record<string, string>[] = [];

    const flush = async () => {
      if (!batch.length) {
        return;
      }

      const rows = batch;

      batch = [];

      for (const row of rows) {
        const name = String(
          row.product_name || ""
        ).trim();

        if (!name) {
          continue;
        }

        const ean =
          String(
            row.ean ||
              row.product_GTIN ||
              ""
          ).trim() || null;

        const canonical =
          canonicalKey(row);

        const pkg =
          packageInfo(name);

        let product:
          | { id: number }
          | null = null;

        /*
         * Bestehende Daten werden zunächst
         * über EAN gesucht.
         */
        if (ean) {
          product =
            await env.DB.prepare(`
              SELECT id
              FROM products
              WHERE ean_gtin = ?
              LIMIT 1
            `)
              .bind(ean)
              .first<{ id: number }>();
        }

        /*
         * Danach über canonical_key.
         */
        if (!product) {
          product =
            await env.DB.prepare(`
              SELECT id
              FROM products
              WHERE canonical_key = ?
              LIMIT 1
            `)
              .bind(canonical)
              .first<{ id: number }>();
        }

        /*
         * Neues Produkt.
         */
        if (!product) {
          product =
            await env.DB.prepare(`
              INSERT INTO products
                (
                  canonical_key,
                  ean_gtin,
                  brand,
                  name,
                  animal_type,
                  category,
                  food_type,
                  life_stage
                )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING id
            `)
              .bind(
                canonical,
                ean,
                row.brand_name ||
                  null,
                name,
                "dog",
                row.merchant_category ||
                  null,
                row.product_type ||
                  null,
                row.life_stage ||
                  null
              )
              .first<{ id: number }>();
        }

        /*
         * Bestehendes Produkt aktualisieren.
         */
        if (product?.id) {
          await env.DB.prepare(`
            UPDATE products
            SET
              ean_gtin =
                COALESCE(?, ean_gtin),
              brand =
                COALESCE(?, brand),
              name = ?,
              category =
                COALESCE(?, category),
              food_type =
                COALESCE(?, food_type),
              life_stage =
                COALESCE(?, life_stage),
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
            .bind(
              ean,
              row.brand_name ||
                null,
              name,
              row.merchant_category ||
                null,
              row.product_type ||
                null,
              row.life_stage ||
                null,
              product.id
            )
            .run();
        }

        if (!product?.id) {
          continue;
        }

        const merchantProductId =
          String(
            row.merchant_product_id ||
              row.aw_product_id ||
              ""
          ).trim();

        if (!merchantProductId) {
          continue;
        }

        const priceCents =
          money(
            row.search_price ||
              row.display_price
          );

        if (priceCents <= 0) {
          continue;
        }

        const shippingCents =
          money(
            row.delivery_cost
          );

        const totalPriceCents =
          priceCents +
          shippingCents;

        const available =
          (
            String(row.in_stock)
              .toLowerCase() === "1" ||
            String(row.in_stock)
              .toLowerCase() === "true"
          ) &&
          String(row.is_for_sale)
            .toLowerCase() !== "0"
            ? 1
            : 0;

        /*
         * Händlerprodukt.
         */
        const existing =
          await env.DB.prepare(`
            SELECT id
            FROM merchant_products
            WHERE merchant_id = ?
              AND merchant_product_id = ?
            LIMIT 1
          `)
            .bind(
              merchant.id,
              merchantProductId
            )
            .first<{ id: number }>();

        let merchantProduct:
          | { id: number }
          | null = null;

        if (existing) {
          merchantProduct = existing;

          await env.DB.prepare(`
            UPDATE merchant_products
            SET
              product_id = ?,
              ean_gtin = COALESCE(?, ean_gtin),
              product_name = ?,
              product_url = ?,
              affiliate_url = ?,
              image_url = ?,
              currency = ?,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
            .bind(
              product.id,
              ean,
              name,
              row.merchant_deep_link ||
                null,
              row.aw_deep_link ||
                null,
              row.merchant_image_url ||
                row.large_image ||
                null,
              row.currency || "EUR",
              existing.id
            )
            .run();
        } else {
          merchantProduct =
            await env.DB.prepare(`
              INSERT INTO merchant_products
                (
                  merchant_id,
                  product_id,
                  merchant_product_id,
                  ean_gtin,
                  product_name,
                  product_url,
                  affiliate_url,
                  image_url,
                  currency
                )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING id
            `)
              .bind(
                merchant.id,
                product.id,
                merchantProductId,
                ean,
                name,
                row.merchant_deep_link ||
                  null,
                row.aw_deep_link ||
                  null,
                row.merchant_image_url ||
                  row.large_image ||
                  null,
                row.currency || "EUR"
              )
              .first<{ id: number }>();
        }

        if (!merchantProduct?.id) {
          continue;
        }

        /*
         * Aktuelles Angebot.
         */
        await env.DB.prepare(`
          INSERT INTO offers
            (
              merchant_product_id,
              price_cents,
              shipping_cents,
              total_price_cents,
              available
            )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(merchant_product_id)
          DO UPDATE SET
            price_cents =
              excluded.price_cents,
            shipping_cents =
              excluded.shipping_cents,
            total_price_cents =
              excluded.total_price_cents,
            available =
              excluded.available,
            checked_at =
              CURRENT_TIMESTAMP
        `)
          .bind(
            merchantProduct.id,
            priceCents,
            shippingCents,
            totalPriceCents,
            available
          )
          .run();

        /*
         * Preishistorie:
         * nur ein neuer Eintrag, wenn sich
         * der aktuelle Gesamtpreis geändert hat.
         */
        const previous =
          await env.DB.prepare(`
            SELECT total_price_cents
            FROM price_history
            WHERE merchant_product_id = ?
            ORDER BY recorded_at DESC, id DESC
            LIMIT 1
          `)
            .bind(
              merchantProduct.id
            )
            .first<{
              total_price_cents: number;
            }>();

        if (
          !previous ||
          previous.total_price_cents !==
            totalPriceCents
        ) {
          await env.DB.prepare(`
            INSERT INTO price_history
              (
                merchant_product_id,
                price_cents,
                shipping_cents,
                total_price_cents,
                available
              )
            VALUES (?, ?, ?, ?, ?)
          `)
            .bind(
              merchantProduct.id,
              priceCents,
              shippingCents,
              totalPriceCents,
              available
            )
            .run();
        }

        productsImported++;
      }
    };

    const parser =
      new CSVParser(async (row) => {
        if (isDogFood(row)) {
          productsFound++;
          batch.push(row);

          if (batch.length >= 50) {
            await flush();
          }
        }
      });

    while (true) {
      const {
        value,
        done
      } = await reader.read();

      if (done) {
        break;
      }

      const text =
        decoder.decode(
          value,
          {
            stream: true
          }
        );

      await parser.push(text);
    }

    await parser.push(
      decoder.decode(),
      true
    );

    await flush();

    await env.DB.prepare(`
      UPDATE imports
      SET
        status = 'completed',
        products_found = ?,
        products_imported = ?,
        products_matched = ?,
        finished_at =
          CURRENT_TIMESTAMP,
        error_message = NULL
      WHERE id = ?
    `)
      .bind(
        productsFound,
        productsImported,
        productsMatched,
        importRecord.id
      )
      .run();

    return {
      success: true,
      import_id: importRecord.id,
      merchant: MERCHANT_NAME,
      products_found: productsFound,
      products_imported:
        productsImported,
      products_matched:
        productsMatched
    };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE imports
      SET
        status = 'failed',
        finished_at =
          CURRENT_TIMESTAMP,
        error_message = ?
      WHERE id = ?
    `)
      .bind(
        String(
          error instanceof Error
            ? error.message
            : error
        ),
        importRecord.id
      )
      .run();

    throw error;
  }
}

export class MyWorkflow
  extends WorkflowEntrypoint<Env> {
  async run(
    event: unknown,
    step: {
      do<T>(
        name: string,
        callback: () => Promise<T>
      ): Promise<T>;
    }
  ) {
    return await step.do(
      "Fressnapf Feed Import",
      async () => {
        return await importFeed(
          this.env
        );
      }
    );
  }
}

export class WorkflowStatusDO
  extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("OK");
  }
}

const worker = {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    const url =
      new URL(request.url);

    if (
      url.pathname ===
        "/api/import/fressnapf" &&
      request.method === "POST"
    ) {
      try {
        const instance =
          await env.MY_WORKFLOW.create({
            params: {
              merchant: "fressnapf",
              startedAt:
                new Date().toISOString()
            }
          });

        return Response.json({
          success: true,
          started: true,
          instance_id: instance.id,
          status_url:
            `/api/import/status/${instance.id}`
        });
      } catch (error) {
        return Response.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          {
            status: 500
          }
        );
      }
    }

    if (
      url.pathname.startsWith(
        "/api/import/status/"
      )
    ) {
      const instanceId =
        url.pathname
          .split("/")
          .pop();

      if (!instanceId) {
        return Response.json(
          {
            success: false,
            error:
              "Instance ID fehlt."
          },
          {
            status: 400
          }
        );
      }

      try {
        const instance =
          await env.MY_WORKFLOW.get(
            instanceId
          );

        const status =
          await instance.status();

        return Response.json({
          success: true,
          instance_id: instanceId,
          status
        });
      } catch (error) {
        return Response.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          {
            status: 500
          }
        );
      }
    }

    if (
      url.pathname ===
      "/api/health"
    ) {
      return Response.json({
        success: true,
        worker:
          "wauvero-feed-import",
        database:
          "wauvero-db",
        version:
          "fressnapf-workflow-v3"
      });
    }

    return Response.json(
      {
        success: false,
        error: "Not Found"
      },
      {
        status: 404
      }
    );
  }
};

export default worker;
