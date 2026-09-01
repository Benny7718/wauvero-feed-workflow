import { WorkflowEntrypoint } from "cloudflare:workers";

const SOURCE_NAME = "Fressnapf Awin Feed";
const FEED_PREFIX = "feeds/fressnapf/";
const CHUNK_SIZE = 256 * 1024;

type FeedSource = {
	key: string;
	size: number;
	etag: string;
};

type FeedRow = Record<string, string>;

type DbRow = {
	key: string;
	ean: string | null;
	brand: string | null;
	name: string;
	category: string | null;
	mpid: string;
	url: string | null;
	affiliate: string | null;
	image: string | null;
	currency: string;
	price: number;
	shipping: number;
	total: number;
	available: number;
	updated: string | null;
};

function normalize(value: string | undefined): string {
	return (value ?? "").trim();
}

function moneyToCents(value: string | undefined): number {
	const raw = normalize(value).replace(/[^\d,.-]/g, "");

	if (!raw) return 0;

	const comma = raw.lastIndexOf(",");
	const dot = raw.lastIndexOf(".");

	let normalized = raw;

	if (comma >= 0 && dot >= 0) {
		if (comma > dot) {
			normalized = raw.replace(/\./g, "").replace(",", ".");
		} else {
			normalized = raw.replace(/,/g, "");
		}
	} else if (comma >= 0) {
		normalized = raw.replace(/\./g, "").replace(",", ".");
	}

	const number = Number.parseFloat(normalized);

	return Number.isFinite(number)
		? Math.max(0, Math.round(number * 100))
		: 0;
}

function isAvailable(value: string | undefined): number {
	return /^(0|false|no|nein|out\s*of\s*stock|outofstock|unavailable)$/i.test(
		normalize(value),
	)
		? 0
		: 1;
}

