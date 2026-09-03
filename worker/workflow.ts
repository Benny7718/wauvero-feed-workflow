import { WorkflowEntrypoint, DurableObject } from "cloudflare:workers";

const MERCHANT_CONFIG = {
  haustierkost: {
    sourceName: "Haustierkost Awin Feed",
    feedPrefix: "feeds/haustierkost/",
    merchantLike: "%Haustierkost%"
  },
  mera: {
    sourceName: "MERA Awin Feed",
    feedPrefix: "feeds/mera/",
    merchantLike: "%MERA%"
  }
};

const CHUNK_SIZE = 256 * 1024;
const DB_BATCH_SIZE = 50;
const PROGRESS_EVERY_CHUNKS = 8;
const MAX_REMAINDER_BYTES = 800 * 1024;

function normalize(value) {
  return (value ?? "").trim();
}

function numberValue(value) {
  const raw = normalize(value);

  if (!raw) {
    return 0;
  }

  const cleaned = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const result = Number.parseFloat(cleaned);

  return Number.isFinite(result) ? result : 0;
}

function cents(value) {
  return Math.max(
    0,
    Math.round(numberValue(value) * 100)
  );
}

function available(value) {
  const normalized = normalize(value).toLowerCase();

  if (
    [
      "0",
      "false",
      "no",
      "nein",
      "out of stock",
      "outofstock",
      "unavailable"
    ].includes(normalized)
  ) {
    return 0;
  }

  return 1;
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (char === "," && !quoted) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);

  return result;
}

function splitCompleteLines(text) {
  const lines = [];
  let start = 0;
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (
      (char === "\n" || char === "\r") &&
      !quoted
    ) {
      lines.push(
        text.slice(start, i)
      );

      if (
        char === "\r" &&
        text[i + 1] === "\n"
      ) {
        i++;
      }

      start = i + 1;
    }
  }

  return {
    lines,
    remainder: text.slice(start)
  };
}

function rowsFromLines(lines, headers) {
  const rows = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const values = parseCsvLine(line);
    const row = {};

    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = values[i] ?? "";
    }

    rows.push(row);
  }

  return rows;
}

function getMerchantProductId(row) {
  return (
    normalize(row.merchant_product_id) ||
    normalize(row.aw_product_id)
  );
}

function getEan(row) {
  const value =
    normalize(row.product_GTIN) ||
    normalize(row.ean);

  return value || null;
}

function getName(row) {
  return (
    normalize(row.product_short_description) ||
    normalize(row.product_name) ||
    normalize(row.description) ||
    "Unbekanntes Produkt"
  );
}

function getBrand(row) {
  const value = normalize(row.brand_name);

  return value || null;
}

function getCategory(row) {
  const value =
    normalize(row.merchant_category);

  return value || null;
}

function getProductUrl(row) {
  const value =
    normalize(row.merchant_deep_link) ||
    normalize(row.aw_deep_link);

  return value || null;
}

function getAffiliateUrl(row) {
  const value =
    normalize(row.aw_deep_link);

  return value || null;
}

function getImageUrl(row) {
  const value =
    normalize(row.merchant_image_url) ||
    normalize(row.aw_image_url);

  return value || null;
}

function getCurrency(row) {
  return normalize(row.currency) || "EUR";
}

function getSourceUpdatedAt(row) {
  const value =
    normalize(row.last_updated);

  return value || null;
}

function canonicalKey(row) {
  const ean = getEan(row);

  if (ean) {
    return `ean:${ean}`;
  }

  return `merchant-product:${getMerchantProductId(row)}`;
}

function isDogProduct(row) {
  const category = [
    row.merchant_category,
    row.merchant_product_category_path,
    row.category_name
  ]
    .join(" ")
    .toLowerCase();

  const text = [
    row.product_short_description,
    row.product_name,
    row.description,
    row.product_type,
    row.keywords
  ]
    .join(" ")
    .toLowerCase();

  const catDog =
    /(^|>|\s)(hund|hunde|dog|canine)(\s|>|$)/i.test(
      category
    );

  const catCat =
    /(^|>|\s)(katze|katzen|cat|feline)(\s|>|$)/i.test(
      category
    );

  if (catDog && !catCat) {
    return true;
  }

  if (catCat && !catDog) {
    return false;
  }

  return (
    /\b(hund|hunde|dog|canine|puppy|welpe|hundefutter|hundesnack|hundesnacks|kausnack|kauartikel|trockenfutter|nassfutter|barf)\b/i.test(
      text
    ) &&
    !/\b(katzenfutter|katzenstreu|katzenbedarf|cat food)\b/i.test(
      text
    )
  );
}

