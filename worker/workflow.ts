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
		normalized =
			comma > dot
				? raw.replace(/\./g, "").replace(",", ".")
				: raw.replace(/,/g, "");
	} else if (comma >= 0) {
		normalized = raw.replace(/\./g, "").replace(",", ".");
	}

	const n = Number.parseFloat(normalized);

	return Number.isFinite(n)
		? Math.max(0, Math.round(n * 100))
		: 0;
}

function isAvailable(value: string | undefined): number {
	const v = normalize(value).toLowerCase();

	return [
		"0",
		"false",
		"no",
		"nein",
		"out of stock",
		"outofstock",
		"unavailable",
	].includes(v)
		? 0
		: 1;
}

function parseCsvRecord(record: string): string[] {
	const result: string[] = [];
	let current = "";
	let quoted = false;

	for (let i = 0; i < record.length; i++) {
		const c = record[i];

		if (c === '"') {
			if (quoted && record[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				quoted = !quoted;
			}
			continue;
		}

		if (c === "," && !quoted) {
			result.push(current);
			current = "";
			continue;
		}

		current += c;
	}

	result.push(current);
	return result;
}

function splitRecords(text: string): {
	records: string[];
	remainder: string;
} {
	const records: string[] = [];

	let start = 0;
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (c === '"') {
			if (quoted && text[i + 1] === '"') {
				i++;
			} else {
				quoted = !quoted;
			}
			continue;
		}

		if ((c === "\n" || c === "\r") && !quoted) {
			records.push(text.slice(start, i));

			if (c === "\r" && text[i + 1] === "\n") {
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

function getMpid(row: FeedRow): string {
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

function getUpdated(row: FeedRow): string | null {
	const value = normalize(row.last_updated);
	return value || null;
}

function canonicalKey(row: FeedRow): string {
	const ean = getEan(row);
	const mpid = getMpid(row);

	return ean
		? `ean:${ean}`
		: `merchant-product:${mpid}`;
}

function isDogProduct(row: FeedRow): boolean {
	const category = [
		row.merchant_category,
		row.merchant_product_category_path,
		row.category_name,
	].join(" ");

	const text = [
		row.product_short_description,
		row.product_name,
		row.description,
		row.product_type,
		row.keywords,
	].join(" ");

	if (
		/\b(katze|katzen|cat|feline|katzenfutter)\b/i.test(
			category,
		)
	) {
		return false;
	}

	if (
		/\b(hund|hunde|dog|canine)\b/i.test(category) ||
		/\b(hundefutter|hundesnack|hundesnacks|kauartikel|kausnack|kausnacks|leckerli|trockenfutter|nassfutter|barf)\b/i.test(
			text,
		)
	) {
		return true;
	}

	return false;
}

async function findFeed(
	env: Env,
): Promise<FeedSource> {
	const objects: R2Object[] = [];

	let cursor: string | undefined;

	do {
		const page = await env.FEED_BUCKET.list({
			prefix: FEED_PREFIX,
			limit: 1000,
			...(cursor ? { cursor } : {}),
		});

		objects.push(
			...page.objects.filter((o) =>
				o.key.toLowerCase().endsWith(".csv"),
			),
		);

		cursor = page.truncated
			? page.cursor
			: undefined;
	} while (cursor);

	objects.sort(
		(a, b) =>
			b.uploaded.getTime() -
			a.uploaded.getTime(),
	);

	const feed = objects[0];

	if (!feed) {
		throw new Error(
			"Kein Fressnapf-CSV-Feed gefunden.",
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
	const object = await env.FEED_BUCKET.get(
		source.key,
		{
			range: {
				offset: 0,
				length: CHUNK_SIZE,
			},
		},
	);

	if (!object) {
		throw new Error(
			"CSV-Header konnte nicht gelesen werden.",
		);
	}

	const bytes = new Uint8Array(
		await object.arrayBuffer(),
	);

	let quoted = false;
	let newline = -1;

	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 34) {
			if (quoted && bytes[i + 1] === 34) {
				i++;
			} else {
				quoted = !quoted;
			}
		} else if (
			bytes[i] === 10 &&
			!quoted
		) {
			newline = i;
			break;
		}
	}

	if (newline < 0) {
		throw new Error(
			"CSV-Header nicht gefunden.",
		);
	}

	let headerBytes = bytes.slice(0, newline);

	if (
		headerBytes.length > 0 &&
		headerBytes[headerBytes.length - 1] === 13
	) {
		headerBytes = headerBytes.slice(0, -1);
	}

	const header = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: false,
	}).decode(headerBytes);

	return {
		headers: parseCsvRecord(
			header.replace(/^\uFEFF/, ""),
		).map((v) => v.trim()),
		offset: newline + 1,
	};
}

function prepareRows(
	rows: FeedRow[],
): DbRow[] {
	const map = new Map<string, DbRow>();

	for (const row of rows) {
		const mpid = getMpid(row);

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
			updated: getUpdated(row),
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
): Promise<{
	nextOffset: number;
	remainder: string;
	found: number;
	imported: number;
	done: boolean;
}> {
	const object = await env.FEED_BUCKET.get(
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

	if (!object) {
		throw new Error(
			`Feed konnte bei Offset ${offset} nicht gelesen werden.`,
		);
	}

	const bytes = new Uint8Array(
		await object.arrayBuffer(),
	);

	if (!bytes.length) {
		throw new Error(
			`Leerer Feed-Chunk bei Offset ${offset}.`,
		);
	}

	let text = "";

	let decoded = false;

	for (let trim = 0; trim <= 3; trim++) {
		try {
			text = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: false,
			}).decode(
				bytes.slice(
					0,
					bytes.length - trim,
				),
			);

			decoded = true;
			break;
		} catch {
			// trailing UTF-8 bytes
		}
	}

	if (!decoded) {
		throw new Error(
			`UTF-8-Dekodierung bei Offset ${offset} fehlgeschlagen.`,
		);
	}

	const split = splitRecords(
		remainder + text,
	);

	const feedRows: FeedRow[] = [];

	for (const record of split.records) {
		if (!record.trim()) continue;

		const row = rowFromRecord(
			record,
			headers,
		);

		if (isDogProduct(row)) {
			feedRows.push(row);
		}
	}

	const rows = prepareRows(feedRows);

	if (rows.length > 0) {
		const json = JSON.stringify(rows);

		await env.DB.batch([
			env.DB.prepare(`
				INSERT INTO products (
					canonical_key,
					ean_gtin,
					brand,
					name,
					animal_type,
					category
				)
				SELECT
					json_extract(value, '$.key'),
					NULLIF(
						json_extract(value, '$.ean'),
						''
					),
					NULLIF(
						json_extract(value, '$.brand'),
						''
					),
					json_extract(value, '$.name'),
					'dog',
					NULLIF(
						json_extract(value, '$.category'),
						''
					)
				FROM json_each(?)
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
						CURRENT_TIMESTAMP
			`).bind(json),

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
				SELECT
					?,
					p.id,
					json_extract(j.value, '$.mpid'),
					NULLIF(
						json_extract(j.value, '$.ean'),
						''
					),
					json_extract(j.value, '$.name'),
					NULLIF(
						json_extract(j.value, '$.url'),
						''
					),
					NULLIF(
						json_extract(j.value, '$.affiliate'),
						''
					),
					NULLIF(
						json_extract(j.value, '$.image'),
						''
					),
					COALESCE(
						NULLIF(
							json_extract(
								j.value,
								'$.currency'
							),
							''
						),
						'EUR'
					)
				FROM json_each(?) j
				JOIN products p
					ON p.canonical_key =
						json_extract(
							j.value,
							'$.key'
						)
				ON CONFLICT (
					merchant_id,
					merchant_product_id
				)
				DO UPDATE SET
					product_id =
						excluded.product_id,
					ean_gtin =
						excluded.ean_gtin,
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
						CURRENT_TIMESTAMP
			`).bind(
				merchantId,
				json,
			),

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
					mp.id,
					CAST(
						json_extract(
							j.value,
							'$.price'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.shipping'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.total'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.available'
						) AS INTEGER
					),
					NULLIF(
						json_extract(
							j.value,
							'$.updated'
						),
						''
					)
				FROM json_each(?) j
				JOIN merchant_products mp
					ON
						mp.merchant_id = ?
						AND mp.merchant_product_id =
							json_extract(
								j.value,
								'$.mpid'
							)
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
				json,
				merchantId,
			),

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
					mp.id,
					CAST(
						json_extract(
							j.value,
							'$.price'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.shipping'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.total'
						) AS INTEGER
					),
					CAST(
						json_extract(
							j.value,
							'$.available'
						) AS INTEGER
					),
					CURRENT_TIMESTAMP
				FROM json_each(?) j
				JOIN merchant_products mp
					ON
						mp.merchant_id = ?
						AND mp.merchant_product_id =
							json_extract(
								j.value,
								'$.mpid'
							)
				WHERE NOT EXISTS (
					SELECT 1
					FROM price_history h
					WHERE
						h.merchant_product_id =
							mp.id
						AND h.price_cents =
							CAST(
								json_extract(
									j.value,
									'$.price'
								) AS INTEGER
							)
						AND h.shipping_cents =
							CAST(
								json_extract(
									j.value,
									'$.shipping'
								) AS INTEGER
							)
						AND h.total_price_cents =
							CAST(
								json_extract(
									j.value,
									'$.total'
								) AS INTEGER
							)
						AND h.available =
							CAST(
								json_extract(
									j.value,
									'$.available'
								) AS INTEGER
							)
						AND h.recorded_at >=
							datetime(
								'now',
								'-1 hour'
							)
				)
			`).bind(
				json,
				merchantId,
			),
		]);
	}

	const nextOffset = Math.min(
		source.size,
		offset + bytes.length,
	);

	return {
		nextOffset,
		remainder: split.remainder,
		found: feedRows.length,
		imported: rows.length,
		done:
			nextOffset >= source.size &&
			split.remainder.length === 0,
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
						"Fressnapf wurde nicht gefunden.",
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
						.first<{
							id: number;
						}>();

				if (!result?.id) {
					throw new Error(
						"Import konnte nicht erstellt werden.",
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
			let totalFound = 0;
			let totalImported = 0;
			let chunk = 0;

			while (
				offset < source.size ||
				remainder.length > 0
			) {
				const result = await step.do(
					`import chunk ${chunk + 1}`,
					() =>
						processChunk(
							this.env,
							source,
							merchant.id,
							header.headers,
							offset,
							remainder,
						),
				);

				if (
					result.nextOffset <= offset &&
					!result.done
				) {
					throw new Error(
						`Import-Fortschritt steht bei Offset ${offset}.`,
					);
				}

				offset = result.nextOffset;
				remainder = result.remainder;

				totalFound += result.found;
				totalImported += result.imported;

				chunk++;

				await step.do(
					`update import progress ${chunk}`,
					async () => {
						await this.env.DB
							.prepare(`
								UPDATE imports
								SET
									products_found = ?,
									products_imported = ?,
									products_matched = ?
								WHERE id = ?
									AND status = 'running'
							`)
							.bind(
								totalFound,
								totalImported,
								totalImported,
								importId,
							)
							.run();
					},
				);

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
								products_found = ?,
								products_imported = ?,
								products_matched = ?,
								finished_at =
									CURRENT_TIMESTAMP,
								error_message = NULL
							WHERE id = ?
						`)
						.bind(
							totalFound,
							totalImported,
							totalImported,
							importId,
						)
						.run();
				},
			);

			return {
				success: true,
				importId,
				chunks: chunk,
				productsFound: totalFound,
				productsImported: totalImported,
			};
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);

			await this.env.DB
				.prepare(`
					UPDATE imports
					SET
						status = 'failed',
						finished_at =
							CURRENT_TIMESTAMP,
						error_message = ?
					WHERE id = ?
				`)
				.bind(message, importId)
				.run();

			throw error;
		}
	}
}