function parseCsvRecord(record: string): string[] {
	const result: string[] = [];
	let current = "";
	let quoted = false;

	for (let i = 0; i < record.length; i++) {
		const char = record[i];

		if (char === '"') {
			if (quoted && record[i + 1] === '"') {
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

	if (quoted) {
		throw new Error(
			"Ungültiger CSV-Datensatz: nicht geschlossene Anführungszeichen.",
		);
	}

	result.push(current);
	return result;
}

function splitCompleteRecords(text: string): {
	records: string[];
	remainder: string;
} {
	const records: string[] = [];
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

		if ((char === "\n" || char === "\r") && !quoted) {
			records.push(text.slice(start, i));

			if (char === "\r" && text[i + 1] === "\n") {
				i++;
			}

			start = i + 1;
		}
	}

	return {
		records,
		remainder: text.slice(start),
	};
}

function rowFromRecord(
	record: string,
	headers: string[],
): FeedRow {
	const values = parseCsvRecord(record);
	const row: FeedRow = {};

	for (let i = 0; i < headers.length; i++) {
		row[headers[i]] = values[i] ?? "";
	}

	return row;
}

function getMerchantProductId(row: FeedRow): string {
	return (
		normalize(row.merchant_product_id) ||
		normalize(row.aw_product_id)
	);
}

function getEan(row: FeedRow): string | null {
	const value =
		normalize(row.product_GTIN) ||
		normalize(row.ean);

	return value || null;
}

function getName(row: FeedRow): string {
	return (
		normalize(row.product_short_description) ||
		normalize(row.product_name) ||
		normalize(row.description) ||
		"Unbekanntes Produkt"
	);
}

function getBrand(row: FeedRow): string | null {
	const value = normalize(row.brand_name);
	return value || null;
}

function getCategory(row: FeedRow): string | null {
	const value = normalize(row.merchant_category);
	return value || null;
}

function getProductUrl(row: FeedRow): string | null {
	const value =
		normalize(row.merchant_deep_link) ||
		normalize(row.aw_deep_link);

	return value || null;
}

function getAffiliateUrl(row: FeedRow): string | null {
	const value = normalize(row.aw_deep_link);
	return value || null;
}

function getImageUrl(row: FeedRow): string | null {
	const value =
		normalize(row.merchant_image_url) ||
		normalize(row.aw_image_url);

	return value || null;
}

function getCurrency(row: FeedRow): string {
	return normalize(row.currency) || "EUR";
}

function getSourceUpdatedAt(row: FeedRow): string | null {
	const value = normalize(row.last_updated);
	return value || null;
}

function canonicalKey(row: FeedRow): string {
	const ean = getEan(row);
	const mpid = getMerchantProductId(row);

	return ean
		? `ean:${ean}`
		: `merchant-product:${mpid}`;
}

function isDogProduct(row: FeedRow): boolean {
	const categories = [
		row.merchant_category,
		row.merchant_product_category_path,
		row.category_name,
	];

	const text = [
		row.product_short_description,
		row.product_name,
		row.description,
		row.product_type,
		row.keywords,
	].join(" ");

	const dogCategory = categories.some((value) =>
		/(^|>)\s*(hund|hunde|hundefutter|hundesnacks?|kauartikel|kausnacks?|leckerli)(\s*>|$)/i.test(
			normalize(value),
		),
	);

	if (dogCategory) {
		return true;
	}

	if (categories.some((value) => normalize(value))) {
		return false;
	}

	return (
		/\b(hund|hunde|dog|canine)\b/i.test(text) &&
		/\b(hundefutter|hundesnack|hundesnacks|kauartikel|kausnack|kausnacks|leckerli|trockenfutter|nassfutter|barf)\b/i.test(
			text,
		) &&
		!/\b(katzenfutter|katzenstreu|katzenbedarf|cat food)\b/i.test(
			text,
		)
	);
}

async function findFeed(env: Env): Promise<FeedSource> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;

	do {
		const page = await env.FEED_BUCKET.list({
			prefix: FEED_PREFIX,
			limit: 1000,
			...(cursor ? { cursor } : {}),
		});

		objects.push(
			...page.objects.filter((object) =>
				object.key.toLowerCase().endsWith(".csv"),
			),
		);

		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	objects.sort(
		(a, b) =>
			b.uploaded.getTime() -
			a.uploaded.getTime(),
	);

	const feed = objects[0];

	if (!feed) {
		throw new Error(
			"Kein Fressnapf-CSV-Feed in R2 gefunden.",
		);
	}

	return {
		key: feed.key,
		size: feed.size,
		etag: feed.etag,
	};
}

async function readHeader(
	env: Env,
	source: FeedSource,
): Promise<{
	headers: string[];
	offset: number;
}> {
	const result = await env.FEED_BUCKET.get(
		source.key,
		{
			range: {
				offset: 0,
				length: CHUNK_SIZE,
			},
		},
	);

	if (!result) {
		throw new Error(
			"CSV-Header konnte nicht gelesen werden.",
		);
	}

	const bytes = new Uint8Array(
		await result.arrayBuffer(),
	);

	let quoted = false;
	let newlineByte = -1;

	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];

		if (byte === 34) {
			if (quoted && bytes[i + 1] === 34) {
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (byte === 10 && !quoted) {
			newlineByte = i;
			break;
		}
	}

	if (newlineByte < 0) {
		throw new Error(
			"CSV enthält keine vollständige Kopfzeile.",
		);
	}

	let headerBytes = bytes.slice(0, newlineByte);

	if (
		headerBytes.length &&
		headerBytes[headerBytes.length - 1] === 13
	) {
		headerBytes = headerBytes.slice(0, -1);
	}

	const header = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: false,
	}).decode(headerBytes);

	const headers = parseCsvRecord(
		header.replace(/^\uFEFF/, ""),
	).map((value) => value.trim());

	if (headers.length < 2) {
		throw new Error("CSV-Header ist ungültig.");
	}

	return {
		headers,
		offset: newlineByte + 1,
	};
}

function normalizeRows(rows: FeedRow[]): DbRow[] {
	const map = new Map<string, DbRow>();

	for (const row of rows) {
		const mpid = getMerchantProductId(row);

		if (!mpid) continue;

		const price = moneyToCents(
			row.search_price ||
				row.display_price,
		);

		if (price <= 0) continue;

		const shipping = moneyToCents(
			row.delivery_cost,
		);

		map.set(mpid, {
			key: canonicalKey(row),
			ean: getEan(row),
			brand: getBrand(row),
			name: getName(row),
			category: getCategory(row),
			mpid,
			url: getProductUrl(row),
			affiliate: getAffiliateUrl(row),
			image: getImageUrl(row),
			currency: getCurrency(row),
			price,
			shipping,
			total: price + shipping,
			available: isAvailable(row.in_stock),
			updated: getSourceUpdatedAt(row),
		});
	}

	return Array.from(map.values());
}