async function findFeed(
  env,
  feedPrefix,
  merchantName
) {
  const feeds = [];
  let cursor;

  do {
    const page =
      await env.FEED_BUCKET.list({
        prefix: feedPrefix,
        limit: 1000,
        ...(cursor
          ? { cursor }
          : {})
      });

    for (const object of page.objects) {
      if (
        object.key
          .toLowerCase()
          .endsWith(".csv")
      ) {
        feeds.push(object);
      }
    }

    cursor =
      page.truncated
        ? page.cursor
        : undefined;
  } while (cursor);

  feeds.sort(
    (a, b) =>
      b.uploaded.getTime() -
      a.uploaded.getTime()
  );

  if (feeds.length === 0) {
    throw new Error(
      `Kein ${merchantName}-CSV-Feed in R2 gefunden.`
    );
  }

  const feed = feeds[0];

  return {
    key: feed.key,
    size: feed.size,
    etag: feed.etag
  };
}

async function readHeader(env, key) {
  const object =
    await env.FEED_BUCKET.get(
      key,
      {
        range: {
          offset: 0,
          length: CHUNK_SIZE
        }
      }
    );

  if (
    !object ||
    !("body" in object) ||
    !object.body
  ) {
    throw new Error(
      "CSV-Header konnte nicht gelesen werden."
    );
  }

  const bytes = new Uint8Array(
    await object.arrayBuffer()
  );

  const newlineByte =
    bytes.indexOf(10);

  if (newlineByte < 0) {
    throw new Error(
      "CSV enthält keine Kopfzeile."
    );
  }

  let headerLine =
    new TextDecoder(
      "utf-8",
      {
        fatal: true,
        ignoreBOM: false
      }
    ).decode(
      bytes.slice(
        0,
        newlineByte
      )
    );

  headerLine =
    headerLine.replace(
      /\r$/,
      ""
    );

  if (
    headerLine.charCodeAt(0) ===
    65279
  ) {
    headerLine =
      headerLine.slice(1);
  }

  const headers =
    parseCsvLine(
      headerLine
    ).map(
      (value) =>
        value.trim()
    );

  if (headers.length < 2) {
    throw new Error(
      "CSV-Header ist ungültig."
    );
  }

  return {
    headers,
    offset:
      newlineByte + 1
  };
}

function stateKey(
  instanceId,
  merchantKey = "haustierkost"
) {
  return `workflow-state/${merchantKey}/${instanceId}.txt`;
}

async function readRemainder(
  env,
  instanceId,
  merchantKey = "haustierkost"
) {
  const object =
    await env.FEED_BUCKET.get(
      stateKey(
        instanceId,
        merchantKey
      )
    );

  if (!object) {
    return "";
  }

  return object.text();
}

async function writeRemainder(
  env,
  instanceId,
  remainder,
  merchantKey = "haustierkost"
) {
  const bytes =
    new TextEncoder().encode(
      remainder
    );

  if (
    bytes.byteLength >
    MAX_REMAINDER_BYTES
  ) {
    throw new Error(
      "CSV enthält eine einzelne Zeile, die größer als der zulässige Chunk-Puffer ist."
    );
  }

  if (remainder.length === 0) {
    await env.FEED_BUCKET.delete(
      stateKey(
        instanceId,
        merchantKey
      )
    );

    return;
  }

  await env.FEED_BUCKET.put(
    stateKey(
      instanceId,
      merchantKey
    ),
    bytes,
    {
      httpMetadata: {
        contentType:
          "text/plain; charset=utf-8"
      }
    }
  );
}