async function processChunk(
	env: Env,
	source: FeedSource,
	merchantId: number,
	headers: string[],
	offset: number,
	remainder: string,
	importId: number,
): Promise<{
	nextOffset: number;
	remainder: string;
	found: number;
	imported: number;
	matched: number;
	done: boolean;
}> {
	const result = await env.FEED_BUCKET.get(
		source.key,
		{
			range: {
				offset,
				length: Math.min(
					CHUNK_SIZE,
					source.size - offset,
				),
			},
		},
	);

	if (!result) {
		throw new Error(
			`R2-Feed konnte bei Offset ${offset} nicht gelesen werden.`,
		);
	}

	const bytes = new Uint8Array(
		await result.arrayBuffer(),
	);

	if (bytes.length === 0) {
		throw new Error(
			`R2-Feed lieferte bei Offset ${offset} keine Daten.`,
		);
	}

	let text = "";

	for (let trim = 0; trim <= 3; trim++) {
		const cut = bytes.length - trim;

		try {
			text = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: false,
			}).decode(bytes.slice(0, cut));

			break;
		} catch {
			if (trim === 3) {
				throw new Error(
					`UTF-8-Dekodierung bei Offset ${offset} fehlgeschlagen.`,
				);
			}
		}
	}

	const split = splitCompleteRecords(
		remainder + text,
	);

	const rows: FeedRow[] = [];

	for (const record of split.records) {
		if (!record.trim()) continue;

		const row = rowFromRecord(
			record,
			headers,
		);

		if (isDogProduct(row)) {
			rows.push(row);
		}
	}

	const dbRows = normalizeRows(rows);

	const found = rows.length;
	const imported = dbRows.length;

	if (dbRows.length > 0) {
		for (
			let start = 0;
			start < dbRows.length;
			start += 100
		) {
			const batchRows = dbRows.slice(
				start,
				start + 100,
			);

			const statements: D1PreparedStatement[] =
				[];

			for (const row of batchRows) {
				let productId: number | null = null;

				if (row.ean) {
					const existing =
						await env.DB.prepare(`
							SELECT id
							FROM products
							WHERE ean_gtin = ?
							LIMIT 1
						`)
							.bind(row.ean)
							.first<{ id: number }>();

					productId = existing?.id ?? null;
				}

				if (productId === null) {
					const existing =
						await env.DB.prepare(`
							SELECT id
							FROM products
							WHERE canonical_key = ?
							LIMIT 1
						`)
							.bind(row.key)
							.first<{ id: number }>();

					productId = existing?.id ?? null;
				}

				if (productId === null) {
					const created =
						await env.DB.prepare(`
							INSERT INTO products (
								canonical_key,
								ean_gtin,
								brand,
								name,
								animal_type,
								category
							)
							VALUES (?, ?, ?, ?, 'dog', ?)
							RETURNING id
						`)
							.bind(
								row.key,
								row.ean,
								row.brand,
								row.name,
								row.category,
							)
							.first<{ id: number }>();

					productId = created?.id ?? null;
				}

				if (productId === null) {
					throw new Error(
						`Produkt konnte nicht angelegt werden: ${row.mpid}`,
					);
				}

				statements.push(
					env.DB.prepare(`
						UPDATE products
						SET
							ean_gtin = COALESCE(?, ean_gtin),
							brand = ?,
							name = ?,
							animal_type = 'dog',
							category = ?,
							updated_at = CURRENT_TIMESTAMP
						WHERE id = ?
					`).bind(
						row.ean,
						row.brand,
						row.name,
						row.category,
						productId,
					),
				);

				statements.push(
					env.DB.prepare(`
						INSERT INTO merchant_products (
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
						ON CONFLICT (
							merchant_id,
							merchant_product_id
						)
						DO UPDATE SET
							product_id = excluded.product_id,
							ean_gtin = excluded.ean_gtin,
							product_name = excluded.product_name,
							product_url = excluded.product_url,
							affiliate_url = excluded.affiliate_url,
							image_url = excluded.image_url,
							currency = excluded.currency,
							updated_at = CURRENT_TIMESTAMP
					`).bind(
						merchantId,
						productId,
						row.mpid,
						row.ean,
						row.name,
						row.url,
						row.affiliate,
						row.image,
						row.currency,
					),
				);

				statements.push(
					env.DB.prepare(`
						INSERT INTO offers (
							merchant_product_id,
							price_cents,
							shipping_cents,
							total_price_cents,
							available,
							source_updated_at
						)
						SELECT
							id,
							?,
							?,
							?,
							?,
							?
						FROM merchant_products
						WHERE
							merchant_id = ?
							AND merchant_product_id = ?
						ON CONFLICT (
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
								CURRENT_TIMESTAMP
					`).bind(
						row.price,
						row.shipping,
						row.total,
						row.available,
						row.updated,
						merchantId,
						row.mpid,
					),
				);

				statements.push(
					env.DB.prepare(`
						INSERT INTO price_history (
							merchant_product_id,
							price_cents,
							shipping_cents,
							total_price_cents,
							available,
							recorded_at
						)
						SELECT
							id,
							?,
							?,
							?,
							?,
							CURRENT_TIMESTAMP
						FROM merchant_products
						WHERE
							merchant_id = ?
							AND merchant_product_id = ?
						AND NOT EXISTS (
							SELECT 1
							FROM price_history h
							WHERE
								h.merchant_product_id = merchant_products.id
								AND h.price_cents = ?
								AND h.shipping_cents = ?
								AND h.total_price_cents = ?
								AND h.available = ?
								AND h.recorded_at >= datetime(
									'now',
									'-1 hour'
								)
						)
					`).bind(
						row.price,
						row.shipping,
						row.total,
						row.available,
						merchantId,
						row.mpid,
						row.price,
						row.shipping,
						row.total,
						row.available,
					),
				);
			}

			await env.DB.batch(statements);
		}
	}

	await env.DB.prepare(`
		UPDATE imports
		SET
			products_found = products_found + ?,
			products_imported = products_imported + ?,
			products_matched = products_matched + ?
		WHERE id = ?
			AND status = 'running'
	`).bind(
		found,
		imported,
		imported,
		importId,
	).run();

	const nextOffset = Math.min(
		source.size,
		offset + bytes.length,
	);

	const done =
		nextOffset >= source.size &&
		split.remainder.length === 0;

	return {
		nextOffset,
		remainder: split.remainder,
		found,
		imported,
		matched: imported,
		done,
	};
}

export class MyWorkflow extends WorkflowEntrypoint<Env> {
	async run(
		event: any,
		step: any,
	) {
		const source = await step.do(
			"find Fressnapf feed",
			() => findFeed(this.env),
		);

		const merchant = await step.do(
			"find Fressnapf merchant",
			async () => {
				const result =
					await this.env.DB
						.prepare(`
							SELECT id, name
							FROM merchants
							WHERE name LIKE ?
							LIMIT 1
						`)
						.bind("%Fressnapf%")
						.first<{
							id: number;
							name: string;
						}>();

				if (!result) {
					throw new Error(
						"Fressnapf-Merchant wurde in D1 nicht gefunden.",
					);
				}

				return result;
			},
		);

		const importId = await step.do(
			"create import",
			async () => {
				const result =
					await this.env.DB
						.prepare(`
							INSERT INTO imports (
								merchant_id,
								source_name,
								status
							)
							VALUES (?, ?, 'running')
							RETURNING id
						`)
						.bind(
							merchant.id,
							SOURCE_NAME,
						)
						.first<{ id: number }>();

				if (!result?.id) {
					throw new Error(
						"Import-Datensatz konnte nicht erstellt werden.",
					);
				}

				return result.id;
			},
		);

		try {
			const header = await step.do(
				"read CSV header",
				() =>
					readHeader(
						this.env,
						source,
					),
			);

			let offset = header.offset;
			let remainder = "";
			let chunkNumber = 0;

			while (
				offset < source.size ||
				remainder.length > 0
			) {
				const result = await step.do(
					`process Fressnapf chunk ${chunkNumber + 1}`,
					() =>
						processChunk(
							this.env,
							source,
							merchant.id,
							header.headers,
							offset,
							remainder,
							importId,
						),
				);

				if (
					result.nextOffset <= offset &&
					!result.done
				) {
					throw new Error(
						`Feed-Import macht keinen Fortschritt bei Offset ${offset}.`,
					);
				}

				offset = result.nextOffset;
				remainder = result.remainder;
				chunkNumber++;

				if (result.done) {
					break;
				}
			}

			await step.do(
				"complete import",
				async () => {
					await this.env.DB
						.prepare(`
							UPDATE imports
							SET
								status = 'completed',
								finished_at = CURRENT_TIMESTAMP,
								error_message = NULL
							WHERE
								id = ?
								AND status = 'running'
						`)
						.bind(importId)
						.run();
				},
			);

			return {
				success: true,
				importId,
				feed: source.key,
				chunks: chunkNumber,
			};
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);

			await this.env.DB.prepare(`
				UPDATE imports
				SET
					status = 'failed',
					finished_at = CURRENT_TIMESTAMP,
					error_message = ?
				WHERE
					id = ?
					AND status = 'running'
			`).bind(
				message,
				importId,
			).run();

			throw error;
		}
	}
}