async function processChunk(
  env,
  source,
  merchantId,
  headers,
  instanceId,
  currentOffset,
  merchantKey = "haustierkost"
) {
  const object =
    await env.FEED_BUCKET.get(
      source.key,
      {
        range: {
          offset:
            currentOffset,
          length:
            CHUNK_SIZE
        },
        onlyIf: {
          etagMatches:
            source.etag
        }
      }
    );

  if (
    !object ||
    !("body" in object) ||
    !object.body
  ) {
    throw new Error(
      `R2-Feed konnte bei Offset ${currentOffset} nicht gelesen werden oder wurde während des Imports geändert.`
    );
  }

  const bytes =
    new Uint8Array(
      await object.arrayBuffer()
    );

  if (bytes.byteLength === 0) {
    throw new Error(
      `R2-Feed lieferte bei Offset ${currentOffset} keine Daten.`
    );
  }

  const remainder =
    await readRemainder(
      env,
      instanceId,
      merchantKey
    );

  const decoder =
    new TextDecoder(
      "utf-8",
      {
        fatal: true,
        ignoreBOM: false
      }
    );

  let decoded;

  try {
    decoded =
      decoder.decode(bytes);
  } catch {
    throw new Error(
      `UTF-8-Dekodierung bei Offset ${currentOffset} fehlgeschlagen.`
    );
  }

  const combined =
    remainder + decoded;

  const split =
    splitCompleteLines(
      combined
    );

  const rows =
    rowsFromLines(
      split.lines,
      headers
    );

  const dogRows =
    rows.filter(
      isDogProduct
    );

  const statements = [];
  let importedChunk = 0;

  for (const row of dogRows) {
    const merchantProductId =
      getMerchantProductId(
        row
      );

    if (!merchantProductId) {
      continue;
    }

    const priceCents =
      cents(
        row.search_price ||
        row.display_price
      );

    if (priceCents <= 0) {
      continue;
    }

    const shippingCents =
      cents(
        row.delivery_cost
      );

    const totalPriceCents =
      priceCents +
      shippingCents;

    const isAvailable =
      available(
        row.in_stock
      );

    const ean =
      getEan(row);

    const key =
      canonicalKey(row);

    const productName =
      getName(row);

    const brand =
      getBrand(row);

    const category =
      getCategory(row);

    const productUrl =
      getProductUrl(row);

    const affiliateUrl =
      getAffiliateUrl(row);

    const imageUrl =
      getImageUrl(row);

    const currency =
      getCurrency(row);

    const sourceUpdatedAt =
      getSourceUpdatedAt(row);

    statements.push(
      env.DB.prepare(
        `INSERT INTO products (
          canonical_key,
          ean_gtin,
          brand,
          name,
          animal_type,
          category
        )
        SELECT
          ?,
          ?,
          ?,
          ?,
          'dog',
          ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM products
          WHERE ean_gtin = ?
          AND ean_gtin IS NOT NULL
          AND ean_gtin <> ''
        )
        ON CONFLICT(canonical_key)
        DO UPDATE SET
          ean_gtin =
            COALESCE(
              excluded.ean_gtin,
              products.ean_gtin
            ),
          brand =
            COALESCE(
              excluded.brand,
              products.brand
            ),
          name =
            excluded.name,
          animal_type =
            'dog',
          category =
            COALESCE(
              excluded.category,
              products.category
            ),
          updated_at =
            CURRENT_TIMESTAMP`
      ).bind(
        key,
        ean,
        brand,
        productName,
        category,
        ean
      )
    );

    if (ean) {
      statements.push(
        env.DB.prepare(
          `UPDATE products
           SET
             brand = ?,
             name = ?,
             animal_type = 'dog',
             category =
               COALESCE(
                 ?,
                 category
               ),
             updated_at =
               CURRENT_TIMESTAMP
           WHERE ean_gtin = ?`
        ).bind(
          brand,
          productName,
          category,
          ean
        )
      );
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO merchant_products (
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
        VALUES (
          ?,
          (
            SELECT id
            FROM products
            WHERE
              (
                ean_gtin = ?
                AND ean_gtin IS NOT NULL
                AND ean_gtin <> ''
              )
              OR canonical_key = ?
            ORDER BY
              CASE
                WHEN ean_gtin = ?
                THEN 0
                ELSE 1
              END
            LIMIT 1
          ),
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
        ON CONFLICT(
          merchant_id,
          merchant_product_id
        )
        DO UPDATE SET
          product_id =
            excluded.product_id,
          ean_gtin =
            COALESCE(
              excluded.ean_gtin,
              merchant_products.ean_gtin
            ),
          product_name =
            excluded.product_name,
          product_url =
            excluded.product_url,
          affiliate_url =
            excluded.affiliate_url,
          image_url =
            excluded.image_url,
          currency =
            excluded.currency,
          updated_at =
            CURRENT_TIMESTAMP`
      ).bind(
        merchantId,
        ean,
        key,
        ean,
        merchantProductId,
        ean,
        productName,
        productUrl,
        affiliateUrl,
        imageUrl,
        currency
      )
    );

    statements.push(
      env.DB.prepare(
        `INSERT INTO offers (
          merchant_product_id,
          price_cents,
          shipping_cents,
          total_price_cents,
          available,
          source_updated_at
        )
        VALUES (
          (
            SELECT id
            FROM merchant_products
            WHERE
              merchant_id = ?
              AND merchant_product_id = ?
            LIMIT 1
          ),
          ?,
          ?,
          ?,
          ?,
          ?
        )
        ON CONFLICT(
          merchant_product_id
        )
        DO UPDATE SET
          price_cents =
            excluded.price_cents,
          shipping_cents =
            excluded.shipping_cents,
          total_price_cents =
            excluded.total_price_cents,
          available =
            excluded.available,
          source_updated_at =
            excluded.source_updated_at,
          checked_at =
            CURRENT_TIMESTAMP`
      ).bind(
        merchantId,
        merchantProductId,
        priceCents,
        shippingCents,
        totalPriceCents,
        isAvailable,
        sourceUpdatedAt
      )
    );

    importedChunk++;
  }

  for (
    let i = 0;
    i < statements.length;
    i += DB_BATCH_SIZE
  ) {
    const batch =
      statements.slice(
        i,
        i + DB_BATCH_SIZE
      );

    if (batch.length > 0) {
      await env.DB.batch(
        batch
      );
    }
  }

  await writeRemainder(
    env,
    instanceId,
    split.remainder,
    merchantKey
  );

  const nextOffset =
    Math.min(
      source.size,
      currentOffset +
        bytes.byteLength
    );

  const done =
    nextOffset >=
      source.size &&
    split.remainder.length === 0;

  if (
    done &&
    remainder.length > 0 &&
    split.lines.length === 0
  ) {
    throw new Error(
      "CSV endet mit einem unvollständigen Datensatz."
    );
  }

  return {
    nextOffset,
    found:
      dogRows.length,
    imported:
      importedChunk,
    matched:
      importedChunk,
    done
  };
}

async function downloadMeraFeed(env) {
  if (!env.MERA_FEED_URL) {
    throw new Error(
      "MERA_FEED_URL ist nicht konfiguriert."
    );
  }

  const response =
    await fetch(
      env.MERA_FEED_URL,
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "Accept":
            "text/csv,*/*",
          "Accept-Encoding":
            "identity"
        }
      }
    );

  if (
    !response.ok ||
    !response.body
  ) {
    throw new Error(
      `MERA Feed konnte nicht geladen werden (HTTP ${response.status}).`
    );
  }

  const reader =
    response.body.getReader();

  const first =
    await reader.read();

  const firstChunk =
    first.value ||
    new Uint8Array();

  const isGzip =
    firstChunk.length >= 2 &&
    firstChunk[0] === 0x1f &&
    firstChunk[1] === 0x8b;

  let firstPending = true;

  const source =
    new ReadableStream({
      async pull(controller) {
        if (firstPending) {
          firstPending = false;

          if (firstChunk.length) {
            controller.enqueue(
              firstChunk
            );
          }

          if (first.done) {
            controller.close();
          }

          return;
        }

        const next =
          await reader.read();

        if (next.done) {
          controller.close();
        } else if (next.value) {
          controller.enqueue(
            next.value
          );
        }
      },

      cancel(reason) {
        return reader.cancel(
          reason
        );
      },

      start() {
        firstPending = true;
      }
    });

  const body =
    isGzip
      ? source.pipeThrough(
          new DecompressionStream(
            "gzip"
          )
        )
      : source;

  const key =
    "feeds/mera/mera.csv";

  await env.FEED_BUCKET.put(
    key,
    body,
    {
      httpMetadata: {
        contentType:
          "text/csv; charset=utf-8"
      }
    }
  );

  return key;
}

class MyWorkflow
  extends WorkflowEntrypoint {

  async run(event, step) {
    const instanceId =
      event.instanceId;

    const merchantKey =
      event?.params?.merchant ===
      "mera"
        ? "mera"
        : "haustierkost";

    const config =
      MERCHANT_CONFIG[
        merchantKey
      ];

    if (
      merchantKey === "mera"
    ) {
      await step.do(
        "download MERA feed",
        async () => {
          await downloadMeraFeed(
            this.env
          );
        }
      );
    }

    const source =
      await step.do(
        `find ${merchantKey} feed`,
        async () =>
          findFeed(
            this.env,
            config.feedPrefix,
            merchantKey === "mera"
              ? "MERA"
              : "Haustierkost"
          )
      );

    const merchant =
      await step.do(
        `find ${merchantKey} merchant`,
        async () => {

          let result =
            await this.env.DB
              .prepare(
                `SELECT id, name
                 FROM merchants
                 WHERE name LIKE ?
                 LIMIT 1`
              )
              .bind(
                config.merchantLike
              )
              .first();

          if (
            !result &&
            merchantKey === "mera"
          ) {
            await this.env.DB
              .prepare(
                `INSERT INTO merchants (name)
                 VALUES (?)
                 ON CONFLICT(name)
                 DO NOTHING`
              )
              .bind(
                "MERA"
              )
              .run();

            result =
              await this.env.DB
                .prepare(
                  `SELECT id, name
                   FROM merchants
                   WHERE name = ?
                   LIMIT 1`
                )
                .bind(
                  "MERA"
                )
                .first();
          }

          if (!result) {
            throw new Error(
              `${
                merchantKey === "mera"
                  ? "MERA"
                  : "Haustierkost"
              }-Merchant wurde in D1 nicht gefunden.`
            );
          }

          return result;
        }
      );

    const importId =
      await step.do(
        "create import record",
        async () => {

          const result =
            await this.env.DB
              .prepare(
                `INSERT INTO imports (
                  merchant_id,
                  source_name,
                  status,
                  products_found,
                  products_imported,
                  products_matched
                )
                VALUES (
                  ?,
                  ?,
                  'running',
                  0,
                  0,
                  0
                )
                RETURNING id`
              )
              .bind(
                merchant.id,
                config.sourceName
              )
              .first();

          if (!result?.id) {
            throw new Error(
              "Import-Datensatz konnte nicht erstellt werden."
            );
          }

          return result.id;
        }
      );

    const header =
      await step.do(
        "read CSV header",
        async () =>
          readHeader(
            this.env,
            source.key
          )
      );

    let offset =
      header.offset;

    let productsFound = 0;
    let productsImported = 0;
    let productsMatched = 0;
    let chunkNumber = 0;

    try {

      while (
        offset <
        source.size
      ) {

        const currentOffset =
          offset;

        const currentChunkNumber =
          chunkNumber + 1;

        const result =
          await step.do(
            `process ${merchantKey} chunk ${currentChunkNumber}`,
            async () =>
              processChunk(
                this.env,
                source,
                merchant.id,
                header.headers,
                instanceId,
                currentOffset,
                merchantKey
              )
          );

        if (
          result.nextOffset <=
            currentOffset &&
          !result.done
        ) {
          throw new Error(
            `Feed-Import macht keinen Fortschritt bei Offset ${currentOffset}.`
          );
        }

        offset =
          result.nextOffset;

        productsFound +=
          result.found;

        productsImported +=
          result.imported;

        productsMatched +=
          result.matched;

        chunkNumber =
          currentChunkNumber;

        if (
          result.done ||
          chunkNumber %
            PROGRESS_EVERY_CHUNKS ===
            0
        ) {

          const progressFound =
            productsFound;

          const progressImported =
            productsImported;

          const progressMatched =
            productsMatched;

          await step.do(
            `save progress ${chunkNumber}`,
            async () => {

              await this.env.DB
                .prepare(
                  `UPDATE imports
                   SET products_found = ?,
                       products_imported = ?,
                       products_matched = ?
                   WHERE id = ?
                   AND status = 'running'`
                )
                .bind(
                  progressFound,
                  progressImported,
                  progressMatched,
                  importId
                )
                .run();
            }
          );
        }

        if (result.done) {
          break;
        }
      }

      await step.do(
        "complete import",
        async () => {

          await this.env.DB
            .prepare(
              `UPDATE imports
               SET status = 'completed',
                   products_found = ?,
                   products_imported = ?,
                   products_matched = ?,
                   finished_at = CURRENT_TIMESTAMP,
                   error_message = NULL
               WHERE id = ?`
            )
            .bind(
              productsFound,
              productsImported,
              productsMatched,
              importId
            )
            .run();

          await this.env.FEED_BUCKET.delete(
            stateKey(
              instanceId,
              merchantKey
            )
          );
        }
      );

      return {
        success: true,
        instanceId,
        importId,
        merchant: merchant.name,
        feed: source.key,
        productsFound,
        productsImported,
        productsMatched,
        chunks: chunkNumber
      };

    } catch (error) {

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      await step.do(
        "mark import failed",
        async () => {

          await this.env.DB
            .prepare(
              `UPDATE imports
               SET status = 'failed',
                   finished_at = CURRENT_TIMESTAMP,
                   error_message = ?
               WHERE id = ?`
            )
            .bind(
              message,
              importId
            )
            .run();
        }
      );

      throw error;
    }
  }
}

class WorkflowStatusDO
  extends DurableObject {

  stepStatuses;
  currentStep;
  workflowStatus;

  constructor(ctx, env) {
    super(ctx, env);

    this.stepStatuses =
      new Map();

    this.currentStep =
      null;

    this.workflowStatus =
      "running";

    ctx.blockConcurrencyWhile(
      async () => {

        const storedStatuses =
          await ctx.storage.get(
            "stepStatuses"
          );

        const storedCurrent =
          await ctx.storage.get(
            "currentStep"
          );

        const storedWorkflowStatus =
          await ctx.storage.get(
            "workflowStatus"
          );

        if (storedStatuses) {

          this.stepStatuses =
            new Map(
              Object.entries(
                storedStatuses
              )
            );

        } else {

          const steps = [
            "process data",
            "wait 2 seconds",
            "wait for approval",
            "final"
          ];

          steps.forEach(
            (s) =>
              this.stepStatuses.set(
                s,
                "pending"
              )
          );
        }

        this.currentStep =
          storedCurrent ??
          null;

        this.workflowStatus =
          storedWorkflowStatus ??
          "running";
      }
    );
  }

  async fetch(request) {

    if (
      request.headers.get(
        "Upgrade"
      ) === "websocket"
    ) {

      const pair =
        new WebSocketPair();

      const [
        client,
        server
      ] = Object.values(pair);

      this.ctx.acceptWebSocket(
        server
      );

      server.send(
        JSON.stringify(
          this.getStateMessage()
        )
      );

      return new Response(
        null,
        {
          status: 101,
          webSocket: client
        }
      );
    }

    return new Response(
      "Expected WebSocket",
      {
        status: 400
      }
    );
  }

  async updateStep(
    stepName,
    status
  ) {

    this.stepStatuses.set(
      stepName,
      status
    );

    if (
      status === "running" ||
      status === "waiting"
    ) {
      this.currentStep =
        stepName;
    }

    const allCompleted =
      Array.from(
        this.stepStatuses.values()
      ).every(
        (s) =>
          s === "completed"
      );

    if (allCompleted) {

      this.workflowStatus =
        "completed";

      this.currentStep =
        null;
    }

    await this.ctx.storage.put(
      "stepStatuses",
      Object.fromEntries(
        this.stepStatuses
      )
    );

    await this.ctx.storage.put(
      "currentStep",
      this.currentStep
    );

    await this.ctx.storage.put(
      "workflowStatus",
      this.workflowStatus
    );

    this.broadcast(
      this.getStateMessage()
    );
  }

  async webSocketMessage(
    ws,
    _message
  ) {

    ws.send(
      JSON.stringify(
        this.getStateMessage()
      )
    );
  }

  async webSocketClose(
    ws,
    code,
    reason,
    _wasClean
  ) {

    ws.close(
      code,
      reason
    );
  }

  broadcast(message) {

    const sockets =
      this.ctx.getWebSockets();

    const json =
      JSON.stringify(
        message
      );

    for (
      const socket of sockets
    ) {

      try {
        socket.send(
          json
        );
      } catch {
      }
    }
  }

  getStateMessage() {

    return {
      type:
        "workflow_update",

      currentStep:
        this.currentStep,

      stepStatuses:
        Object.fromEntries(
          this.stepStatuses
        ),

      workflowStatus:
        this.workflowStatus,

      timestamp:
        Date.now()
    };
  }
}

const index = {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );

    if (
      url.pathname ===
        "/api/workflow/start" &&
      request.method ===
        "POST"
    ) {

      try {

        const merchant =
          url.searchParams.get(
            "merchant"
          ) === "mera"
            ? "mera"
            : "haustierkost";

        const instance =
          await env.MY_WORKFLOW.create(
            {
              params: {
                timestamp:
                  Date.now(),

                merchant
              }
            }
          );

        return Response.json(
          {
            instanceId:
              instance.id,

            message:
              "Workflow started successfully"
          }
        );

      } catch {

        return Response.json(
          {
            error:
              "Failed to start workflow"
          },
          {
            status: 500
          }
        );
      }
    }

    if (
      url.pathname.startsWith(
        "/api/workflow/status/"
      )
    ) {

      const instanceId =
        url.pathname
          .split("/")
          .pop();

      if (!instanceId) {

        return Response.json(
          {
            error:
              "Instance ID required"
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

        return Response.json(
          status
        );

      } catch {

        return Response.json(
          {
            error:
              "Failed to get workflow status"
          },
          {
            status: 500
          }
        );
      }
    }

    if (
      url.pathname.startsWith(
        "/api/workflow/event/"
      ) &&
      request.method ===
        "POST"
    ) {

      const instanceId =
        url.pathname
          .split("/")
          .pop();

      if (!instanceId) {

        return Response.json(
          {
            error:
              "Instance ID required"
          },
          {
            status: 400
          }
        );
      }

      try {

        const body =
          await request.json();

        const instance =
          await env.MY_WORKFLOW.get(
            instanceId
          );

        await instance.sendEvent(
          {
            type:
              "user-approval",

            payload:
              body
          }
        );

        return Response.json(
          {
            success:
              true,

            message:
              "Event sent successfully"
          }
        );

      } catch {

        return Response.json(
          {
            error:
              "Failed to send event"
          },
          {
            status: 500
          }
        );
      }
    }

    if (
      url.pathname ===
      "/ws"
    ) {

      const instanceId =
        url.searchParams.get(
          "instanceId"
        );

      if (!instanceId) {

        return new Response(
          "instanceId query parameter required",
          {
            status: 400
          }
        );
      }

      const upgradeHeader =
        request.headers.get(
          "Upgrade"
        );

      if (
        upgradeHeader !==
        "websocket"
      ) {

        return new Response(
          "Expected Upgrade: websocket",
          {
            status: 426
          }
        );
      }

      try {

        const doId =
          env.WORKFLOW_STATUS.idFromName(
            instanceId
          );

        const stub =
          env.WORKFLOW_STATUS.get(
            doId
          );

        return stub.fetch(
          request
        );

      } catch {

        return new Response(
          "Failed to establish WebSocket connection",
          {
            status: 500
          }
        );
      }
    }

    return Response.json(
      {
        error:
          "Not Found"
      },
      {
        status: 404
      }
    );
  }
};

const workerEntry =
  index ?? {};

export {
  MyWorkflow,
  WorkflowStatusDO,
  workerEntry as default
};
